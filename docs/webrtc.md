# WebRTC transport

By default a client talks to the relay over a WebSocket. That works everywhere, and on a good network you will not
hear the difference. On a poor one you will: a WebSocket runs over TCP, so one lost packet holds back all the audio
behind it until it is sent again, and the agent's voice stalls and then rushes.

With WebRTC the audio travels over UDP as Opus. A lost packet is skipped, and the browser hides the gap. The browser
also runs its own jitter buffer, and the relay sends a low-bitrate copy of every frame in the next packet, so the
browser can repair a single loss outright. That is the agent's voice. In the other direction the relay puts late
packets back in order, and a microphone packet that is lost is left out: the relay does not conceal or repair it.

The protocol does not change. A WebRTC session is the same `/agent` session with a different transport, so tokens,
usage limits, tools, handoff, resume and every voice backend work as before.

| What                  | WebSocket                      | WebRTC                                                     |
| --------------------- | ------------------------------ | ---------------------------------------------------------- |
| Works through         | Any HTTPS proxy                | Needs UDP from the client to the relay                     |
| Audio on the wire     | PCM16: 384 kbit/s down, 256 up | Opus: about 24 kbit/s down, the browser's choice up        |
| A lost packet         | Stalls the stream              | Agent's voice: concealed or repaired. Microphone: skipped. |
| Relay CPU per session | Almost none                    | Opus encode and decode, in the relay process               |
| Clients               | Web, iOS, Android, device      | Web SDK. Native clients keep the WebSocket.                |

Use WebRTC when your users are on phones or other networks you do not control. Keep the WebSocket when the relay sits
behind a proxy you cannot open UDP ports on. You do not have to choose once: a page that asks for WebRTC falls back to
the WebSocket by itself wherever WebRTC cannot be used.

## Turn it on

In the relay's environment:

```bash
WEBRTC=on
WEBRTC_PUBLIC_IP=203.0.113.5      # the address clients reach this server at
WEBRTC_UDP_PORTS=50000-50100      # open these in the firewall
```

Then ask for it in the page:

```ts
const agent = new VoiceAgent({ url: "https://relay.example.com", token, transport: "webrtc" });
agent.on("warning", (w) => {
  if (w.code === "webrtc_unavailable") console.info(w.message); // the session runs over the WebSocket
});
await agent.start();
agent.transport; // "webrtc" or "websocket"
```

With the script tag or the `<voice-agent>` element, add `data-transport="webrtc"` or `transport="webrtc"`.

Nothing else changes in your code. Captions, tools, `interrupt()`, `mute()` and reconnecting behave the same.

## What the network needs

Signalling is one HTTPS request to the relay (`POST /agent/webrtc`), so it passes through your reverse proxy like any
other route. The audio does not: it goes straight from the browser to the relay's UDP ports.

- **Open the UDP ports.** Set `WEBRTC_UDP_PORTS` to a range and allow inbound UDP on it in the server's firewall and
  your cloud provider's (a security group on AWS, the networking tab on Lightsail). One session uses one port, so
  the relay runs at most as many WebRTC sessions as the range has ports. Without the variable the relay uses any free
  port, which only suits a machine with no firewall.
- **Tell the relay its public address.** Most cloud servers have a private address and reach the internet through 1:1
  NAT, so the relay cannot see the address clients use. Set `WEBRTC_PUBLIC_IP` to it. Several addresses can be listed
  with commas, for example an IPv4 and an IPv6 one. With it set, clients are told only these addresses. Without it
  they are told every address of the machine's network interfaces, private, VPN and container ones included, which is
  fine on your own machine and not something to publish.
- **In Docker,** publish the range as UDP and set `WEBRTC_PUBLIC_IP` to the host's address, because the container sees
  only its own:

  ```bash
  docker run -d -p 8787:8787 -p 50000-50100:50000-50100/udp --env-file .env -v relay-data:/data voice-agent-kit
  ```

  A wide published range makes Docker slow to start. A hundred ports is plenty for a hundred simultaneous sessions.

- **Networks that block UDP.** Some corporate and hotel networks allow only HTTPS. There the browser cannot reach the
  relay over UDP, the connection attempt gives up after 8 seconds, and the SDK continues over the WebSocket. If you
  want WebRTC on those networks too, run a TURN server (coturn is the usual choice) and give it to both sides: the
  relay with `WEBRTC_ICE_SERVERS`, the page with the `iceServers` option.

The relay contacts no outside server on its own. It uses a STUN or TURN server only if you name one in
`WEBRTC_ICE_SERVERS`.

## Settings

| Variable              | Default | What it does                                                                                                             |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `WEBRTC`              | off     | `on` turns the transport on. Off, `POST /agent/webrtc` answers 404 and clients use the WebSocket.                        |
| `WEBRTC_PUBLIC_IP`    | none    | The relay's public IP addresses, comma-separated. Needed behind NAT, which is most cloud servers.                        |
| `WEBRTC_UDP_PORTS`    | any     | The UDP port range to use, such as `50000-50100`, within 1024 to 65535.                                                  |
| `WEBRTC_ICE_SERVERS`  | none    | STUN and TURN servers for the relay, as JSON: `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. |
| `WEBRTC_MAX_SESSIONS` | `100`   | Simultaneous WebRTC sessions, 1 to 5000, and never more than the port range holds. Further clients use the WebSocket.    |

A setting the relay cannot use is reported in the log at startup and ignored.

## When it cannot be used

A page that asks for `transport: "webrtc"` uses the WebSocket instead, and emits a `webrtc_unavailable` warning, when:

- the relay does not have WebRTC on, or is an older version;
- the relay has reached `WEBRTC_MAX_SESSIONS`, has no free UDP port, or already has eight connections being set up
  from the same address;
- the browser has no `RTCPeerConnection`;
- the peer connection does not open within 8 seconds, which is what a blocked UDP path looks like.

The fallback happens before the session starts, so nothing is lost, and it lasts until the next `start()`. A refused
token or origin is not a reason to fall back: it fails the same way on both transports.

A WebRTC session that drops later reconnects like a WebSocket one, and carries the conversation on where the relay
supports [resuming](conversations.md#carrying-a-conversation-across-a-dropped-connection).

## Security

Signalling goes through the same checks as the WebSocket upgrade: the relay token, a session token or a login; the
origin allowlist; and the connection rate limit. The token travels in the `Authorization` header, not in the URL. The
media and the events are encrypted with DTLS-SRTP, as in every WebRTC connection, with keys the two sides agree on
through the HTTPS signalling request. Serve the relay over HTTPS, as you already must for the microphone.

A peer that has been answered but never connects is dropped after 15 seconds, and `WEBRTC_MAX_SESSIONS` counts such
peers too. One address may have eight of them at a time. When the peer does connect, the relay checks the token and
the origin again, so a token that expired or was revoked in between does not start a session.

An offer must hold exactly one audio track and one data channel on one transport, so a session takes one UDP port and
no more. Microphone audio is accepted at little more than real time, and a peer that sends more data than the relay's
receive window allows is dropped.

## What it costs

Each WebRTC session encodes and decodes Opus inside the relay process, and holds the agent's speech that has not been
played yet: up to two minutes of it, about 6 MB, for a long reply that the model produced quickly. Measured on an
Apple M5 Max laptop, with test clients in the same process: 60 sessions at once, each with three seconds of speech in
both directions, lost no audio and used about 70% of one core, clients included. The codec itself was run with 12,000
sessions' worth of encoders and decoders open at once, at about 170 KB of memory for each session. Not measured: a
relay under that load for hours, or on a small cloud server.

## What was tested

- A real browser (Chrome, headless, on the same machine as the relay) through the built SDK: a session over WebRTC from
  a page on another origin, typed and spoken turns, the agent's voice played and metered, `interrupt()`, a relay token
  in the header, a refused token, an origin outside the allowlist, and fallback to a relay with WebRTC off. Chrome
  reported the negotiated codec as Opus with in-band error correction and a jitter buffer of about 35 ms.
- The relay side in automated tests with real peer connections: pacing, barge-in, reordering of late packets, closing
  with a reason, limits, shutdown, offers that ask for more than one transport, a flood of microphone audio, and 300
  calls' worth of Opus codecs working at the same time.

Not tested yet: Firefox and Safari, a real lossy mobile network, and a TURN server. Tell us what you find.

## For client authors

You only need this if you are writing your own WebRTC client. The browser SDK does all of it.

1. Create a peer connection with one audio transceiver (`sendrecv`, Opus) and one data channel named `events`,
   bundled on one transport (`a=group:BUNDLE`, which browsers do by default). An offer with any other media section is
   refused.
2. Create an offer, wait for candidate gathering, and send it:

   ```text
   POST /agent/webrtc
   Authorization: Bearer <token>
   Content-Type: application/json

   { "sdp": "<the offer>" }
   ```

   The answer is `201` with `{ "ok": true, "sdp": "<the answer>" }`, candidates included. `401` and `403` mean what
   they mean for the WebSocket, `404` means WebRTC is off, `503` means no room. `400` means the offer was not
   acceptable.

3. When the data channel opens, send `session.start` on it. From here the JSON events are exactly those of the
   [protocol](protocol.md), one event per message, up to 256 KiB each. An event from the relay that is larger than
   your client accepts is not delivered.
4. Audio is not sent as binary messages. The microphone is the audio track; it counts only between `audio.start` and
   `audio.stop`, as over a WebSocket. The agent's voice arrives on the relay's track, already paced in real time.
5. Three messages exist only on this transport:

   | Message                                                          | From   | Meaning                                                                                                 |
   | ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
   | `{ "type": "transport.close", "code": 4001, "reason": "agent" }` | relay  | The close code and reason a WebSocket would have carried. The connection closes right after.            |
   | `{ "type": "transport.close" }`                                  | client | The client is leaving on purpose. Without it the relay sees a lost connection.                          |
   | `{ "type": "transport.clear" }`                                  | client | Drop the agent speech not yet sent (the user silenced it). The relay holds that speech, not the client. |

   The codes are the [close codes](protocol.md#close-codes) of the protocol.
