# Phone navigation on the RDK display

The Wi-Fi bench prototype sends the phone's active navigation state to the RDK.
With `AMAP_API_KEY` configured on the RDK, the receiver loads AMap street imagery
and draws the route, position and compass direction independently. Detailed maps
therefore continue while iOS is minimized. Position updates use a local SSE stream
instead of waiting for screenshot capture or the polling fallback. The phone
still owns GPS, routing, maneuver timing and navigation audio.

The server-only Web Service key is reused from the project's existing AMap setup.
On the test board it is in `/etc/max/hud-map.env` (0600), loaded by a systemd
`max-agent` drop-in. It is never served to the browser or committed. Street imagery
requires RDK internet access. Images remain in memory, recenter after approximately
90 horizontal or 70 vertical pixels of travel, and refresh at most once every
three seconds. The rider marker updates independently on each received GPS fix.
During a provider outage, the last geographic image remains visible; if no image
has loaded, native iOS images or the route schematic remain the fallback.

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
   distance and remaining ETA agree with the phone. The detailed RDK map is north-up,
   with a compass direction arrow around the rider. Phone layout and zoom do not
   affect it. iOS coordinates are converted from WGS-84 to GCJ-02 at the cast
   boundary; Android already uses GCJ-02. Street imagery does not contain a baked-in
   rider, so fresh positions can be drawn immediately. Native screenshot sharing is
   skipped only after a successful receiver map load is advertised with
   `mapMode: "streets"` on an acknowledgment.
7. Tap **停止投屏** or end navigation to stop. iOS keeps sending navigation
   and heartbeats when minimized, using background location during navigation.
   Native iOS rendering pauses in the background, but the RDK street map and
   live position updates continue independently.
   Android still stops sharing when backgrounded.
   On Wi-Fi loss, reconnect explicitly using the new code. Casting does not
   resume automatically after a network disconnection, force-quit or board restart.

The phone still needs its existing relay/internet access to request routes.
The phone-to-HUD transfer itself stays on the local network. RDK-hosted access
point mode, BLE, automatic address discovery, optical mirroring and locked-screen
casting on Android are not implemented by this change.

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
  Legacy native map snapshots have independent acknowledgments and expire after
  five seconds. RDK-loaded street imagery stays visible; stale GPS still changes
  the position marker to last-known and suppresses live maneuver instructions. iOS disables automatic location pauses
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
phone captures only the consented dedicated HUD map view, not other app content. One
snapshot is in flight at a time. The local-only `/cast/map` endpoint serves the
latest image; `/cast/state` advertises `mapSequence` while it is recent. Images
are memory-only, cleared on disconnect and unavailable when guidance is stale.
The whole snapshot is fitted without cropping provider attribution. Native map
capture requires a real iOS device; simulator tests cover heading math, route
movement and transport behavior, not native map capture or sensor performance.

The receiver advertises `mapMode: "streets"` on `hud.ack` after imagery has
loaded successfully (or `hud.ready` if already available). iOS then
sends small `hud.heading` messages (`heading` in degrees [0,360)), acknowledged by
`hud.heading.ack`, instead of map JPEGs. Neither compass nor basemap updates refresh
GPS freshness. `/cast/events` pushes state to local displays immediately, while
polling remains a recovery fallback. `/cast/basemap?v=<sequence>` serves the
matching image for the metadata in `state.basemap`. Both endpoints are loopback-only.

## Acceptance record

2026-09-18 independent street-map update: the provider IP allowlist has been
updated. Direct requests from the RDK now return HTTP 200 PNG street imagery.
A 12-second board fixture retained streets without any phone screenshots and
measured 17 ms from sending a position to receiving its SSE update. This excludes
phone GPS acquisition and is not an end-to-end latency guarantee. No relay code
was changed.

### Idle dashboard

When no route is shared, the display shows the RDK's local time and date, weather,
connection status and a compact pairing panel. Stopping sharing clears the route
and immediately broadcasts the idle state. Weather refreshes every ten minutes
using the existing server-side AMap key. Initial city lookup uses the network IP;
navigation can subsequently select the rider's city. Only the city and weather
remain in memory after sharing ends; raw GPS coordinates are not retained by the
weather service. The dashboard labels the city source and provider report time.
Unavailable weather shows a placeholder; cached data is marked old after thirty
minutes without a successful fetch or a provider report older than three hours.
Weather failures back off for one minute and do not interrupt navigation.

Verification: all 1,704 repository tests and the full local check command passed.
Browser layouts were inspected at 800×480 and 390×844, and the physical RDK
desktop at 1920×1080 showed live weather. A board fixture confirmed street maps
without phone snapshots, then returned to idle with weather retained after stop.

The independent 800×600 HUD renderer was tested on the connected iPhone on
2026-09-18. A real SDK snapshot was captured and inspected for route, rider marker,
fixed 4:3 aspect ratio and AMap attribution. Simulator checks cover navigation-scoped
background location start/stop. Sustained background transport and lock-screen
endurance still require a live navigation trial on the phone.

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
iOS background navigation now keeps the transport active; map-image capture is
foreground-only. Physical lock/background endurance must be verified on device.

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
