package io.github.henrycooper86.max.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import io.github.henrycooper86.max.agent.DEFAULT_IMAGE_MAX_SIDE
import io.github.henrycooper86.max.agent.encodeImageForInput
import java.io.ByteArrayOutputStream

/**
 * Opens a picture the user chose and makes the JPEG that image.input carries:
 * turned the way the camera held it, scaled down, small enough for the relay.
 * Null when it cannot be read as a picture or cannot be made to fit. Not for
 * the main thread.
 */
fun encodePictureForInput(resolver: ContentResolver, uri: Uri): String? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    // Read at a fraction of the size when the photo is far larger than what is sent: a 50-megapixel photo
    // would not fit in memory whole.
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= DEFAULT_IMAGE_MAX_SIDE) sample *= 2
    val read = BitmapFactory.Options().apply { inSampleSize = sample }
    val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, read) } ?: return null
    val upright = upright(decoded, orientationOf(resolver, uri))
    try {
        encodeImageForInput(upright.width, upright.height) { width, height, quality ->
            // JPEG has no transparency: what is see-through in a screenshot or a sticker is white, not black.
            val scaled = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(scaled)
                canvas.drawColor(Color.WHITE)
                canvas.drawBitmap(upright, null, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG))
                val bytes = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, quality, bytes)
                Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
            } finally {
                scaled.recycle()
            }
        }
    } finally {
        upright.recycle()
    }
}.getOrNull()

/** How the camera was held, from the photo's EXIF data. A picture without it is upright. */
private fun orientationOf(resolver: ContentResolver, uri: Uri): Int = runCatching {
    resolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }
}.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL

private fun upright(bitmap: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
        else -> return bitmap
    }
    val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (turned !== bitmap) bitmap.recycle()
    return turned
}
