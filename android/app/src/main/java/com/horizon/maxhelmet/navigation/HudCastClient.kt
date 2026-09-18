package com.horizon.maxhelmet.navigation

import com.horizon.maxhelmet.BuildConfig
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** Local, foreground HUD prototype. Sends only the navigation controller's output. */
class HudCastClient {
    data class State(val active: Boolean = false, val status: String = "未投屏")
    private val mutableState = MutableStateFlow(State())
    val state = mutableState.asStateFlow()
    private val transport = OkHttpClient.Builder().connectTimeout(8, java.util.concurrent.TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var watchdog: Job? = null
    private var latest: NavGuidanceState? = null
    private var latestAt = 0L
    private var lastReply = 0L
    private var lastPing = 0L
    private var frameSentAt = 0L
    private var sequence = 0L
    private var ready = false
    private var awaitingAck = false
    private var pending = false
    private var generation = 0L

    @Synchronized fun update(guidance: NavGuidanceState?) {
        latest = guidance
        latestAt = System.nanoTime()
        if (guidance == null || guidance.confirmationId != null) { stop(); return }
        pending = true
        flush()
    }

    @Synchronized fun connect(address: String, code: String) {
        stop()
        if (!BuildConfig.DEBUG) { fail("Wi-Fi 投屏原型需要开发版本"); return }
        val endpoint = endpoint(address)
        if (endpoint == null || !code.matches(Regex("[0-9]{6}"))) {
            fail("请输入 RDK 屏幕上的地址和六位连接码"); return
        }
        if (latest == null || (System.nanoTime() - latestAt) > 8_000_000_000L) {
            fail("等待手机导航更新后重试"); return
        }
        val current = generation
        mutableState.value = State(true, "正在连接 HUD…")
        lastReply = System.nanoTime()
        lastPing = lastReply
        pending = true
        socket = transport.newWebSocket(Request.Builder().url(endpoint).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(this@HudCastClient) {
                if (generation != current) { webSocket.cancel(); return@synchronized }
                webSocket.send(JSONObject().put("type", "hud.join").put("code", code).toString())
                Unit
            }
            override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@HudCastClient) {
                if (generation != current) return@synchronized
                val reply = runCatching { JSONObject(text) }.getOrNull()
                lastReply = System.nanoTime()
                when {
                    reply?.optString("type") == "hud.ready" -> {
                        ready = true
                        mutableState.value = State(true, "已连接 · 正在发送导航")
                    }
                    reply?.optString("type") == "hud.ack" && reply.optLong("sequence") == sequence -> {
                        awaitingAck = false
                        mutableState.value = State(true, "正在投屏到 HUD")
                    }
                    reply?.optString("type") == "hud.pong" -> Unit // Liveness, not a fresh GPS fix.
                    else -> { fail("HUD 响应无效"); return@synchronized }
                }
                flush()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(this@HudCastClient) {
                if (generation == current) fail("HUD 已断开，请检查 Wi-Fi 和连接码后重试")
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = synchronized(this@HudCastClient) {
                webSocket.close(code, null)
                if (generation == current) fail("HUD 已断开，请重新连接")
            }
        })
        watchdog = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                delay(1000)
                synchronized(this@HudCastClient) {
                    if (generation == current) {
                        val now = System.nanoTime()
                        if (now - lastReply > 12_000_000_000L ||
                            (awaitingAck && now - frameSentAt > 12_000_000_000L)) {
                            fail("HUD 连接超时，请重新连接")
                        } else if (ready && now - lastPing >= 4_000_000_000L) {
                            lastPing = now
                            if (socket?.send("{\"type\":\"hud.ping\"}") != true) fail("HUD 已断开，请重新连接")
                        }
                    }
                }
            }
        }
    }

    @Synchronized fun stop() {
        generation++
        watchdog?.cancel(); watchdog = null
        socket?.cancel(); socket = null
        ready = false; awaitingAck = false; pending = false; sequence = 0
        mutableState.value = State()
    }
    private fun fail(message: String) { stop(); mutableState.value = State(status = message) }
    private fun flush() {
        if (!ready || awaitingAck || !pending || System.nanoTime() - latestAt >= 8_000_000_000L) return
        val guidance = latest ?: return
        val text = frame(guidance, ++sequence)
        if (text == null) { fail("当前导航数据暂时无法投屏"); return }
        frameSentAt = System.nanoTime()
        awaitingAck = true; pending = false
        if (socket?.send(text) != true) fail("HUD 已断开，请重新连接")
    }

    companion object {
        fun endpoint(address: String): String? {
            val raw = address.trim()
            // Require an explicit port to match the address displayed by the board.
            if (!raw.matches(Regex("[a-zA-Z0-9.\\-]+:[0-9]{1,5}"))) return null
            val url = ("http://$raw").toHttpUrlOrNull() ?: return null
            val parts = url.host.split('.').mapNotNull { it.toIntOrNull() }
            val privateIP = url.host.split('.').size == 4 && parts.size == 4 && parts.all { it in 0..255 } &&
                (parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && parts[1] in 16..31))
            if (!privateIP && !url.host.endsWith(".local")) return null
            return url.newBuilder().encodedPath("/cast/socket").build().toString()
        }
        fun frame(guidance: NavGuidanceState, sequence: Long): String? = runCatching {
            if (guidance.confirmationId != null) return null
            val source = guidance.route?.polyline ?: return null
            if (source.size < 2) return null
            val count = minOf(source.size, 2048)
            fun point(p: LatLon) = JSONObject().put("lat", p.lat).put("lon", p.lon)
            val points = JSONArray()
            for (index in 0 until count) points.put(point(source[index * (source.size - 1) / (count - 1)]))
            val turns = JSONArray()
            val route = guidance.route ?: return null
            for (step in route.steps.drop(guidance.maneuverIndex.coerceAtLeast(0)).take(3)) {
                turns.put(point(step.coordinate).put("instruction", step.instruction.take(500))
                    .put("distance", maxOf(0.0, step.alongRouteMeters - (route.distanceMeters - guidance.remainingMeters))))
            }
            JSONObject().put("type", "hud.frame").put("sequence", sequence)
                .put("destination", guidance.destinationName.take(200))
                .put("instruction", (guidance.currentInstruction ?: "沿路线前往目的地").take(500))
                .put("distance", guidance.distanceToManeuverMeters).put("remaining", guidance.remainingMeters)
                .put("seconds", guidance.remainingSeconds).put("offRoute", guidance.offRoute)
                .put("turns", turns).put("polyline", points).put("position", guidance.riderCoordinate?.let(::point) ?: JSONObject.NULL).toString()
        }.getOrNull()
    }
}
