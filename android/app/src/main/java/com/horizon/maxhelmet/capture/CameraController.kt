package com.horizon.maxhelmet.capture

import android.content.Context
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.*
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.horizon.maxhelmet.actions.DeviceResult
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlin.coroutines.resume

/** CameraX owns only video inputs. Never call withAudioEnabled: the voice
 * session must retain the microphone, including for 'stop recording'. */
class CameraController(private val context: Context, val store: CaptureStore, private val scope: CoroutineScope) {
    private var owner: LifecycleOwner? = null
    private var provider: ProcessCameraProvider? = null
    private var boundCamera: androidx.camera.core.Camera? = null
    private var bindingGeneration = 0
    private var rotation = Surface.ROTATION_0
    private var photo: ImageCapture? = null
    private var video: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private var completion: CompletableDeferred<DeviceResult>? = null
    private var watchdog: Job? = null
    private val mutableRecording = MutableStateFlow(false)
    val isRecording = mutableRecording.asStateFlow()

    fun attach(lifecycleOwner: LifecycleOwner, displayRotation: Int = Surface.ROTATION_0) {
        owner = lifecycleOwner
        updateRotation(displayRotation)
    }
    fun updateRotation(displayRotation: Int) {
        rotation = displayRotation
        photo?.targetRotation = rotation
        video?.targetRotation = rotation
    }
    fun detach(lifecycleOwner: LifecycleOwner) {
        if (owner !== lifecycleOwner) return
        recording?.stop()
        unbind(); owner = null
    }
    fun stopForSession() { if (recording != null) recording?.stop() else unbind() }

    private fun unbind() { bindingGeneration++; provider?.unbindAll(); photo = null; video = null; boundCamera = null }

    suspend fun setTorch(on: Boolean): Boolean? {
        val camera = boundCamera ?: return null
        if (!camera.cameraInfo.hasFlashUnit()) return false
        val future = camera.cameraControl.enableTorch(on)
        return suspendCancellableCoroutine { continuation ->
            future.addListener({ if (continuation.isActive) continuation.resume(runCatching { future.get(); true }.getOrDefault(false)) }, ContextCompat.getMainExecutor(context))
        }
    }

    private suspend fun bind(): Boolean {
        val host = owner ?: return false
        if (!host.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return false
        if (photo != null && video != null) return true
        val future = ProcessCameraProvider.getInstance(context)
        val cameraProvider = suspendCancellableCoroutine<ProcessCameraProvider?> { continuation ->
            future.addListener({ if (continuation.isActive) continuation.resume(runCatching { future.get() }.getOrNull()) }, ContextCompat.getMainExecutor(context))
        } ?: return false
        if (host !== owner || !host.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return false
        return runCatching {
            val imageCapture = ImageCapture.Builder().setTargetRotation(rotation).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
            val videoCapture = VideoCapture.withOutput(Recorder.Builder().setQualitySelector(
                QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.HD))).build())
            videoCapture.targetRotation = rotation
            boundCamera = cameraProvider.bindToLifecycle(host, CameraSelector.DEFAULT_BACK_CAMERA, imageCapture, videoCapture)
            provider = cameraProvider; photo = imageCapture; video = videoCapture
            true
        }.getOrDefault(false)
    }

    suspend fun takePhoto(): DeviceResult {
        if (!store.hasSpace()) return DeviceResult.denied("storage.full")
        if (!bind()) return DeviceResult.failed("capture.failed")
        val file = store.newFile(false)
        val generation = bindingGeneration
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                scope.launch { if (generation == bindingGeneration && recording == null) unbind() }
            }
            photo!!.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context),
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                        if (!continuation.isActive) { file.delete(); return }
                        val saved = store.commit(file)
                        if (generation == bindingGeneration && recording == null) unbind()
                        if (continuation.isActive) continuation.resume(if (saved) DeviceResult.OK else DeviceResult.failed("capture.failed"))
                    }
                    override fun onError(exception: ImageCaptureException) {
                        file.delete()
                        if (generation == bindingGeneration && recording == null) unbind()
                        if (continuation.isActive) continuation.resume(DeviceResult.failed("capture.failed"))
                    }
                })
        }
    }

    suspend fun startRecording(): DeviceResult {
        if (recording != null) return DeviceResult.failed("camera.recording")
        if (!store.hasSpace()) return DeviceResult.denied("storage.full")
        if (!bind()) return DeviceResult.failed("capture.failed")
        val file = store.newFile(true)
        val started = CompletableDeferred<DeviceResult>()
        val finished = CompletableDeferred<DeviceResult>()
        completion = finished
        return try {
            recording = video!!.output.prepareRecording(context,
                FileOutputOptions.Builder(file).setDurationLimitMillis(600_000).setFileSizeLimit(1024L * 1024 * 1024).build())
                .start(ContextCompat.getMainExecutor(context)) { event ->
                    when (event) {
                        is VideoRecordEvent.Start -> { mutableRecording.value = true; started.complete(DeviceResult.OK) }
                        is VideoRecordEvent.Finalize -> {
                            recording?.close(); recording = null; watchdog?.cancel(); mutableRecording.value = false
                            unbind()
                            val finalized = finalizedVideoCanBeSaved(event.error, event.recordingStats.recordedDurationNanos, file.length())
                            val saved = finalized && store.commit(file)
                            if (!saved) file.delete()
                            store.refresh()
                            val result = if (saved) DeviceResult.OK else DeviceResult.failed("capture.failed")
                            started.complete(result); finished.complete(result)
                        }
                    }
                }
            watchdog = scope.launch {
                while (isActive) { delay(1000); if (!store.hasSpace()) { recording?.stop(); break } }
            }
            withTimeout(6000) { started.await() }
        } catch (error: Exception) {
            recording?.stop()
            if (recording == null) { unbind(); file.delete() }
            if (error is CancellationException && error !is TimeoutCancellationException) throw error
            DeviceResult.failed("capture.failed")
        }
    }

    suspend fun stopRecording(): DeviceResult {
        val active = recording ?: return DeviceResult.failed("camera.notRecording")
        val finished = completion ?: return DeviceResult.failed("capture.failed")
        active.stop()
        return withTimeoutOrNull(6000) { finished.await() } ?: DeviceResult.failed("capture.failed")
    }
}
