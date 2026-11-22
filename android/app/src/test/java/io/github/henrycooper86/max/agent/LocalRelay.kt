package io.github.henrycooper86.max.agent

import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList

/** A loopback HTTP relay for client tests: records each request and answers with a canned reply. */
internal class LocalRelay : AutoCloseable {
    data class Recorded(val method: String, val path: String, val headers: Map<String, String>, val body: String)
    data class Reply(val status: Int, val body: String, val contentType: String = "application/json")

    val requests = CopyOnWriteArrayList<Recorded>()
    @Volatile var reply: (Recorded) -> Reply = { Reply(404, "") }

    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
        createContext("/") { exchange ->
            val recorded = Recorded(
                exchange.requestMethod,
                exchange.requestURI.rawPath,
                exchange.requestHeaders.entries.associate { (name, values) -> name.lowercase() to values.joinToString(",") },
                exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            )
            requests += recorded
            val answer = reply(recorded)
            val bytes = answer.body.toByteArray()
            exchange.responseHeaders.add("Content-Type", answer.contentType)
            exchange.sendResponseHeaders(answer.status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        start()
    }

    /** The relay WebSocket URL a rider would type for this server. */
    val agentUrl: String get() = "ws://127.0.0.1:${server.address.port}/agent"

    override fun close() = server.stop(0)
}
