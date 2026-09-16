package com.horizon.maxhelmet.actions

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.provider.ContactsContract
import com.horizon.maxhelmet.agent.AgentEvent
import com.horizon.maxhelmet.agent.PcmPlayer
import com.horizon.maxhelmet.capture.CameraController
import com.horizon.maxhelmet.music.MusicController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

interface DeviceActivityHost {
    suspend fun requestPermission(permission: String): Boolean
    fun launch(intent: Intent): Boolean
}

class DeviceActions(
    private val context: Context,
    private val player: PcmPlayer,
    val music: MusicController,
    val camera: CameraController,
    private val speed: () -> Double?
) {
    var host: DeviceActivityHost? = null
    private val mutex = Mutex()
    private val mutableGalleryRequest = MutableStateFlow(0)
    val galleryRequest = mutableGalleryRequest.asStateFlow()

    suspend fun execute(command: AgentEvent.DeviceCommand, isCurrent: () -> Boolean, send: (String) -> Boolean): DeviceResult {
        // Music stop must not queue behind a song that is still preparing or
        // a camera/contact operation waiting for a result.
        if (command.action == "music.control") {
            if (host == null || (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked)
                return DeviceResult.failed("device.locked")
            if (!isCurrent()) return DeviceResult.failed("action.cancelled")
            if (!validDeviceArguments(command.action, command.args)) return DeviceResult.unsupported("action.invalid")
            return music.execute(command.args["control"] as String, command.args["app"] as? String)
        }
        return mutex.withLock {
            val host = host ?: return@withLock DeviceResult.failed("device.locked")
            if (!isCurrent()) return@withLock DeviceResult.failed("action.cancelled")
            if ((context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) return@withLock DeviceResult.failed("device.locked")
            if (!validDeviceArguments(command.action, command.args)) return@withLock DeviceResult.unsupported("action.invalid")
            val args = command.args
            suspend fun permission(name: String): Boolean = host.requestPermission(name) && isCurrent() && this.host === host
            try {
                when (command.action) {
                    "volume.set" -> { player.level = nextVoiceGain(player.level, args["direction"] as String); DeviceResult.OK }
                    "torch.set" -> {
                        if (!permission(Manifest.permission.CAMERA)) return@withLock DeviceResult.denied("permission.camera")
                        camera.setTorch(args["on"] as Boolean)?.let { enabled ->
                            return@withLock if (enabled) DeviceResult.OK else DeviceResult.failed("torch.unavailable")
                        }
                        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                        val id = manager.cameraIdList.firstOrNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
                            ?: return@withLock DeviceResult.unsupported("torch.unavailable")
                        manager.setTorchMode(id, args["on"] as Boolean)
                        DeviceResult.OK
                    }
                    "call.dial", "sms.compose" -> {
                        if (command.action == "sms.compose" && !safeToComposeMessage(speed())) return@withLock DeviceResult.denied("unsafe.speed")
                        val raw = args["number"] as? String ?: args["name"] as String
                        val number = if (isDialableNumber(raw)) raw else {
                            if (!permission(Manifest.permission.READ_CONTACTS)) return@withLock DeviceResult.denied("permission.contacts")
                            withContext(Dispatchers.IO) { resolveContact(raw) } ?: return@withLock DeviceResult.failed("contact.notFound")
                        }
                        if (!isCurrent() || this.host !== host) return@withLock DeviceResult.failed("action.cancelled")
                        if (command.action == "sms.compose" && !safeToComposeMessage(speed())) return@withLock DeviceResult.denied("unsafe.speed")
                        val intent = if (command.action == "call.dial") Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
                        else Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", number, null)).putExtra("sms_body", args["body"] as String)
                        if (host.launch(intent)) DeviceResult.OK else DeviceResult.failed(if (command.action == "call.dial") "dial.unavailable" else "sms.unavailable")
                    }
                    "camera.photo", "camera.record" -> {
                        if (!permission(Manifest.permission.CAMERA)) return@withLock DeviceResult.denied("permission.camera")
                        when {
                            command.action == "camera.photo" -> camera.takePhoto()
                            args["start"] == true -> camera.startRecording()
                            else -> camera.stopRecording()
                        }
                    }
                    "gallery.open" -> { mutableGalleryRequest.value++; DeviceResult.OK }
                    "gallery.describe" -> {
                        val frames = camera.store.frames(args["kind"] as? String ?: "latest") ?: return@withLock DeviceResult.failed("gallery.empty")
                        if (frames.isEmpty()) return@withLock DeviceResult.failed("gallery.unreadable")
                        frames.forEachIndexed { index, image ->
                            if (!isCurrent()) return@withLock DeviceResult.failed("action.cancelled")
                            val payload = buildVisionFrame(command.commandId, index, frames.size, image, args["question"] as? String)
                            if (!send(payload)) return@withLock DeviceResult.failed("gallery.uploadFailed")
                        }
                        DeviceResult.OK
                    }
                    else -> DeviceResult.unsupported("handler.missing")
                }
            } catch (error: CancellationException) { throw error }
            catch (_: SecurityException) { DeviceResult.denied("permission.device") }
            catch (_: Exception) { DeviceResult.failed("device.unavailable") }
        }
    }

    private fun resolveContact(name: String): String? {
        val uri = Uri.withAppendedPath(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI, Uri.encode(name))
        return context.contentResolver.query(uri,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME), null, null, null)?.use { cursor ->
            val numbers = mutableSetOf<String>()
            while (cursor.moveToNext()) {
                if (cursor.getString(1).equals(name.trim(), ignoreCase = true)) numbers += cursor.getString(0)
            }
            // Never pick an arbitrary number when a contact has several matches.
            numbers.singleOrNull()
        }
    }
}

fun isDialableNumber(value: String): Boolean = value.isNotBlank() && value.any { it.isDigit() } &&
    value.all { it.isDigit() || it in "+- ()" }

fun buildVisionFrame(commandId: String, index: Int, total: Int, image: String, question: String?): String = JSONObject().apply {
    put("type", "vision.frames"); put("commandId", commandId); put("reason", "gallery")
    put("index", index); put("total", total); put("image", image)
    if (!question.isNullOrBlank()) put("question", question)
}.toString()
