package com.horizon.maxhelmet.companion

import com.horizon.maxhelmet.ui.tr
import com.horizon.maxhelmet.ui.Str
import com.horizon.maxhelmet.ui.AssistantBranding

import android.Manifest
import android.annotation.SuppressLint
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.*
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.MainActivity
import com.horizon.maxhelmet.R
import kotlinx.coroutines.*

object CompanionHolder {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @Volatile private var instance: CompanionClient? = null
    fun get(context: Context): CompanionClient = instance ?: synchronized(this) {
        instance ?: CompanionClient(scope, { context.applicationContext.stopService(Intent(context, HelmetRideService::class.java)) }).also { instance = it }
    }
}

/** Explicit in-app start owns background location. Never resumes a ride after process death. */
class HelmetRideService : Service(), LocationListener {
    private var manager: LocationManager? = null
    override fun onBind(intent: Intent?): IBinder? = null
    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val client = CompanionHolder.get(this)
        if (intent?.action == "stop") { client.stopRide(); stopSelf(); return START_NOT_STICKY }
        if (!client.state.value.riding || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            client.fail(tr(Str.ERR_PRECISE_LOCATION)); stopSelf(); return START_NOT_STICKY
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("helmet_ride", tr(Str.NOTIF_RIDE_CHANNEL), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 31, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 32, Intent(this, HelmetRideService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "helmet_ride").setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(tr(Str.NOTIF_RIDE_TITLE, "name" to AssistantBranding.name)).setContentText(tr(Str.NOTIF_RIDE_TEXT)).setContentIntent(open).setOngoing(true)
            .addAction(0, tr(Str.NOTIF_RIDE_STOP), stop).build()
        try {
            ServiceCompat.startForeground(this, 3, notification, if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
            manager = getSystemService(LocationManager::class.java)
            if (manager?.isProviderEnabled(LocationManager.GPS_PROVIDER) != true) { client.fail(tr(Str.ERR_LOCATION_OFF)); stopSelf() }
            else manager?.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper())
        } catch (_: Exception) { client.fail(tr(Str.ERR_RIDE_TRACKING)); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onLocationChanged(location: Location) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            CompanionHolder.get(this).fail(tr(Str.ERR_PRECISE_REVOKED)); return
        }
        if (!location.hasAccuracy()) return
        CompanionHolder.get(this).sendFix(CompanionFix(location.latitude, location.longitude, location.accuracy.toDouble(), location.time,
            location.bearing.toDouble().takeIf { location.hasBearing() && it >= 0 && it < 360 },
            location.speed.toDouble().takeIf { location.hasSpeed() && it >= 0 }), SystemClock.elapsedRealtime(), System.currentTimeMillis())
    }
    override fun onProviderDisabled(provider: String) { if (provider == LocationManager.GPS_PROVIDER) CompanionHolder.get(this).fail(tr(Str.ERR_LOCATION_DISABLED)) }
    override fun onDestroy() { manager?.removeUpdates(this); manager = null; super.onDestroy() }
}
