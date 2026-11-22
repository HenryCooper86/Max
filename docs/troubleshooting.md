# Troubleshooting the web SDK

Start with the error. In the SDK, every failure arrives as a `VoiceAgentError` with a `code`
(see [errors and reconnecting](../sdk/README.md#errors-and-reconnecting)); the `<voice-agent>` widget shows a message for
each code and fires `voice-agent:error` with the same object. Log `error.code`, `error.closeCode` and `error.cause`
before anything else:

```js
agent.on("error", (e) => console.error(e.code, e.closeCode, e.message, e.cause));
agent.on("close", (c) => console.log("closed", c.code, c.reason, c.willReconnect));
```

| You see                                    | Read                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| Nothing happens on click, or no mic prompt | [HTTPS and localhost](#https-and-localhost)             |
| `microphone`                               | [Microphone permission](#microphone-permission)         |
| `token`                                    | [Token endpoint failures](#token-endpoint-failures)     |
| `connection` with `closeCode` 1006         | [Origin allowlist refusals](#origin-allowlist-refusals) |
| `unauthorized`, `usage_limit`, other codes | [Close codes](#close-codes)                             |
| Connected, but you hear nothing            | [Blocked autoplay](#blocked-autoplay)                   |
| Works everywhere except iPhone or Safari   | [Safari and iOS](#safari-and-ios)                       |

## HTTPS and localhost

Browsers expose the microphone (`getUserMedia`) only in a secure context: an `https://` page, or `http://localhost` and
`http://127.0.0.1`. On a plain `http://` page, or a LAN address such as `http://192.168.1.20:5173`, there is no
`navigator.mediaDevices`, and `start()` fails with code `microphone` ("This browser cannot access a microphone").

- Serve the page over HTTPS (a tunnel such as `cloudflared` or `ngrok` is the quickest way to test on a phone).
- A page served over HTTPS must also reach the relay over `wss://`. Browsers block `ws://` from a secure page. Use an
  `https://` relay URL; the SDK turns it into `wss://`.
- A text-only session needs no microphone: `agent.start({ microphone: false })`.
- Inside an `<iframe>`, the embedding page must allow it: `<iframe allow="microphone">`.

## Microphone permission

Code `microphone`. The original browser error is `error.cause`; its `name` tells you why:

| `cause.name`       | Meaning and fix                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotAllowedError`  | The user (or a site setting, or a `Permissions-Policy: microphone=()` header) refused. Ask them to allow it from the address bar's site settings, then press the button again. The browser will not ask twice after a block. |
| `NotFoundError`    | No microphone is connected or enabled.                                                                                                                                                                                       |
| `NotReadableError` | Another app has the device, or the OS blocked it (macOS: System Settings, Privacy, Microphone).                                                                                                                              |

Call `start()` from a click or key press. Browsers may refuse to ask for the microphone without a user gesture.

## Origin allowlist refusals

The relay refuses a browser whose `Origin` is not in `RELAY_ALLOWED_ORIGINS` with HTTP 403 (and a missing or wrong token
with 401) **before** the WebSocket exists. JavaScript cannot see that status; the browser reports only a failed
connection, close code 1006. So you get `connection` (`Relay closed the connection (1006)`), and after a drop the SDK
retries six times before giving up.

To tell them apart, open the browser's Network tab, filter by `WS`, and read the status of the `/agent` request, or run:

```bash
curl -i -H "Origin: https://your-site.example" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  "https://relay.example.com/agent"
```

- `403`: add the exact origin (scheme, host and port, no trailing slash) to `RELAY_ALLOWED_ORIGINS`. See
  [security](security.md).
- `401`: the token is missing, expired or wrong. See below.
- `429`: too many attempts from one IP. Wait a minute.
- With Max Cloud and `project="pub_..."`, the page's origin must be listed in the console's **Install** tab. A refusal
  there is a `token` error whose message comes from the relay.

## Token endpoint failures

Code `token`: the SDK could not get a token, so it never reached the relay. The message says what the token function (or
the `project` request) threw.

- Open the Network tab and look at the request to your token URL. It should return JSON `{ "token": "vst_..." }` with
  status 200.
- `<voice-agent token-url="...">` sends `POST` and falls back to `GET` on 404 or 405, with cookies for the same origin
  only. A cross-origin token URL needs your own function with `credentials: "include"` and CORS headers.
- A 502 from your backend usually means the relay refused it: check `RELAY_AUTH_TOKEN` on the backend matches the relay,
  and that `RELAY_URL` is reachable from the server.
- Tokens are short-lived. Pass a function, not a string, so every connect and reconnect fetches a fresh one.
- A token the relay no longer accepts gives `unauthorized` (below), not `token`.

## Close codes

What the relay's WebSocket close codes mean, and what the SDK does. The full list is in the
[protocol](protocol.md#close-codes).

| Code | SDK error              | Meaning                                                                                              | What to do                                                                                                                       |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1000 | none                   | Normal close, or you called `stop()`.                                                                | Nothing.                                                                                                                         |
| 1001 | `connection`           | The relay is shutting down or restarting.                                                            | Automatic reconnect with backoff.                                                                                                |
| 1006 | `connection`           | The connection failed or dropped with no close frame: network, TLS, proxy, or a 401/403/429 refusal. | Automatic reconnect up to 6 times; check the Network tab.                                                                        |
| 1008 | `unauthorized`         | The relay does not accept the credentials: signed out, session expired, account deleted.             | With a token function the SDK retries once with a new token; otherwise fix the token.                                            |
| 1011 | `connection`           | The voice backend failed to start.                                                                   | Automatic reconnect; check the relay's logs and provider key.                                                                    |
| 4001 | none (status `closed`) | Idle for too long (default 10 minutes of silence).                                                   | Press the button again; this is not an error.                                                                                    |
| 4003 | `usage_limit`          | The account's voice minutes for this month are used up.                                              | Raise the allowance or wait for the month to roll over; see [usage and billing](usage-and-billing.md). Reconnecting cannot help. |

## Blocked autoplay

Browsers keep an `AudioContext` suspended until the user has interacted with the page. The SDK creates and resumes its
audio inside the call to `start()`, so a session started from a click works. When it cannot (for example `start()` ran
from a timer, from `load`, or after an `await` that lost the gesture), the context stays suspended: the agent connects,
you hear nothing, and the SDK reports it a second after:

```js
agent.on("warning", (w) => w.code === "audio_blocked" && showEnableSoundButton());
button.onclick = () => agent.resumeAudio(); // must run inside a click
agent.on("audioresume", hideEnableSoundButton);
```

The widget does this for you: a "Tap to enable sound" button appears in its panel.

To avoid it, start the session directly from a click handler, before any `await`.

## Safari and iOS

These are the iOS and Safari behaviours the SDK already handles, and what remains for you.

- **Audio unlocks on a tap.** The SDK builds its `AudioContext` and calls `resume()` synchronously in `start()`, because
  Safari only allows that inside the gesture. It never waits for a pending `resume()` longer than one second, so a
  blocked context cannot freeze `start()`; it raises `audio_blocked` instead (see above).
- **Microphone capture** uses an `AudioWorklet` loaded from a `blob:` URL and falls back to `ScriptProcessorNode` where
  worklets are missing (older Safari). If your Content Security Policy restricts `script-src`, allow `blob:`.
- **Supported versions.** iOS 14.5 or newer (every iOS browser uses WebKit). In an in-app browser, such as a social
  app's built-in viewer, the microphone is often disabled: open the page in Safari.
- **Silent switch and volume.** Web Audio on iPhone follows the ringer switch in some versions. If the connection is
  fine and the status says `speaking` but you hear nothing, check the switch and the media volume.
- **Playback rate.** The agent's voice is played at 24 kHz and capture is resampled from the context's own rate to
  16 kHz, so a context that Safari opens at 44.1 or 48 kHz is fine.
- **Speech fallback.** When the relay asks for browser speech, the SDK uses `speechSynthesis` if it exists; without it,
  those replies stay text-only.
- **Background tabs.** iOS suspends audio when the page is backgrounded or the screen locks; the session may close.
  The SDK reconnects, but the user has to tap to hear sound again.

## Still stuck

Check the relay's own log first, then compare with the [protocol](protocol.md) and the [security](security.md) notes. For bugs, open an issue with the `error.code`,
`error.closeCode`, the browser and OS version, and whether the page is on HTTPS.
