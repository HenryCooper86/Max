# UI Language Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted Chinese/English UI switch that translates the voice HUD, Settings, login, and Admin without changing spoken-language behavior.

**Architecture:** Add a dependency-free typed language module and React provider at the app root. Convert shared/domain labels first, then migrate each surface to dictionary-backed copy; keep server values, transcripts, and voice-provider behavior unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, React test renderer, Vite, localStorage.

## Global Constraints

- Chinese (`zh-CN`) remains the default.
- The switch changes UI copy only; Max's spoken replies remain controlled by existing voice/provider settings.
- Persist the selected language in `localStorage`; invalid values fall back to Chinese.
- Use explicit typed dictionary keys; never translate arbitrary server text at runtime.
- No new runtime dependency.
- Preserve current surface, authentication state, session state, voice settings, QA data, transcript contents, and native clients.

---

### Task 1: Build the typed language core

**Files:**

- Create: `src/lib/i18n.ts`
- Test: `tests/i18n.test.ts`

**Interfaces:**

- Produces `type Language = "zh-CN" | "en-US"`, `DEFAULT_LANGUAGE`, `LANGUAGE_STORAGE_KEY`, `readStoredLanguage(storage?: Storage): Language`, `createTranslator(language): (key: TranslationKey, params?: Record<string, string | number>) => string`, and typed domain-label maps.

- [ ] **Step 1: Write failing tests** for default/fallback persistence, English restoration, interpolation, and complete domain-label coverage.
- [ ] **Step 2: Run `npm test -- tests/i18n.test.ts` and confirm the missing module/API failures.**
- [ ] **Step 3: Implement the smallest typed dictionaries and storage helpers.** Include keys for shared shell copy, login, Settings, voice controls, and Admin labels needed by later tasks; use a compile-time `TranslationKey` union.
- [ ] **Step 4: Run the focused test and confirm it passes.**
- [ ] **Step 5: Commit** with `feat(i18n): add typed ui language dictionaries`.

### Task 2: Add app-wide language state and Settings toggle

**Files:**

- Create: `src/components/LanguageToggle.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/WebSettingsSheet.tsx`
- Modify: `src/styles.css`
- Test: `tests/language-toggle.test.tsx`

**Interfaces:**

- Consumes `Language`, `createTranslator`, and `readStoredLanguage` from `src/lib/i18n.ts`.
- Produces `LanguageProvider`, `useLanguage()`, and an accessible `LanguageToggle` with `中文` and `EN` buttons.

- [ ] **Step 1: Write failing provider/toggle tests** proving Chinese is default, persisted English restores, clicking EN updates both buttons and translated output immediately, and the buttons expose pressed state and accessible labels.
- [ ] **Step 2: Run `npm test -- tests/language-toggle.test.tsx` and verify RED.**
- [ ] **Step 3: Add `LanguageProvider` at the `App` root, persist changes, and expose `language`, `setLanguage`, and `t`.**
- [ ] **Step 4: Implement `LanguageToggle` and place it in the Settings header/footer where it remains visible on mobile.** Do not alter `agent` voice settings or surface state.
- [ ] **Step 5: Run focused tests and confirm GREEN.**
- [ ] **Step 6: Commit** with `feat(i18n): add persisted language switch`.

### Task 3: Translate login and voice HUD

**Files:**

- Modify: `src/components/LoginGate.tsx`
- Modify: `src/components/AccountBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/VoiceTranscript.tsx`
- Modify: `src/components/HelmetVisual.tsx`
- Test: `tests/ui-language-surfaces.test.tsx`

**Interfaces:**

- Consumes `useLanguage()` and shared translation/domain-label keys; keeps user-entered text and transcript contents untouched.

- [ ] **Step 1: Add failing assertions** for English login heading/hints/buttons, voice navigation labels, mic states, connection labels, captions controls, and accessible names.
- [ ] **Step 2: Run the focused test and confirm the assertions fail under Chinese-only copy.**
- [ ] **Step 3: Replace hard-coded UI copy with `t(...)` and typed label lookups.** Keep technical provider names, metrics, and spoken transcript text unchanged.
- [ ] **Step 4: Run the focused test and confirm GREEN in both languages.**
- [ ] **Step 5: Commit** with `feat(i18n): translate login and voice hud`.

### Task 4: Translate Settings and Admin workspaces

**Files:**

- Modify: `src/components/WebSettingsSheet.tsx`
- Modify: `src/components/admin/AdminWorkspace.tsx`
- Modify: `src/components/admin/admin-model.ts`
- Modify: `src/components/admin/AdminOverview.tsx`
- Modify: `src/components/admin/EvidenceWorkspace.tsx`
- Modify: `src/components/admin/ReleaseValidation.tsx`
- Modify: `src/components/admin/GovernanceWorkspace.tsx`
- Modify: `src/components/admin/AccountManagement.tsx`
- Modify: `src/components/AccountBar.tsx`
- Modify: `src/styles.css`
- Test: `tests/ui-language-surfaces.test.tsx`

**Interfaces:**

- Consumes `useLanguage()` and typed translation/domain-label maps from `src/lib/i18n.ts`.
- Preserves existing role authorization, navigation, mutation semantics, error ownership, responsive layout, and server data.

- [ ] **Step 1: Add failing assertions** for Settings headings/actions/statuses, Admin navigation and section headings, role/run/review labels, empty/loading/error copy, and account controls in English.
- [ ] **Step 2: Run the focused test and confirm RED.**
- [ ] **Step 3: Migrate visible copy to dictionary keys and language-aware label helpers.** For dynamic copy, use typed interpolation; leave tester IDs, issue text, notes, and transcript content as supplied.
- [ ] **Step 4: Verify the language toggle remains usable while Settings content scrolls and that changing language does not reset Admin selection or auth state.**
- [ ] **Step 5: Run focused tests and confirm GREEN.**
- [ ] **Step 6: Commit** with `feat(i18n): translate settings and admin workspace`.

### Task 5: Full verification and documentation

**Files:**

- Modify: `README.md` (language behavior and persistence note)
- Modify: `.superpowers/sdd/progress.md` if present

- [ ] **Step 1: Run `npm run check` and fix only regressions caused by the language work.** Expected: protocol, format, lint, Knip, all tests, fault matrix, and build pass.
- [ ] **Step 2: Run `git diff --check`.**
- [ ] **Step 3: Perform manual responsive verification** at desktop and mobile Settings sizes: toggle visible, focusable, announces pressed state, and English copy appears on voice, login, Settings, and Admin surfaces.
- [ ] **Step 4: Update README with the supported UI languages and the UI-only scope.**
- [ ] **Step 5: Commit** with `docs: document ui language switch` if documentation changed.
- [ ] **Step 6: Request an independent whole-branch review before claiming completion.**
