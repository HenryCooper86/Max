package io.github.henrycooper86.max.capture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import android.util.Base64
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import android.util.Size
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import io.github.henrycooper86.max.agent.VIDEO_MAX_SIDE
import io.github.henrycooper86.max.agent.encodeVideoFrame
import io.github.henrycooper86.max.agent.videoFrameSize
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** How often the camera's thread makes a frame to keep: the newest is what is sent, a second at most. */
private const val FRAME_EVERY_MS = 300L

/**
 * The camera behind live video: CameraX's image analysis, which hands frames
 * to a background thread. Each frame is made upright and at most 768 pixels on
 * its longer side before it is offered, so only small bitmaps are kept. It
 * binds its own use case only: CameraController's photo and recording are not
 * disturbed. Main thread, except the frames.
 */
class LiveVideoCamera(private val context: Context) {
    private var owner: LifecycleOwner? = null
    private var provider: ProcessCameraProvider? = null
    private var analysis: ImageAnalysis? = null
    private var executor: ExecutorService? = null
    private var generation = 0
    private var rotation = Surface.ROTATION_0

    fun attach(lifecycleOwner: LifecycleOwner, displayRotation: Int = Surface.ROTATION_0) {
        owner = lifecycleOwner
        updateRotation(displayRotation)
    }

    fun updateRotation(displayRotation: Int) {
        rotation = displayRotation
        analysis?.targetRotation = displayRotation
    }

    fun detach(lifecycleOwner: LifecycleOwner) {
        if (owner !== lifecycleOwner) return
        stop()
        owner = null
    }

    /**
     * Opens the front or the back camera and calls [onFrame] with each frame on
     * a background thread. [onFailed] (main thread) when it cannot be opened.
     */
    fun start(front: Boolean, onFrame: (Bitmap) -> Unit, onFailed: () -> Unit) {
        stop()
        val host = owner
        if (host == null || !host.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) { onFailed(); return }
        val mine = ++generation
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            // A newer start or a stop since then: this one is no longer wanted.
            if (mine != generation) return@addListener
            val cameraProvider = runCatching { future.get() }.getOrNull()
            val selector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
            if (cameraProvider == null || !cameraProvider.hasCamera(selector) ||
                !host.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            ) { onFailed(); return@addListener }
            val worker = Executors.newSingleThreadExecutor()
            var lastAt = 0L
            val useCase = ImageAnalysis.Builder()
                // Without this CameraX analyses at 640 × 480, where writing on a page cannot be read.
                .setResolutionSelector(
                    ResolutionSelector.Builder().setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)
                    ).build()
                )
                .setTargetRotation(rotation)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build()
            useCase.setAnalyzer(worker) { image ->
                val now = SystemClock.elapsedRealtime()
                try {
                    if (now - lastAt >= FRAME_EVERY_MS) {
                        lastAt = now
                        uprightFrame(image)?.let(onFrame)
                    }
                } finally {
                    image.close()
                }
            }
            val bound = runCatching { cameraProvider.bindToLifecycle(host, selector, useCase) }.isSuccess
            if (!bound) { worker.shutdownNow(); onFailed(); return@addListener }
            provider = cameraProvider; analysis = useCase; executor = worker
        }, ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        generation++
        analysis?.let { runCatching { provider?.unbind(it) } }
        analysis = null
        executor?.shutdown()
        executor = null
    }
}

/** The frame turned upright from the sensor's orientation, scaled to 768 pixels on its longer side. Null if it cannot be read. */
private fun uprightFrame(image: ImageProxy): Bitmap? = runCatching {
    val source = image.toBitmap()
    val turns = image.imageInfo.rotationDegrees
    val upright = if (turns % 180 == 0) source.width to source.height else source.height to source.width
    val (width, height) = videoFrameSize(upright.first, upright.second, VIDEO_MAX_SIDE) ?: return null
    val scale = width.toFloat() / upright.first
    val matrix = Matrix().apply { postRotate(turns.toFloat()); postScale(scale, scale) }
    val frame = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    if (frame !== source) source.recycle()
    frame
}.getOrNull()

/** A frame as the base64 JPEG video.frame carries, at quality 60 and then 45. Not for the main thread. */
fun encodeVideoBitmap(frame: Bitmap): String? = runCatching {
    encodeVideoFrame { quality ->
        val bytes = ByteArrayOutputStream()
        frame.compress(Bitmap.CompressFormat.JPEG, quality, bytes)
        Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
    }
}.getOrNull()
