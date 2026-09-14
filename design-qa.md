# Design QA — Web microphone voice dock

**Source visual truth**

- `/Users/admin/.codex/generated_images/019f8283-6546-74b0-9f13-0981c58d4f3f/exec-9126938d-3a12-4077-a437-9a48cd731554.png`

**Implementation**

- Local URL: `http://localhost:5173/`
- Implementation screenshot path: unavailable — the browser runtime reported that no browser surface is available.
- Intended viewport: 1487 × 1058, matching the selected generated design.
- State: authenticated, idle/offline, captions closed, settings closed.

**Full-view comparison evidence**

- Blocked. The selected generated design was opened at original resolution, but no browser-rendered implementation screenshot could be captured for the required combined comparison input.

**Focused region comparison evidence**

- Blocked. The required focused comparison is the utility-pill and voice-dock region beneath the helmet.

**Findings**

- [P1] Browser-rendered comparison evidence is missing.
  Location: `.voicePrimaryControls`, `.voiceMicButton`, and `.voiceInputSignal`.
  Evidence: the selected design is available, but there is no post-implementation browser capture at the same viewport and state.
  Impact: final spacing, optical alignment, type weight, icon scale, and signal-line fidelity cannot be signed off visually.
  Fix: connect a browser surface, capture the authenticated idle state at 1487 × 1058, combine it with the selected source design, and resolve any P0/P1/P2 differences.

**Non-visual verification completed**

- Fonts and typography: the existing system sans stack is retained; the dock uses a 0.94rem semibold label and 0.72rem shortcut.
- Spacing and layout rhythm: the control is a 310px-wide, 66px-high three-column dock with a 48px mic key and restrained 22px radius.
- Colors and visual tokens: graphite surface, existing coral mic accent, existing green active state, and muted shortcut token match the selected direction.
- Image quality and asset fidelity: the existing helmet remains unchanged. The microphone and signal use the installed Phosphor icon library; no placeholder or handcrafted asset was introduced.
- Copy and content: “开始免提”, “连接中”, and “结束免提” map to the actual session states; “空格键” reflects the existing keyboard shortcut.
- Accessibility: native button semantics, state-specific accessible labels, `aria-pressed`, focus-visible styling, and keyboard activation are preserved.
- Engineering checks: formatting, TypeScript build, ESLint, dead-code analysis, 269 tests, and the 24-case fault matrix pass.

**Comparison history**

- Pass 1: blocked before visual comparison because no browser surface was available. No screenshot-based findings were fabricated.

**Implementation Checklist**

- Capture the authenticated idle state at 1487 × 1058.
- Test hover, keyboard focus, start/connecting, active/listening, and stop states.
- Check browser console errors.
- Compare the combined source and implementation image and fix any P0/P1/P2 differences.

**Open Questions**

- None about the selected direction; only missing browser evidence blocks visual sign-off.

**Follow-up Polish**

- Decide after visual comparison whether the signal icon should remain visible while idle or fade in only during an active session.

**final result: blocked**
