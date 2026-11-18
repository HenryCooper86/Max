package io.github.henrycooper86.max.ui

import android.os.Bundle
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.amap.api.maps.*
import com.amap.api.maps.model.*
import io.github.henrycooper86.max.BuildConfig
import io.github.henrycooper86.max.navigation.*
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
            MapNote(tr(Str.MAP_OFF))
            VisorButton(tr(Str.ENABLE_MAP), { showConsent = true })
        }
        MapAvailability.MISSING_KEY -> MapNote(tr(Str.MAP_NO_KEY))
        MapAvailability.INVALID_ROUTE -> MapNote(tr(Str.MAP_BAD_ROUTE))
        MapAvailability.READY -> NativeGuidanceMap(guidance, detailed, followsRider, viewportModifier)
    }
    if (showConsent) {
        VisorAlertDialog(
            onDismissRequest = { showConsent = false; prefs.edit().putBoolean("consent_v1", false).apply() },
            title = tr(Str.AMAP_TITLE),
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(io.github.henrycooper86.max.ui.theme.VisorSpace.x2)) {
                    DialogText(tr(Str.AMAP_BODY, "name" to AssistantBranding.name))
                    VisorButton(tr(Str.AMAP_POLICY), { uri.openUri("https://lbs.amap.com/pages/privacy/") }, style = VisorButtonStyle.GHOST)
                }
            },
            confirmButton = { VisorButton(tr(Str.AGREE_ENABLE), {
                prefs.edit().putBoolean("consent_v1", true).apply(); consent = true; showConsent = false
            }, style = VisorButtonStyle.PRIMARY) },
            dismissButton = { VisorButton(tr(Str.NOT_NOW), {
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
    if (mapView == null) { MapNote(tr(Str.MAP_FAILED)); return }
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
                if (failed) tr(Str.MAP_FAILED) else tr(Str.MAP_LOADING),
                Modifier.padding(8.dp), color = Visor.colors.textSecondary, style = VisorType.caption
            )
        }
    }
    if (!detailed) VisorButton(tr(Str.VIEW_FULL_ROUTE), { renderer.fit() }, style = VisorButtonStyle.GHOST)
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
            if (turn == null) turn = map.addMarker(MarkerOptions().position(position).title(next.spoken)
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_ORANGE)))
            else { turn?.position = position; turn?.title = next.spoken }
        } else { turn?.remove(); turn = null }
        if (modeChanged && !following) fit()
        state.riderCoordinate?.let { fix ->
            val position = LatLng(fix.lat, fix.lon)
            if (rider == null) rider = map.addMarker(MarkerOptions().position(position).title(tr(Str.MAP_YOU))
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
