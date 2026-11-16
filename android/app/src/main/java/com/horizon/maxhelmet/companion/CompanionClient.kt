package com.horizon.maxhelmet.companion

import com.horizon.maxhelmet.ui.tr
import com.horizon.maxhelmet.ui.Str

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.*
import java.util.concurrent.TimeUnit

/** Dedicated account-only transport. Every callback is dispatched and generation-checked on main. */
class CompanionClient(private val scope: CoroutineScope, private val stopped: () -> Unit,
    private val client: WebSocket.Factory = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()) {
    private val mutableState = MutableStateFlow(CompanionState())
    val state = mutableState.asStateFlow()
    private var factory = client
    private var socket: WebSocket? = null
    private var generation = 0L
    private var endpoint: String? = null
    private var desiredRide = false
    private var ready = false
    private var startSent = false
    private var action: String? = null
    private var binding = false
    private var awaitingAttach = false
    private var timeout: Job? = null
    private var retry: Job? = null
    private var attempts = 0
    private var gate = CompanionFixGate()

    fun connect(relay: String, token: String, initialAction: String? = null, ride: Boolean = false, transport: WebSocket.Factory? = null) {
        disconnect()
        val url = CompanionProtocol.endpoint(relay, token) ?: run { fail(tr(Str.COMP_SIGN_IN)); return }
        factory = transport ?: client
        endpoint = url; action = initialAction; desiredRide = ride; binding = initialAction?.contains("companion.pair") == true
        gate = CompanionFixGate(); attempts = 0
        open()
    }
    fun stopRide() {
        desiredRide = false; ready = false; stopped()
        socket?.send(CompanionProtocol.action("stop"))
        disconnect(preserveStatus = true)
        mutableState.value = mutableState.value.copy(status = if (mutableState.value.device != null) "paired" else "unpaired", riding = false)
    }
    fun unpair(relay: String, token: String, transport: WebSocket.Factory? = null) { connect(relay, token, CompanionProtocol.action("unpair"), transport = transport) }
    fun disconnect(preserveStatus: Boolean = false) {
        generation++; retry?.cancel(); timeout?.cancel(); retry = null; timeout = null
        ready = false; desiredRide = false; startSent = false; binding = false; awaitingAttach = false; action = null; endpoint = null
        socket?.close(1000, "companion stopped"); socket = null; stopped()
        mutableState.value = if (preserveStatus) mutableState.value.copy(riding = false) else CompanionState()
    }
    private fun open() {
        val url = endpoint ?: return
        val owner = ++generation
        ready = false; startSent = false; awaitingAttach = action != null
        mutableState.value = mutableState.value.copy(status = "connecting", detail = null, riding = desiredRide)
        socket = factory.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) { scope.launch {
                if (owner != generation || socket !== ws) return@launch
                timeout?.cancel()
                timeout = scope.launch { delay(if (binding) 65_000 else 15_000); if (owner == generation) fail(tr(Str.COMP_TIMEOUT)) }
            } }
            override fun onMessage(ws: WebSocket, text: String) { scope.launch {
                if (owner != generation || socket !== ws) return@launch
                val incoming = CompanionProtocol.parse(text) ?: return@launch
                // Wait for attach sync before sending a mutation: its initial ready/unpaired
                // status must never be mistaken for the answer to pair or unpair.
                if (awaitingAttach && incoming.status != "error") {
                    awaitingAttach = false
                    val pendingAction = action; action = null
                    if (pendingAction != null && !ws.send(pendingAction)) transportLost(ws, owner, null)
                    return@launch
                }
                if (incoming.status == "error" && incoming.device?.startsWith("location.") == true) return@launch
                timeout?.cancel(); binding = false
                if (incoming.status == "error") { fail(incoming.detail ?: tr(Str.COMP_PAIR_FAILED)); return@launch }
                attempts = 0
                if (incoming.status == "unpaired") { disconnect(); mutableState.value = incoming; return@launch }
                ready = desiredRide && incoming.status in setOf("ready", "sharing")
                mutableState.value = incoming.copy(riding = desiredRide, fixes = mutableState.value.fixes)
                if (incoming.status == "ready" && desiredRide && !startSent) {
                    startSent = true
                    if (!ws.send(CompanionProtocol.action("start"))) transportLost(ws, owner, null)
                }
                if (!desiredRide && incoming.status in setOf("paired", "ready", "helmetOffline")) {
                    generation++; socket = null; endpoint = null; ws.close(1000, "paired")
                }
            } }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null); scope.launch { transportLost(ws, owner, if (code == 1008) 401 else null) } }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { scope.launch { transportLost(ws, owner, response?.code) } }
        })
    }
    private fun transportLost(ws: WebSocket, owner: Long, status: Int?) {
        if (owner != generation || socket !== ws) return
        socket = null; ready = false; timeout?.cancel(); ws.cancel()
        if (!desiredRide || status != null || attempts >= 6) { fail(if (status == 401) tr(Str.COMP_SESSION_EXPIRED) else tr(Str.COMP_LINK_LOST)); return }
        val wait = minOf(8000L, 1000L shl attempts++)
        mutableState.value = mutableState.value.copy(status = "connecting", detail = tr(Str.COMP_RECONNECTING))
        retry = scope.launch { delay(wait); if (owner == generation && desiredRide) open() }
    }
    fun sendFix(fix: CompanionFix, elapsedMs: Long, wallMs: Long) {
        val ws = socket ?: return
        if (!desiredRide || !ready || ws.queueSize() > 16_384) return
        val text = gate.next(fix, elapsedMs, wallMs) ?: return
        if (ws.send(text)) mutableState.value = mutableState.value.copy(fixes = mutableState.value.fixes + 1)
        else transportLost(ws, generation, null)
    }
    fun fail(message: String) { disconnect(); mutableState.value = CompanionState("error", detail = message) }
}
