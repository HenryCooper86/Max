package com.horizon.maxhelmet.ui

import android.os.Bundle
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.amap.api.maps.*
import com.amap.api.maps.model.*
import com.horizon.maxhelmet.BuildConfig
import com.horizon.maxhelmet.navigation.*
import kotlinx.coroutines.delay

/** No AMap API, including privacy initialization, runs before the rider opts in. */
@Composable
fun GuidanceRouteMap(guidance: NavGuidanceState, detailed: Boolean = false, followsRider: Boolean = false) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("max_map", 0) }
    var consent by remember { mutableStateOf(prefs.getBoolean("consent_v1", false)) }
    var showConsent by remember { mutableStateOf(!prefs.contains("consent_v1")) }
    val uri = LocalUriHandler.current
    when (mapAvailability(consent, BuildConfig.AMAP_ANDROID_KEY, guidance.route)) {
        MapAvailability.CONSENT_REQUIRED -> {
            Text("地图未启用 · 语音导航仍可使用")
            TextButton(onClick = { showConsent = true }) { Text("启用地图") }
        }
        MapAvailability.MISSING_KEY -> Text("地图暂不可用 · 缺少 Android 地图配置")
        MapAvailability.INVALID_ROUTE -> Text("地图暂不可用 · 路线数据不足")
        MapAvailability.READY -> NativeGuidanceMap(guidance, detailed, followsRider)
    }
    if (showConsent) {
        AlertDialog(
            onDismissRequest = { showConsent = false; prefs.edit().putBoolean("consent_v1", false).apply() },
            title = { Text("高德地图与隐私") },
            text = {
                Column {
                    Text("启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求。Max 使用现有位置数据，不启用高德定位服务。")
                    TextButton(onClick = { uri.openUri("https://lbs.amap.com/pages/privacy/") }) { Text("查看高德地图隐私政策") }
                }
            },
            confirmButton = { TextButton(onClick = {
                prefs.edit().putBoolean("consent_v1", true).apply(); consent = true; showConsent = false
            }) { Text("同意并启用") } },
            dismissButton = { TextButton(onClick = {
                prefs.edit().putBoolean("consent_v1", false).apply(); showConsent = false
            }) { Text("暂不启用") } }
        )
    }
}

@Composable
private fun NativeGuidanceMap(guidance: NavGuidanceState, detailed: Boolean, followsRider: Boolean) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var loaded by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val mapView = remember {
        runCatching {
            MapsInitializer.updatePrivacyShow(context, true, true)
            MapsInitializer.updatePrivacyAgree(context, true)
            MapsInitializer.setApiKey(BuildConfig.AMAP_ANDROID_KEY)
            MapView(context).apply { onCreate(Bundle()) }
        }.getOrNull()
    }
    if (mapView == null) { Text("地图加载失败 · 语音导航仍可使用"); return }
    val renderer = remember(mapView) { RouteMapRenderer(mapView) }
    DisposableEffect(mapView, lifecycle) {
        mapView.map.setOnMapLoadedListener { loaded = true; failed = false; renderer.fit() }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) mapView.onResume()
        onDispose {
            renderer.dispose()
            lifecycle.removeObserver(observer)
            mapView.map.setOnMapLoadedListener(null)
            mapView.onPause()
            mapView.onDestroy()
        }
    }
    LaunchedEffect(mapView) { delay(15_000); if (!loaded) failed = true }
    Box(Modifier.fillMaxWidth().height(if (detailed) 360.dp else 200.dp)) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize(), update = {
            runCatching { renderer.update(guidance, detailed, followsRider) }.onFailure { failed = true }
        })
        if (!loaded || failed) Surface {
            Text(if (failed) "地图加载失败 · 语音导航仍可使用" else "正在加载地图…", Modifier.padding(8.dp))
        }
    }
    if (!detailed) TextButton(onClick = { renderer.fit() }) { Text("查看完整路线") }
}

private class RouteMapRenderer(private val view: MapView) {
    private var active = true
    private var route: NavigationRoute? = null
    private var rider: Marker? = null
    private var turn: Marker? = null
    private var following = false
    private var lastRider: LatLon? = null
    private val map get() = view.map
    init { map.uiSettings.isZoomControlsEnabled = false; map.isMyLocationEnabled = false }

    fun update(state: NavGuidanceState, detailed: Boolean, followsRider: Boolean) {
        val modeChanged = following != followsRider
        following = followsRider
        map.uiSettings.isZoomControlsEnabled = detailed
        map.uiSettings.isScaleControlsEnabled = detailed
        if (!active) return
        if (state.route != route) {
            route = state.route
            map.clear(); rider = null; turn = null; lastRider = null
            route?.let { current ->
                map.addPolyline(PolylineOptions().addAll(current.polyline.map { LatLng(it.lat, it.lon) })
                    .width(12f).color(android.graphics.Color.rgb(165, 224, 124)))
                map.addMarker(MarkerOptions().position(LatLng(current.destination.lat, current.destination.lon)).title(current.destinationName))
            }
            view.post { fit() }
        }
        val next = state.route?.steps?.getOrNull(state.maneuverIndex)
        if (next != null) {
            val position = LatLng(next.coordinate.lat, next.coordinate.lon)
            if (turn == null) turn = map.addMarker(MarkerOptions().position(position).title(next.instruction)
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_ORANGE)))
            else { turn?.position = position; turn?.title = next.instruction }
        } else { turn?.remove(); turn = null }
        if (modeChanged && !following) fit()
        state.riderCoordinate?.let { fix ->
            val position = LatLng(fix.lat, fix.lon)
            if (rider == null) rider = map.addMarker(MarkerOptions().position(position).title("当前位置")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_AZURE)))
            else rider?.position = position
            if (following && (modeChanged || fix != lastRider)) map.moveCamera(CameraUpdateFactory.newLatLngZoom(position, 17f))
            lastRider = fix
        }
    }

    fun fit() {
        if (!active) return
        val current = route ?: return
        if (following && lastRider != null) {
            val fix = lastRider!!
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(fix.lat, fix.lon), 17f))
            return
        }
        if (view.width <= 0 || view.height <= 0) return
        val bounds = LatLngBounds.Builder()
        current.polyline.forEach { bounds.include(LatLng(it.lat, it.lon)) }
        bounds.include(LatLng(current.destination.lat, current.destination.lon))
        runCatching { map.moveCamera(CameraUpdateFactory.newLatLngBounds(bounds.build(), view.width, view.height, 36)) }
    }
    fun dispose() { active = false }
}
