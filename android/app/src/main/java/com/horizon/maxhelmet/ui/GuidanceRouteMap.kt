package com.horizon.maxhelmet.ui

import android.os.Bundle
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import com.horizon.maxhelmet.ui.theme.Visor
import com.horizon.maxhelmet.ui.theme.VisorShapes
import com.horizon.maxhelmet.ui.theme.VisorType
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
fun GuidanceRouteMap(guidance: NavGuidanceState, detailed: Boolean = false, followsRider: Boolean = false, viewportModifier: Modifier? = null) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("max_map", 0) }
    var consent by remember { mutableStateOf(prefs.getBoolean("consent_v1", false)) }
    var showConsent by remember { mutableStateOf(!prefs.contains("consent_v1")) }
    val uri = LocalUriHandler.current
    when (mapAvailability(consent, BuildConfig.AMAP_ANDROID_KEY, guidance.route)) {
        MapAvailability.CONSENT_REQUIRED -> {
            MapNote("地图未启用 · 语音导航仍可使用")
            VisorButton("启用地图", { showConsent = true })
        }
        MapAvailability.MISSING_KEY -> MapNote("地图暂不可用 · 缺少 Android 地图配置")
        MapAvailability.INVALID_ROUTE -> MapNote("地图暂不可用 · 路线数据不足")
        MapAvailability.READY -> NativeGuidanceMap(guidance, detailed, followsRider, viewportModifier)
    }
    if (showConsent) {
        VisorAlertDialog(
            onDismissRequest = { showConsent = false; prefs.edit().putBoolean("consent_v1", false).apply() },
            title = "高德地图与隐私",
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(com.horizon.maxhelmet.ui.theme.VisorSpace.x2)) {
                    DialogText("启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求。${AssistantBranding.name} 使用现有位置数据，不启用高德定位服务。")
                    VisorButton("查看高德地图隐私政策", { uri.openUri("https://lbs.amap.com/pages/privacy/") }, style = VisorButtonStyle.GHOST)
                }
            },
            confirmButton = { VisorButton("同意并启用", {
                prefs.edit().putBoolean("consent_v1", true).apply(); consent = true; showConsent = false
            }, style = VisorButtonStyle.PRIMARY) },
            dismissButton = { VisorButton("暂不启用", {
                prefs.edit().putBoolean("consent_v1", false).apply(); showConsent = false
            }, style = VisorButtonStyle.GHOST) }
        )
    }
}

@Composable
private fun NativeGuidanceMap(guidance: NavGuidanceState, detailed: Boolean, followsRider: Boolean, viewportModifier: Modifier?) {
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
    if (mapView == null) { MapNote("地图加载失败 · 语音导航仍可使用"); return }
    val accentArgb = Visor.colors.accent.toArgb()
    val renderer = remember(mapView, accentArgb) { RouteMapRenderer(mapView, accentArgb) }
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
    Box((viewportModifier ?: Modifier.fillMaxWidth().height(if (detailed) 360.dp else 200.dp)).clip(VisorShapes.card)) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize(), update = {
            runCatching { renderer.update(guidance, detailed, followsRider) }.onFailure { failed = true }
        })
        if (!loaded || failed) Surface(color = Visor.colors.surface2) {
            Text(
                if (failed) "地图加载失败 · 语音导航仍可使用" else "正在加载地图…",
                Modifier.padding(8.dp), color = Visor.colors.textSecondary, style = VisorType.caption
            )
        }
    }
    if (!detailed) VisorButton("查看完整路线", { renderer.fit() }, style = VisorButtonStyle.GHOST)
}

@Composable
private fun MapNote(text: String) = Text(text, color = Visor.colors.textSecondary, style = VisorType.caption)

private class RouteMapRenderer(private val view: MapView, private val routeColor: Int) {
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
                    .width(12f).color(routeColor))
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
