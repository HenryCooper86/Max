package io.github.henrycooper86.max.service

import io.github.henrycooper86.max.ui.tr
import io.github.henrycooper86.max.ui.Str
import io.github.henrycooper86.max.ui.AssistantBranding

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.henrycooper86.max.MainActivity
import io.github.henrycooper86.max.R
import io.github.henrycooper86.max.agent.AgentSessionHolder
import io.github.henrycooper86.max.crash.CrashPhase
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

/**
 * Foreground service that pins the process — and microphone access — while a
 * hands-free session is active, so Max keeps working with the screen off or the
 * phone in a pocket. The session logic itself lives in AgentSession; this
 * service only holds the foreground notification and microphone service type.
 */
class VoiceAgentService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)


    companion object {
        private const val CHANNEL_ID = "voice_session"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, VoiceAgentService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceAgentService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("crash_alert", tr(Str.NOTIF_CRASH_CHANNEL), NotificationManager.IMPORTANCE_HIGH))
        serviceScope.launch {
            AgentSessionHolder.get(this@VoiceAgentService).crash.ui.collectLatest { state ->
                if (state.phase !in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)) { manager.cancel(4); return@collectLatest }
                val open = PendingIntent.getActivity(this@VoiceAgentService, 40, Intent(this@VoiceAgentService, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                val cancel = PendingIntent.getService(this@VoiceAgentService, 41, Intent(this@VoiceAgentService, VoiceAgentService::class.java).setAction("crash.cancel"), PendingIntent.FLAG_IMMUTABLE)
                val notification = NotificationCompat.Builder(this@VoiceAgentService, "crash_alert")
                    .setSmallIcon(R.drawable.ic_stat_voice).setContentTitle(tr(Str.NOTIF_CRASH_TITLE))
                    .setContentText(state.message ?: tr(Str.NOTIF_CRASH_TEXT, "n" to state.remaining))
                    .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_ALARM)
                    .addAction(0, tr(Str.NOTIF_CRASH_CANCEL), cancel).build()
                runCatching { manager.notify(4, notification) }
            }
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                tr(Str.NOTIF_CHANNEL),
                NotificationManager.IMPORTANCE_LOW
            )
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "crash.cancel") {
            val session = AgentSessionHolder.get(this)
            session.crash.controller.cancel()
            if (!session.state.value.handsFree && !session.crash.controller.active) stopSelf()
            return START_NOT_STICKY
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(tr(Str.NOTIF_TITLE, "name" to io.github.henrycooper86.max.ui.AssistantBranding.name))
            .setContentText(tr(Str.NOTIF_TEXT))
            .setSmallIcon(R.drawable.ic_stat_voice)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()

        // Android 10 accepts service-type flags, but the microphone type starts at Android 11.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        )
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        serviceScope.cancel()
        getSystemService(NotificationManager::class.java).cancel(4)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
