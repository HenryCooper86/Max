package com.horizon.maxhelmet.music

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.Build
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.MainActivity
import com.horizon.maxhelmet.R
import com.horizon.maxhelmet.agent.AgentSessionHolder
import kotlinx.coroutines.*

/** Local songs keep playing when the screen locks, independently of the mic session. */
class MusicPlaybackService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val controller get() = AgentSessionHolder.get(this).music

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Max 音乐播放", NotificationManager.IMPORTANCE_LOW))
        // Foreground immediately, including while MediaPlayer prepares a cloud/local URI.
        ServiceCompat.startForeground(this, ID, notification(controller.state.value),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0)
        scope.launch { controller.state.collect { state ->
            if (controller.isLocalPlayback) getSystemService(NotificationManager::class.java).notify(ID, notification(state))
        } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.action?.let { controller.control(it) }
        return START_NOT_STICKY
    }

    private fun notification(state: MusicState): Notification {
        fun command(action: String, requestCode: Int) = PendingIntent.getService(this, requestCode,
            Intent(this, MusicPlaybackService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(state.title).setContentText(if (state.busy) "正在准备音乐" else "Max 音乐")
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            .setStyle(Notification.MediaStyle().setMediaSession(controller.mediaSession.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一首", command("previous", 1)).build())
            .addAction(Notification.Action.Builder(if (state.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (state.playing) "暂停" else "播放", command(if (state.playing) "pause" else "play", 2)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一首", command("next", 3)).build())
            .setOngoing(state.playing || state.busy).build()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object {
        private const val CHANNEL = "max_music"
        private const val ID = 2
        fun start(context: Context) { ContextCompat.startForegroundService(context, Intent(context, MusicPlaybackService::class.java)) }
        fun stop(context: Context) { context.stopService(Intent(context, MusicPlaybackService::class.java)) }
    }
}
