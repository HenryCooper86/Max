# Design QA — iOS-aligned web voice face

**Source visual truth**

- `docs/assets/ios-hud-idle.png`
- `docs/assets/ios-hud-active.png`
- `docs/assets/ios-captions.png`
- `docs/assets/ios-settings.png`

**Implementation**

- Local URL: `http://localhost:5173/`
- Implementation screenshot path: unavailable — the connected browser runtime reported no available browser surfaces.
- Intended comparison viewports: 390 × 844 (mobile source-aligned) and 1440 × 900 (desktop adaptation).
- States: authenticated idle face, captions open, settings open, active hands-free, and hazard alert.

**Full-view comparison evidence**

- Blocked. The iOS reference screenshots were opened and inspected, but a browser-rendered implementation screenshot could not be captured in this session. No visual match claim is made from source code alone.

**Focused region comparison evidence**

- Blocked for the same reason. The planned focused comparisons are the helmet/ring/caption centerpiece, bottom utility and mic controls, captions card, and settings header/control groups.

**Findings**

- [P1] Browser-rendered comparison evidence is missing.
  Location: authenticated web voice face and settings sheet.
  Evidence: source screenshots are available, but there is no implementation capture to place in the required combined comparison input.
  Impact: layout, crop, spacing, typography, color, icon alignment, and responsive fidelity cannot be signed off visually.
  Fix: connect an available browser surface, capture the implementation at the intended viewports and states, combine each capture with its corresponding iOS reference, fix any P0/P1/P2 differences, and repeat the comparison.

**Non-visual verification completed**

- Fonts and typography: system sans stack and explicit hierarchy are defined, but visual weight/wrapping comparison remains unverified.
- Spacing and layout rhythm: responsive desktop/mobile rules and viewport-height variants are implemented, but screenshot comparison remains unverified.
- Colors and visual tokens: existing Max green/cyan/orange/danger tokens are reused; visual sampling remains unverified.
- Image quality and asset fidelity: the existing production helmet illustration is reused; no replacement placeholder or new handcrafted asset was introduced. Render sharpness/crop remains unverified.
- Copy and content: the main face is reduced to status, helmet, captions/settings access, and start/end; operational controls remain functional inside settings.
- Accessibility: semantic buttons/nav/dialog, Escape dismissal, focus entry/return, focus trapping, focus-visible styles, reduced-motion handling, and practical tap targets are implemented.
- Engineering checks: TypeScript production build, ESLint, Prettier, dead-code analysis, 269 tests, and the 24-case fault matrix pass.

**Comparison history**

- Pass 1: blocked before visual comparison because the browser runtime returned no available browser surfaces. No visual findings were fabricated and no screenshot-driven fixes were made.

**Implementation Checklist**

- Capture authenticated idle face at 390 × 844 and 1440 × 900.
- Capture captions and settings states at matching viewports.
- Test start/end, captions, settings, Escape, backdrop close, all segmented controls, advanced testing expansion, export, clear, and sign-out.
- Check browser console errors in each primary state.
- Combine reference and implementation captures, resolve all P0/P1/P2 findings, and update this report.

**Open Questions**

- None about product intent; only the missing browser-rendered evidence blocks sign-off.

**Follow-up Polish**

- Decide after visual comparison whether the desktop helmet scale should remain source-faithful or use a slightly wider desktop crop.

**final result: blocked**
