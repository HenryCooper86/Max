# UI Language Switch Design

## Goal

Add a reliable Chinese/English interface switch for the entire web experience:
voice HUD, Settings, login, and Admin. The switch changes UI copy only; Max's
spoken replies remain controlled by the existing voice/provider settings.

## User experience

- Chinese (`zh-CN`) remains the default.
- Settings exposes a compact, keyboard-accessible `中文 / EN` segmented control.
- The selected language persists in `localStorage` and is restored on reload.
- Language changes apply immediately without changing the current surface,
  session, authentication state, or voice settings.
- Technical values and server-provided data remain intact, while labels,
  statuses, actions, empty states, errors, and accessible names use the active
  language.

## Architecture

- Add a dependency-free typed language module with the supported language
  union, dictionaries, a translation function, and persistence helpers.
- Add a `LanguageProvider`/`useLanguage` hook at the app root so all surfaces
  share one language state.
- Use explicit dictionary keys for visible copy rather than translating
  arbitrary server text at runtime.
- Keep domain labels (ride modes, scenarios, connection states, roles, review
  statuses, and metrics) in typed maps so both languages are complete and
  compile-time discoverable.
- Keep the toggle in the Settings sheet, where it is available from the voice
  HUD; the provider makes the choice apply to login and Admin after navigation.

## Scope boundaries

Included: web UI copy, accessible names, button labels, headings, helper text,
empty/loading/error states, and Admin status/role labels.

Excluded: spoken response language, server API payloads, persisted QA data,
transcript contents, user-entered text, and native Android/iOS clients.

## Verification

- Unit tests cover default Chinese behavior, persisted English restoration,
  invalid-storage fallback, and immediate toggle updates.
- Component tests cover the Settings toggle and representative voice HUD,
  login, and Admin translations.
- Full repository checks remain green, including lint, dead-code checks, tests,
  fault matrix, and production build.
- Manual responsive verification covers the toggle at desktop and mobile
  Settings-sheet sizes.
