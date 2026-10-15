# Project evidence: MAX non-ARAS technical strengths

## Which strengths are genuinely supported by the project?

### Takeaway

The defensible differentiator is an integrated riding-assistant software system: conversational voice, result-grounded device actions, navigation, camera/media workflows, cross-device state, and engineering controls. It is not yet evidence of a production helmet outperforming competitors in acoustic quality, safety, latency, optical HUD, weight, battery, or road usability.

### Cited Findings

- The intent extractor is explicitly a pure command grammar behind an `IntentExtractor` boundary; a Doubao function-calling extractor is described as a possible later replacement. Do not portray current actions as an unconstrained autonomous LLM planner. [Grammar design](/Users/admin/doubao/server/device-actions.ts:1).
- **Result-grounded voice execution:** 15 named action types exist in the shared device-action contract: torch, volume, music, SMS, dialing, destination display, photo, recording, live look, gallery open, gallery describe, watching, navigation start/stop, shutdown. This is an architectural inventory, not 15 fully validated consumer features; dispatch is platform-specific (live look/watch/shutdown embedded, gallery describe gated iOS in this module). [Action contract](/Users/admin/doubao/server/device-actions.ts:13), [platform restrictions](/Users/admin/doubao/server/device-actions.ts:93).
- Device outcomes distinguish ok/failed/denied/unsupported; failed results truncate the model answer and replace it with a device-result-derived failure line. This is stronger evidence than a marketing claim that an LLM controls devices. [Reconciliation implementation](/Users/admin/doubao/server/device-actions.ts:694).
- **Navigation grounding:** a dedicated guard suppresses detected model-invented navigation, clears queued audio, truncates reply, and gives a route-state-specific correction only if the rider addressed MAX. The detector is heuristic; this is not proof of zero hallucinations. [Guard](/Users/admin/doubao/server/nav-fabrication-guard.ts:1).
- **Shared product architecture:** web, iOS, Android use one relay/session protocol, generated TypeScript/Kotlin/Swift event contracts. RDK adds embedded audio/camera/display operation and companion GPS. This supports a four-client architecture claim, not four production-certified products. [Capabilities](/Users/admin/doubao/README.md:40), [generated contracts](/Users/admin/doubao/README.md:62).
- **Consistent guidance:** pure shared guidance math includes route matching, progress, off-route/arrival decisions; 400/150/40 metre prompt thresholds are configured policy, not measured optimality. Mobile native ports follow same contract. [Guidance](/Users/admin/doubao/shared/guidance.ts:1), [thresholds](/Users/admin/doubao/shared/guidance.ts:41), [mobile implementations](/Users/admin/doubao/README.md:37).
- **Cross-device navigation rendering:** local Wi-Fi bench prototype transfers phone navigation state to RDK; receiver independently draws map and rider position, preserving rendering while iOS minimizes. Phone still owns GPS/routing/maneuver/audio in casting mode; separate Helmet Ride mode forwards phone GPS through relay to RDK-owned navigation. Internet required for route request/street imagery. This is screen casting/state transfer, NOT an optical helmet HUD, offline navigation, or phone independence. [Casting architecture](/Users/admin/doubao/docs/rdk-hud-casting.md:1), [limits](/Users/admin/doubao/docs/rdk-hud-casting.md:63).
- **Attention-aware interaction controls:** wake-word addressing, 12-second follow-up window capped 60 seconds after explicit MAX; riding modes alter response length; interruptible speech; vision watching defaults disabled, 40 calls/rolling hour and 120-second spoken-observation cooldown. The numbers are configuration, not proven reduction in rider distraction or operating cost. [Wake/ride features](/Users/admin/doubao/README.md:30), [governor](/Users/admin/doubao/server/vision-governor.ts:33).
- **Selective visual context:** voice-triggered live frame + rider question path and gallery description pipeline implemented; documented gallery video path sends 8 sampled frames rather than entire video. Live Ark model path remains unverified. Sampling reduces payload relative to sending full video by design, but no actual percentage/cost-saving measurement exists. [Camera/vision](/Users/admin/doubao/README.md:33), [explicit unverified parser](/Users/admin/doubao/server/vision.ts:36).
- **Personalization:** account-isolated persistent conversation context retains 24 turns and up to 12 explicitly remembered facts, with sanitized formatting. These are bounds, not learning quality or defensible data-moat metrics. [Memory constants](/Users/admin/doubao/server/user-memory.ts:48), [description](/Users/admin/doubao/docs/live-agent-testing.md:150).
- **Validation infrastructure:** durable QA evidence, SHA-256 evidence integrity, versioned policy replay and approved baselines exist. Strong internal release discipline is a credible capability; cannot claim competitors lack it because private QA is rarely publicly disclosed. [QA overview](/Users/admin/doubao/README.md:234), [hash implementation](/Users/admin/doubao/server/testing-store.ts:223).

### Inferences

- Best BP pillar 1: “A conversational interface connected to real riding tasks, with confirmations grounded in device outcomes.”
- Best pillar 2: “One coordinated assistant across phone, embedded hardware, navigation display and camera.”
- Best pillar 3: “Riding-specific interaction and validation controls, designed around interruptions, stale data and network failure.”
- Multimodal contextual assistance is an important planned differentiation but must be shown as implemented pipeline / live validation outstanding.
- Potential defensibility is accumulated integration knowledge, riding scenarios and validation corpus. No evidence reviewed establishes patents, unique proprietary foundation models, exclusive data, or proven market moat.

### Gaps

- No controlled competitor head-to-head measurements of speech recognition at speed, response p50/p95, task success, distraction, battery endurance, mass/centre of gravity, optical visibility, waterproofing or helmet certification found in reviewed material.
- No optical combiner/helmet display production specification evidenced; RDK Chromium kiosk is a bench display.

## Which numerical data can honestly appear in charts?

### Takeaway

Use software validation counts as internal engineering evidence and a clearly labelled internal audio-integration before/after chart. Do not plot thresholds, mock telemetry or synthetic AEC as real-world product performance, and do not label internal improvements as competitor superiority.

### Cited Findings

- Latest recorded repository audit on 2026-09-24: **1,724 Vitest tests**, **478 software-only RDK vision tests**, **154 Android unit tests**, **534 iOS simulator tests** (one hardware-only skipped), plus **24 fault-matrix cases**. Full numbers are repository-reported audit results, not independently rerun here. Their scope includes ARAS-related software; do NOT imply all are non-ARAS. Sum is 2,890 tests excluding fault-matrix cases, but aggregation hides heterogeneous test scope; prefer four bars and note all-project scope. [Latest audit](/Users/admin/doubao/docs/code-audit-2026-09-24.md:13), [follow-up Vitest count](/Users/admin/doubao/docs/code-audit-2026-09-24.md:34).
- A focused new researcher run on current HEAD **b7743cc**, 2026-10-04: **70 tests passed in 7 files**, 2.28 s runner duration. Exact command below; proves current software behavior under synthetic/unit fixtures only. Existing source tests are [reconciliation](/Users/admin/doubao/tests/device-reconciliation.test.ts:1), [nav guard](/Users/admin/doubao/tests/nav-fabrication-guard.test.ts:1), [vision governor](/Users/admin/doubao/tests/vision-governor.test.ts:1), [echo loop](/Users/admin/doubao/tests/rdk-echo-loop.test.ts:1), [companion synthetic end-to-end](/Users/admin/doubao/tests/rdk-companion-navigation-e2e.test.ts:1), [memory](/Users/admin/doubao/tests/user-memory.test.ts:1), [HUD cast](/Users/admin/doubao/tests/rdk-hud-cast.test.ts:1).
- **953 ms → 81 ms reference-to-microphone lag**, measured internally 2026-07-26 after pacing playback/AEC reference to actual writes. Reduction 91.5% by arithmetic. This is synchronization lag within audio processing, NOT end-to-end AI response latency or a competitor benchmark. [Measurement record](/Users/admin/doubao/rdk/README.md:315), [implementation rationale](/Users/admin/doubao/rdk/agent/src/audio/playback.ts:34).
- **24.9 ms** follow-up lag on five windows of one live conversation is explicitly not confirmed as a fix; why delay changed from 81 ms is unexplained. Exclude from headline charts. [Caveat](/Users/admin/doubao/rdk/README.md:331).
- **9.8 fps dual-camera 1080p MJPEG recording**, internally measured; useful prototype throughput number, but not competitive camera quality leadership. Current codec costs roughly 10 GB/hour/camera, H.264 binding unresolved. [Recording limits](/Users/admin/doubao/rdk/README.md:1056).
- **Full duplex** (no self-echo reply and successful talk-over interruption) confirmed together in one headset-on live session 2026-07-26. This supports bench capability, not robust high-speed riding recognition or statistical reliability. [Acceptance record](/Users/admin/doubao/rdk/README.md:226).
- Synthetic **32.7 dB ERLE** is explicitly warned against: linear fixture looked excellent while high suppression lost 22.1 dB of rider double-talk, real hardware overturned the conclusion. Do not use this as wind-noise cancellation proof. [Synthetic caveats](/Users/admin/doubao/rdk/README.md:354).
- 16 kHz mic frames / 24 kHz speech, 40 calls/hour, 120-second cooldown, 24 memory turns / 12 facts, 8 video frames, GPS freshness/accuracy cutoffs are architecture/configuration values only. [Pipeline](/Users/admin/doubao/README.md:201), [governor](/Users/admin/doubao/server/vision-governor.ts:33), [memory](/Users/admin/doubao/server/user-memory.ts:48).

Focused verification command:

```sh
npx vitest run tests/device-reconciliation.test.ts tests/nav-fabrication-guard.test.ts tests/vision-governor.test.ts tests/rdk-echo-loop.test.ts tests/rdk-companion-navigation-e2e.test.ts tests/user-memory.test.ts tests/rdk-hud-cast.test.ts
```

### Inferences

- Good chart 1: four software-test bars (1724/478/154/534), labelled recorded 24 Sep audit, entire project, unit/simulator scope; 24 deterministic fault cases as annotation. No competitor comparison implied.
- Good chart 2: 953 vs 81 ms internal audio-reference lag; subtitle “Internal integration iteration, headset prototype, July 2026; not AI response time.”
- Good visual 3: evidence maturity matrix: grounded actions/software tested; cross-device navigation/software tested & physical acceptance pending; AEC/limited live headset test; vision pipeline/software tested, live inference blocked; production helmet properties/no evidence.
- Avoid arbitrary weighted radar charts or normalized advantage scores. Feature-presence matrices should distinguish MAX code/prototype evidence from competitors’ shipped specifications and use unknown for undocumented competitor features.

### Gaps

- Original audio raw recordings and instrument logs underlying historical measurements were not located/replayed in this focused audit. Treat figures as documented internal evidence, not externally audited measurements.
- No dataset of sustained real-world assistant latency or wind-noise command success located.

## What limits and dependencies must the BP disclose?

### Takeaway

MAX is a substantial software/embedded prototype, with credible integration engineering but material live-model, physical-device and production-hardware acceptance gaps. The BP should separate current assets from validation milestones.

### Cited Findings

- Live visual reasoning remains blocked/unverified by Ark credentials; deterministic mock output is used when no configured provider exists. Never use demo descriptions as accuracy evidence. [Latest audit](/Users/admin/doubao/docs/code-audit-2026-09-24.md:20), [vision source](/Users/admin/doubao/server/vision.ts:36).
- Uses **Doubao** realtime ASR/VAD/speech model, **Volcano Ark** planned vision inference, **WebRTC APM 0.3.1** for embedded echo cancellation/noise suppression, **AMap** maps and car routes, **Open-Meteo** weather. Own strength is orchestration/integration/validation, not ownership of these base technologies. [Provider/vision](/Users/admin/doubao/README.md:34), [AEC wrapper](/Users/admin/doubao/rdk/README.md:300), [weather](/Users/admin/doubao/README.md:232).
- Wake word is relay-side gating after Doubao ASR; raw audio still goes upstream during live hands-free operation. Suppressed unaddressed speech is not emitted as transcript/stored memory/logged text, but this is NOT fully local wake-word processing. [Wake architecture](/Users/admin/doubao/README.md:228).
- Navigation uses AMap car routes, so motorcycle-restricted roads are not represented. Physical map authorization/real outdoor guidance and phone Bluetooth/AEC require further checks. [Audit gaps](/Users/admin/doubao/docs/code-audit-2026-09-24.md:24).
- Many RDK companion physical acceptance rows remain **PENDING**, including 10-minute locked-phone ride, route prompts, rerouting, network loss, fresh-fix resume and stop/unpair. [Acceptance matrix](/Users/admin/doubao/docs/rdk-ios-companion-acceptance.md:379).
- Android crash-detection state machine exists, but sensor calibration, false positives, siren routing and real notification provider delivery are unverified. Do not present as proven emergency protection. [Mobile limits](/Users/admin/doubao/docs/mobile-parity.md:46).
- Casting runs over trusted local Wi-Fi/hotspot and still needs phone/relay for routing; BLE, optical mirroring and Android locked-screen casting are not implemented by that change. [Casting limits](/Users/admin/doubao/docs/rdk-hud-casting.md:63).
- Embedded AEC board CPU measured 75.8°C vs ~71°C idle; camera thermal concerns elsewhere in README reinforce that production helmet thermal/battery/packaging cannot be inferred from RDK prototype. [AEC thermal record](/Users/admin/doubao/rdk/README.md:407).

### Inferences

- Honest investor language: “We have built and software-tested an integrated motorcycle-assistant stack. Our next validation milestones are field voice performance, live visual reasoning and helmet hardware integration.”
- Against conventional intercoms, emphasize integrated task/context workflow only where external competitor research substantiates the feature difference. Against advanced smart helmets, features such as voice, camera, crash alerts and display may be parity rather than differentiators.

### Gaps

- No defensible claims yet for safer riding, fewer accidents, best-in-class acoustic accuracy, faster than competition, longer endurance, lighter helmet or commercial readiness.
