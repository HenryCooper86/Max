package io.github.henrycooper86.max.navigation

enum class MapAvailability { CONSENT_REQUIRED, MISSING_KEY, INVALID_ROUTE, READY }

fun mapAvailability(consent: Boolean, key: String, route: NavigationRoute?): MapAvailability = when {
    !consent -> MapAvailability.CONSENT_REQUIRED
    key.isBlank() -> MapAvailability.MISSING_KEY
    route == null || route.polyline.size < 2 ||
        (route.polyline + route.destination).any { !it.lat.isFinite() || !it.lon.isFinite() || it.lat !in -90.0..90.0 || it.lon !in -180.0..180.0 } -> MapAvailability.INVALID_ROUTE
    else -> MapAvailability.READY
}
