package com.horizon.maxhelmet.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.MainActivity
import com.horizon.maxhelmet.R
import com.horizon.maxhelmet.agent.AgentSessionHolder
import com.horizon.maxhelmet.crash.CrashPhase
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
        manager.createNotificationChannel(NotificationChannel("crash_alert", "摔车检查与求助", NotificationManager.IMPORTANCE_HIGH))
        serviceScope.launch {
            AgentSessionHolder.get(this@VoiceAgentService).crash.ui.collectLatest { state ->
                if (state.phase !in setOf(CrashPhase.CHECK_IN, CrashPhase.ALARM, CrashPhase.ESCALATED)) { manager.cancel(4); return@collectLatest }
                val open = PendingIntent.getActivity(this@VoiceAgentService, 40, Intent(this@VoiceAgentService, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                val cancel = PendingIntent.getService(this@VoiceAgentService, 41, Intent(this@VoiceAgentService, VoiceAgentService::class.java).setAction("crash.cancel"), PendingIntent.FLAG_IMMUTABLE)
                val notification = NotificationCompat.Builder(this@VoiceAgentService, "crash_alert")
                    .setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle("疑似摔车 · 你还好吗？")
                    .setContentText(state.message ?: "${state.remaining} 秒 · 点击查看或取消报警")
                    .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_ALARM)
                    .addAction(0, "我没事 · 取消", cancel).build()
                runCatching { manager.notify(4, notification) }
            }
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
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
            .setContentTitle(getString(R.string.notification_title, com.horizon.maxhelmet.ui.AssistantBranding.name))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()

        // ServiceCompat ignores the type on API levels that don't support it.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
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
