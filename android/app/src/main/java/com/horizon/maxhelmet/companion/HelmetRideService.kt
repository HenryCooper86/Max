package com.horizon.maxhelmet.companion

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
            client.fail("骑行定位需要精确位置权限"); stopSelf(); return START_NOT_STICKY
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("helmet_ride", "头盔骑行定位", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 31, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 32, Intent(this, HelmetRideService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "helmet_ride").setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Max 头盔骑行").setContentText("正在向已配对头盔共享位置").setContentIntent(open).setOngoing(true)
            .addAction(0, "停止共享", stop).build()
        try {
            ServiceCompat.startForeground(this, 3, notification, if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
            manager = getSystemService(LocationManager::class.java)
            if (manager?.isProviderEnabled(LocationManager.GPS_PROVIDER) != true) { client.fail("请开启系统定位后重试"); stopSelf() }
            else manager?.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper())
        } catch (_: Exception) { client.fail("无法启动骑行定位，请检查权限并在应用内重试"); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onLocationChanged(location: Location) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            CompanionHolder.get(this).fail("精确位置权限已撤销"); return
        }
        if (!location.hasAccuracy()) return
        CompanionHolder.get(this).sendFix(CompanionFix(location.latitude, location.longitude, location.accuracy.toDouble(), location.time,
            location.bearing.toDouble().takeIf { location.hasBearing() && it >= 0 && it < 360 },
            location.speed.toDouble().takeIf { location.hasSpeed() && it >= 0 }), SystemClock.elapsedRealtime(), System.currentTimeMillis())
    }
    override fun onProviderDisabled(provider: String) { if (provider == LocationManager.GPS_PROVIDER) CompanionHolder.get(this).fail("系统定位已关闭，请开启后重试") }
    override fun onDestroy() { manager?.removeUpdates(this); manager = null; super.onDestroy() }
}
