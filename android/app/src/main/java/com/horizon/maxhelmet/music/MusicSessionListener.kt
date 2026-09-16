package com.horizon.maxhelmet.music

import android.service.notification.NotificationListenerService

/** Intentionally never consumes notification contents. Access is used solely
 * with MediaSessionManager to expose the rider's active music controls. */
class MusicSessionListener : NotificationListenerService()
