package com.horizon.maxhelmet.companion

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Screen-scoped discovery; only opaque TXT tokens are used, never advertised hosts. */
class HelmetDiscovery(context: Context) {
    private val manager = context.getSystemService(NsdManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val found = mutableMapOf<String, String>()
    private val visible = mutableSetOf<String>()
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving: String? = null
    private val mutableTokens = MutableStateFlow<List<String>>(emptyList())
    val tokens = mutableTokens.asStateFlow()
    private var listener: NsdManager.DiscoveryListener? = null
    private var generation = 0
    fun start() {
        stop(); val owner = generation
        val scan = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) = Unit
            override fun onDiscoveryStopped(type: String) = Unit
            override fun onStartDiscoveryFailed(type: String, code: Int) { main.post { if (generation == owner) stop() } }
            override fun onStopDiscoveryFailed(type: String, code: Int) = Unit
            override fun onServiceLost(info: NsdServiceInfo) { main.post {
                if (generation == owner) { visible.remove(info.serviceName); found.remove(info.serviceName); publish() }
            } }
            override fun onServiceFound(info: NsdServiceInfo) { main.post {
                if (generation != owner || visible.size >= 32 || !visible.add(info.serviceName)) return@post
                pending.addLast(info); resolveNext(owner)
            } }
        }
        listener = scan
        runCatching { manager?.discoverServices("_maxhelmet._tcp.", NsdManager.PROTOCOL_DNS_SD, scan) }.onFailure { stop() }
    }
    // Older NSD implementations accept only one resolve at a time.
    @Suppress("DEPRECATION")
    private fun resolveNext(owner: Int) {
        if (owner != generation || resolving != null) return
        while (pending.isNotEmpty() && pending.first().serviceName !in visible) pending.removeFirst()
        val info = pending.removeFirstOrNull() ?: return
        resolving = info.serviceName
        fun complete(result: NsdServiceInfo?) {
            main.post {
                if (generation != owner) return@post
                resolving = null
                if (info.serviceName in visible && result != null) {
                    val token = result.attributes["dt"]?.toString(Charsets.UTF_8)
                    if (token != null && CompanionProtocol.discover(token) != null) { found[info.serviceName] = token; publish() }
                }
                resolveNext(owner)
            }
        }
        runCatching { manager?.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, code: Int) { complete(null) }
            override fun onServiceResolved(resolved: NsdServiceInfo) { complete(resolved) }
        }) }.onFailure { complete(null) }
    }
    private fun publish() { mutableTokens.value = found.values.distinct().sorted() }
    fun stop() {
        generation++; listener?.let { runCatching { manager?.stopServiceDiscovery(it) } }; listener = null
        pending.clear(); visible.clear(); resolving = null; found.clear(); publish()
    }
}
