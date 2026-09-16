package com.horizon.maxhelmet.capture

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

data class Capture(val file: File, val video: Boolean, val exported: Boolean) {
    val id: String get() = file.name
}

class CaptureStore(private val context: Context) {
    private val directory = File(context.filesDir, "captures").apply { mkdirs() }
    private val staging = File(context.cacheDir, "capture-staging").apply { mkdirs() }
    private val prefs = context.getSharedPreferences("max_captures", 0)
    private val mutableCaptures = MutableStateFlow<List<Capture>>(emptyList())
    val captures = mutableCaptures.asStateFlow()
    init { refresh() }
    fun hasSpace() = directory.usableSpace >= 100L * 1024 * 1024
    fun newFile(video: Boolean) = File(staging, "${System.currentTimeMillis()}-${UUID.randomUUID()}.${if (video) "mp4" else "jpg"}")
    fun commit(file: File): Boolean {
        if (file.length() == 0L) { file.delete(); return false }
        val saved = file.renameTo(File(directory, file.name))
        if (saved) refresh()
        return saved
    }
    fun refresh() {
        val exported = prefs.getStringSet("exported", emptySet()).orEmpty()
        mutableCaptures.value = directory.listFiles().orEmpty()
            .filter { it.extension in setOf("jpg", "mp4") && it.length() > 0 }
            .sortedByDescending { it.name }
            .map { Capture(it, it.extension == "mp4", it.name in exported) }
    }
    fun delete(capture: Capture): Boolean {
        val deleted = capture.file.delete()
        if (deleted) {
            prefs.edit().putStringSet("exported", prefs.getStringSet("exported", emptySet()).orEmpty() - capture.id).apply()
            refresh()
        }
        return deleted
    }

    suspend fun export(capture: Capture): Boolean = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < 29) return@withContext false // UI offers the system share/save flow on older Android.
        if (capture.id in prefs.getStringSet("exported", emptySet()).orEmpty()) return@withContext true
        val collection = if (capture.video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, capture.id)
            put(MediaStore.MediaColumns.MIME_TYPE, if (capture.video) "video/mp4" else "image/jpeg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (capture.video) "Movies/Max" else "Pictures/Max")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: return@withContext false
        runCatching {
            resolver.openOutputStream(uri)?.use { out -> capture.file.inputStream().use { it.copyTo(out) } } ?: error("No output")
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            synchronized(this@CaptureStore) {
                prefs.edit().putStringSet("exported", prefs.getStringSet("exported", emptySet()).orEmpty() + capture.id).apply()
            }
            refresh()
            true
        }.getOrElse { resolver.delete(uri, null, null); false }
    }

    suspend fun frames(kind: String): List<String>? = withContext(Dispatchers.IO) {
        val target = captures.value.firstOrNull { kind == "latest" || (kind == "video") == it.video } ?: return@withContext null
        runCatching {
            if (!target.video) listOf(encode(photoThumbnail(target.file) ?: error("Unreadable image")))
            else withVideoReader { reader ->
                reader.setDataSource(target.file.absolutePath)
                val duration = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
                (0 until 8).mapNotNull { index ->
                    videoThumbnail(reader, duration * 1000 * index / 8)?.let(::encode)
                }.takeIf { it.isNotEmpty() } ?: error("Unreadable video")
            }
        }.getOrDefault(emptyList())
    }

    private fun encode(bitmap: Bitmap): String {
        val image = scale(bitmap)
        val bytes = ByteArrayOutputStream().use { stream -> image.compress(Bitmap.CompressFormat.JPEG, 75, stream); stream.toByteArray() }
        if (image !== bitmap) image.recycle()
        bitmap.recycle()
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    companion object {
        fun <T> withVideoReader(block: (MediaMetadataRetriever) -> T): T {
            val reader = MediaMetadataRetriever()
            return try { block(reader) } finally { reader.release() }
        }
        fun videoThumbnail(reader: MediaMetadataRetriever, timeUs: Long = 0): Bitmap? =
            if (Build.VERSION.SDK_INT >= 27) reader.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 512, 512)
            else reader.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { original ->
                scale(original).also { if (it !== original) original.recycle() }
            }
        fun photoThumbnail(file: File): Bitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1024) sample *= 2
            val bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val exif = runCatching { ExifInterface(file) }.getOrNull() ?: return bitmap
            val matrix = Matrix().apply {
                postRotate(exif.rotationDegrees.toFloat())
                if (exif.isFlipped) postScale(-1f, 1f)
            }
            if (matrix.isIdentity) return bitmap
            return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { if (it !== bitmap) bitmap.recycle() }
        }
        fun scale(bitmap: Bitmap): Bitmap {
            val ratio = minOf(1.0, 512.0 / maxOf(bitmap.width, bitmap.height))
            return if (ratio == 1.0) bitmap else Bitmap.createScaledBitmap(bitmap,
                (bitmap.width * ratio).toInt().coerceAtLeast(1), (bitmap.height * ratio).toInt().coerceAtLeast(1), true)
        }
    }
}
