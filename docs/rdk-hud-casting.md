# Phone navigation on the RDK display

The Wi-Fi bench prototype sends the **phone's active navigation state** to a
fullscreen HUD on the RDK. Both iOS and Android send navigation state using the
same local protocol. iOS additionally shares snapshots of its existing AMap view,
including real streets, labels, route and provider attribution. Android and older
iOS senders retain the route schematic. The phone owns routing and guidance;
there is no second routing engine or new map-provider credential.

This is separate from **Helmet Ride**, which forwards phone GPS through the
relay for RDK-owned navigation. Do not start a second RDK navigation session
while testing phone casting: the phone remains the navigation/audio owner.

## Bench setup

1. Deploy the updated RDK agent using the existing deployment procedure in
   [the RDK README](../rdk/README.md). The receiver is part of the existing HUD
   server, on `MAX_HUD_PORT` (default `8080`); there is no extra service or port.
2. On the **RDK desktop**, open `http://127.0.0.1:8080/cast`. Use the screen's
   **全屏** button, or launch the installed browser as a desktop user:
   `chromium --kiosk http://127.0.0.1:8080/cast`.
   Substitute the configured port if different. The existing bench page also
   links to the new HUD. Do not open the board's LAN IP in this browser: the
   display/code endpoint deliberately requires a loopback host and connection.
3. Connect phone and RDK to the same trusted Wi-Fi network. Alternatively,
   connect the RDK to the phone's hotspot. The network must permit client-to-client
   TCP connections. Use the RDK's Wi-Fi IPv4 address if several are displayed;
   VPN or Ethernet interfaces may appear too.
4. Install a **Debug/development build** of the iOS or Android app. Start phone
   navigation and confirm the destination. In navigation details, tap
   **投屏到 HUD** (Cast to HUD).
5. Enter the `address:port` and six-digit connection code shown on the RDK.
   Tap **开始投屏**, then **完成** to return to navigation. On iOS, allow Local
   Network access when asked. The code is for this HUD connection, not the
   relay's Helmet Ride pairing code.
6. Verify that destination, route shape, current location, next instruction,
   distance and remaining ETA agree with the phone. On iOS, keep the navigation
   map visible and enabled: the HUD mirrors that map once per second. Pan, zoom
   and select follow/overview on the phone. Valid compass readings rotate the
   phone map while sharing; stopping sharing restores north-up. In follow mode,
   the rider stays centered while surrounding streets move with GPS updates.
   Without a recent native image, the map falls back to a north-up route
   schematic without streets/tiles. It follows the rider by default; **全程**
   switches to the entire route and **跟随** returns to the rider. Numbered
   markers show the next three maneuvers, with the following two instructions
   in the side panel. A metric scale and remaining distance/time accompany the
   estimated arrival clock. Street names come from the phone’s route instructions. Routes longer than 2,048 vertices are
   sampled evenly for display, preserving the first and last points; the
   phone's actual navigation geometry is unchanged.
7. Tap **停止投屏**, end navigation, or put the app in the background to stop.
   On Wi-Fi loss, reconnect explicitly using the new code. Casting does not
   resume automatically after backgrounding, reconnection or a board restart.

The phone still needs its existing relay/internet access to request routes.
The phone-to-HUD transfer itself stays on the local network. RDK-hosted access
point mode, BLE, automatic address discovery, optical mirroring and locked-screen
casting are not implemented by this change.

## Connection and freshness behavior

- Codes expire after five minutes and are consumed by one sender. A new code
  appears after that sender disconnects. At most five join attempts per minute
  are allowed globally; a rejected second sender never replaces the active one.
- The app sends new navigation outputs, with one frame awaiting acknowledgment
  at a time. Intermediate outputs coalesce into the newest pending frame.
  A separate `hud.ping` / `hud.pong` exchange every four seconds keeps the
  connection alive without republishing frozen GPS as fresh guidance.
- The map and guidance keep constant brightness during GPS updates. Staleness
  uses an amber status message rather than dimming the display.
- Eight seconds without a new frame marks the display stale, changes the position
  marker to an amber outline labeled **上次位置**, and replaces the active maneuver with a request to check the phone.
  The phone reports timeout after twelve seconds without a receiver reply or
  an outstanding frame acknowledgment.
  Native map snapshots have independent acknowledgments and never refresh GPS
  freshness. After five seconds without an image, or when GPS is stale, the
  display falls back to the schematic. iOS disables automatic location pauses
  while navigating; this does not improve the accuracy of a weak GPS fix.
  The receiver releases a sender after thirty seconds without frames, maps or heartbeats. A clean stop
  or socket disconnect clears the route immediately.
- The code, route and rider position live only in memory. The display endpoint
  is loopback-only, denies foreign Host headers, and uses `Cache-Control: no-store`.
  Browser-origin WebSocket senders are rejected. The sender socket does not
  expose bench tokens, account sessions, pairing secrets, cameras or transcripts.
- This prototype uses **unencrypted local WebSockets**. Use a trusted bench
  network. Release apps deliberately disable this transport; their existing TLS
  policy is unchanged. Authenticated encrypted transport is still required before
  shipping. A connection code does not protect against a network eavesdropper.

## Wire contract (version 1)

Connect a native sender to `ws://<rdk-address>:<hud-port>/cast/socket` and send
`{"type":"hud.join","code":"<six digits>"}` within five seconds. The receiver
answers `{"type":"hud.ready"}` or closes the connection. Then send complete
`hud.frame` snapshots:

```json
{
  "type": "hud.frame",
  "sequence": 1,
  "destination": "人民广场",
  "instruction": "右转进入南京东路",
  "distance": 120,
  "remaining": 2400,
  "seconds": 480,
  "offRoute": false,
  "polyline": [
    { "lat": 31.23, "lon": 121.47 },
    { "lat": 31.24, "lon": 121.48 }
  ],
  "position": { "lat": 31.23, "lon": 121.47 }
}
```

Coordinates are GCJ-02; the RDK must not convert them again. Distances are meters,
time is seconds, and sequence increases within each connection. The receiver
acknowledges each accepted sequence with `hud.ack`. `position` may be null. An optional `turns` array carries up to three upcoming
maneuvers, each with `lat`, `lon`, `instruction`, and distance from the rider in
meters (`distance`). Older senders without `turns` remain supported.
Invalid, oversized, non-finite or out-of-order frames terminate the connection.
`{"type":"hud.ping"}` returns `{"type":"hud.pong"}` for connection health only;
it does not reset guidance freshness. `{"type":"hud.stop"}` or closing the socket
releases the display.

Optional iOS map sharing sends `{"type":"hud.map","sequence":1,"jpeg":"<base64 JPEG>"}`
after the first guidance frame. It has an independent increasing sequence and
`hud.map.ack` response. JPEG payloads are limited to 180,000 decoded bytes; the
phone captures only the consented native map view, not other app content. One
snapshot is in flight at a time. The local-only `/cast/map` endpoint serves the
latest image; `/cast/state` advertises `mapSequence` while it is recent. Images
are memory-only, cleared on disconnect and unavailable when guidance is stale.
The whole snapshot is fitted without cropping provider attribution. Native map
capture requires a real iOS device; simulator tests cover heading math, route
movement and transport behavior, not native map capture or sensor performance.

## Acceptance record

Automated checks cover wire validation, pairing, ownership, stale state,
rerouting, disconnect cleanup, sender payloads and existing HUD access controls.
Local browser checks exercise the fullscreen waiting/navigation views with
synthetic route data. These are not physical phone/RDK acceptance results.

Before calling the hardware feature verified, test each phone platform against
the connected RDK display: pairing, moving GPS, reroute, arrival/stop, Wi-Fi
loss/rejoin, background/foreground, and receiver restart. Also verify hotspot
connectivity and readability at the actual display resolution. The receiver/display bench verification below is complete; physical phone acceptance
is still pending.

### RDK bench verification — 2026-09-18

Deployed the five HUD receiver/display files to the connected RDK after confirming
its original HUD files matched the repository baseline. Backup:
`/opt/max-hud-backup-20260918-1/hud`. This was a scoped prototype deployment, not a
full reviewed release rollout. The device identity digest was unchanged across
the agent restart. The existing bench endpoint still returns HTTP 200, and the
agent remained active with zero automatic restarts during verification.

The connected HDMI display reports 1920×1080. A separate Chromium kiosk profile
is running as the desktop user `sunrise`, with translation prompts disabled,
under the transient `max-hud-display.service`. It opens
`http://127.0.0.1:8080/cast`; this kiosk launch is not configured to start after a
reboot.

A laptop sender connected over the actual LAN, authenticated with the displayed
code, and received frame acknowledgments. A screenshot of the physical desktop
confirmed the synthetic route, rider marker, instruction and ETA rendered. An
explicit stop cleared the route and returned the receiver to waiting for a phone.
This did not exercise the iOS or Android app on a physical handset.

To undo this scoped receiver update, restore the backed-up `hud/server.ts` and
`hud/index.html` into `/opt/max/rdk/agent/src/hud/`, then restart `max-agent`.
The added `hud-cast` directory is inert when the previous server is restored.
Stop `max-hud-display` to close the kiosk without affecting the receiver.

### Idle connection fix — 2026-09-18

The first prototype incorrectly used route-frame traffic as connection liveness:
the phone timed out after twelve seconds without a frame acknowledgment, and the
receiver released the sender after thirty seconds without a new frame. A quiet
GPS stream could therefore disconnect a healthy Wi-Fi connection and rotate its
code. Both native senders now exchange a separate heartbeat; only real navigation
frames refresh the displayed guidance. A missing frame acknowledgment still times
out independently, so heartbeat replies cannot hide a stuck frame transfer.

The revised receiver passed a 76-second real-LAN test on the RDK with one synthetic
route frame followed only by heartbeats: pairing remained active, the guidance
stayed marked stale, and explicit stop released the display. The revised signed
iOS app was installed and launched on the connected iPhone. Three iOS casting
tests, the Android unit suite/debug build, and receiver regression tests passed.
The iOS screen-awake policy now includes active casting as well as hands-free.
Manual locking/backgrounding still stops this foreground prototype.

### Detailed route display

Both phone clients include up to three upcoming maneuvers in each navigation
frame. The receiver validates the optional geometry and distances before passing
them to the display. Follow mode keeps the rider centered, with a 250–1,500 m
view radius based on the next maneuver; overview fits the complete route. Map
labels show the destination, rider/last-known position and numbered maneuvers.
The map is a route schematic, not a street basemap, and introduces no map SDK or
external tile requests. ETA is anchored to fresh frames rather than drifting
with display polling; stale frames hide the arrival estimate and upcoming-turn
list. Brightness stays constant throughout.
