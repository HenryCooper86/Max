package io.github.henrycooper86.max.agent

import org.json.JSONObject
import java.io.DataInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * A loopback relay for session tests. It completes each WebSocket upgrade by hand, keeps the JSON
 * text events the client sends, and sends what a test scripts, so the session's real OkHttp
 * transport and listener callbacks see everything as a relay sends it.
 */
internal class LoopbackRelay : AutoCloseable {
    /** One accepted WebSocket connection. Sending and closing are safe from any thread. */
    inner class Connection(private val socket: Socket) {
        private val input = DataInputStream(socket.getInputStream())
        private val output = socket.getOutputStream()

        /** Sends one text (JSON) event. */
        fun send(text: String) = write(0x1, text.toByteArray())

        /** Closes the WebSocket with `code`, the way a relay does (RFC 6455 5.5.1). */
        fun close(code: Int, reason: String = "") =
            write(0x8, byteArrayOf((code shr 8).toByte(), code.toByte()) + reason.toByteArray())

        /** Drops the TCP connection with no WebSocket close, as a lost link does. */
        fun drop() {
            runCatching { socket.close() }
        }

        /** A server-to-client frame (RFC 6455 5.2): FIN + opcode, a length of 7, 16 or 64 bits, and the payload unmasked. */
        private fun write(opcode: Int, payload: ByteArray) {
            val head = ArrayList<Byte>(10)
            head.add((0x80 or opcode).toByte())
            when (payload.size) {
                in 0..125 -> head.add(payload.size.toByte())
                in 126..65_535 -> {
                    head.add(126.toByte())
                    head.add((payload.size shr 8).toByte())
                    head.add(payload.size.toByte())
                }
                else -> {
                    head.add(127.toByte())
                    for (shift in 56 downTo 0 step 8) head.add((payload.size.toLong() ushr shift).toByte())
                }
            }
            synchronized(output) {
                output.write(head.toByteArray())
                output.write(payload)
                output.flush()
            }
        }

        /** Answers the upgrade, then reads this connection until it closes; meant for its own thread. */
        fun serve() {
            try {
                respondToUpgrade()
                readFrames()
            } catch (_: IOException) {
            } finally {
                drop()
            }
        }

        private fun respondToUpgrade() {
            val request = StringBuilder()
            while (!request.endsWith("\r\n\r\n")) {
                val next = input.read()
                if (next < 0) throw IOException("the client closed before its upgrade")
                request.append(next.toChar())
            }
            val key = request.lineSequence()
                .first { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
                .substringAfter(':').trim()
            // The accept value is the client's key with a fixed GUID, SHA-1 hashed (RFC 6455 1.3).
            val accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray())
            )
            val response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: $accept\r\n\r\n"
            synchronized(output) {
                output.write(response.toByteArray())
                output.flush()
            }
        }

        /** Client frames are masked (RFC 6455 5.3), so each payload is unmasked on the way in. */
        private fun readFrames() {
            while (true) {
                val first = input.read()
                val second = input.read()
                if (first < 0 || second < 0) return
                val opcode = first and 0x0F
                var length = second and 0x7F
                if (length == 126) length = input.readUnsignedShort()
                else if (length == 127) length = input.readLong().coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
                val mask = if (second and 0x80 != 0) ByteArray(4).also { input.readFully(it) } else null
                val payload = ByteArray(length).also { input.readFully(it) }
                if (mask != null) {
                    for (index in payload.indices) payload[index] = (payload[index].toInt() xor mask[index % 4].toInt()).toByte()
                }
                when (opcode) {
                    0x1 -> received.add(String(payload, Charsets.UTF_8))
                    // Answer the client's close with its own code, then end TCP.
                    0x8 -> {
                        if (payload.size >= 2) write(0x8, payload.copyOf(2))
                        return
                    }
                    0x9 -> write(0xA, payload)
                }
            }
        }
    }

    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val connections = CopyOnWriteArrayList<Connection>()
    private val received = CopyOnWriteArrayList<String>()
    private val acceptor = thread(name = "loopback-relay", isDaemon = true) {
        while (!server.isClosed) {
            val socket = runCatching { server.accept() }.getOrNull() ?: break
            val connection = Connection(socket)
            connections.add(connection)
            thread(name = "loopback-relay-connection", isDaemon = true) { connection.serve() }
        }
    }

    /** The relay WebSocket URL a rider would type for this server. */
    val agentUrl: String get() = "ws://127.0.0.1:${server.localPort}/agent"

    /** Connections accepted so far. */
    val connectionCount: Int get() = connections.size

    /** The connection most recently accepted. */
    val current: Connection? get() = connections.lastOrNull()

    /** Every event of one `type` the client has sent, decoded, oldest first across connections. */
    fun events(type: String): List<JSONObject> = received.mapNotNull { text ->
        runCatching { JSONObject(text) }.getOrNull()?.takeIf { it.optString("type") == type }
    }

    fun sessionStarts(): List<JSONObject> = events("session.start")
    fun deviceResults(): List<JSONObject> = events("device.result")

    override fun close() {
        server.close()
        connections.forEach { it.drop() }
    }

    companion object {
        /** A `session.started` event as a relay sends it: the mock demo here, with the conversation's
         *  `resume` id and the relay's protocol version when given. */
        fun sessionStarted(resume: String? = null, protocol: Int? = 1): String {
            val event = JSONObject().put("type", "session.started").put("provider", "mock")
                .put("mode", "mock").put("capabilities", JSONObject())
            resume?.let { event.put("resume", it) }
            protocol?.let { event.put("protocol", it) }
            return event.toString()
        }
    }
}
