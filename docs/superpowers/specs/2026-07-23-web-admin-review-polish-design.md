# Web Admin Review and Polish Design

Date: 2026-07-23

## Summary

Review the web and server code for reproducible defects, logic errors, stale branches, and dead code, then polish the testing Admin experience into a dedicated, full-width workspace. The work keeps the existing authentication model, QA data, release authority, and server contracts while improving operational clarity, responsive behavior, error feedback, and maintainability.

## Scope

This pass covers:

- The React web client in `src/`.
- The Node/Express relay and Admin endpoints in `server/`.
- Shared TypeScript contracts and helpers used by those surfaces.
- The web testing and Admin experience, including account management, release validation, evidence review, issue triage, policy management, and audit history.
- The JavaScript/TypeScript quality gates and focused browser verification.

This pass does not redesign or modify the native iOS or Android applications. Native protocol compatibility must remain intact, and the generated protocol check must continue to pass.

## Current State

The Admin console is currently lazy-loaded inside the final expandable section of an 820-pixel settings sheet. It exposes substantial operational capability, but its long, nested flow makes release and evidence work cramped and difficult to scan. `TestingAdminPanel.tsx` also holds more than one thousand lines of unrelated responsibilities, including summary loading, filters, session selection, exports, destructive actions, release insights, tables, evidence details, and reviewer notes.

The initial baseline produced the following evidence:

- ESLint passes.
- Knip reports no unused exports, files, or dependencies.
- Vitest passes 281 tests across 30 files.
- The 24-case testing fault matrix passes.
- TypeScript and the Vite production build pass.
- The aggregate `npm run check` command stops at Prettier because six tracked `.superpowers/sdd` workflow-note files do not satisfy the formatter.

Knip's clean result does not rule out unreachable branches, stale React state, redundant presentation logic, or behavior that is technically referenced but no longer useful. Those categories remain in scope for the review.

## Approved Product Decisions

- Prioritize a balanced combination of workflow clarity and visual refinement.
- Move testing and management out of the constrained settings sheet into a dedicated, full-width in-app workspace.
- Keep the workspace in the existing application instead of adding a standalone `/admin` route.
- Use consistent Chinese-first interface copy while retaining standard technical terms such as QA, ASR, build, PASS, WATCH, and FAIL where they improve recognition.
- Keep the existing night-instrument character: dark calm surfaces, restrained green live/ready states, amber warnings, red failures, and high-glanceability typography.
- Preserve role-scoped access and all existing QA capabilities.

## Navigation and Workspace Architecture

`App` will own one explicit top-level view state with three valid values:

- `voice` — the normal helmet assistant.
- `settings` — the existing rider settings sheet.
- `admin` — the dedicated testing and management workspace.

Using one state prevents Settings and Admin from being open at the same time. Opening Admin from Settings closes the sheet and lazy-loads the Admin bundle. Returning to Max restores the voice surface without recreating the agent hook, authentication state, or active relay session. Signing out or receiving an explicit authentication failure resets the view to the login gate.

The Admin workspace contains:

1. A persistent header with the MAX QA identity, relay/build freshness, signed-in user and role, and a clear return-to-Max action.
2. Responsive primary navigation for Overview, Release Validation, Evidence & Issues, Account Management, and Policy & Audit.
3. A full-width content region with stable section state and a consistent maximum reading width.
4. A desktop sidebar that becomes a compact horizontal section bar at narrow widths.

The workspace must be useful at reviewer and tester permission levels rather than behaving as an administrator-only shell. Navigation and actions are filtered by capability:

- Testers can access their own assignments and evidence.
- Reviewers can inspect the full permitted corpus and perform review work.
- Administrators can additionally manage accounts, approve releases, publish policies, and perform destructive operations.

## Component Boundaries

The current Admin monolith will be separated by responsibility under `src/components/admin/`:

- `AdminWorkspace.tsx` — shell, responsive navigation, role-aware section availability, sync status, and return action.
- `AdminOverview.tsx` — release-gate state, regression state, evidence health, current build, prioritized work queue, and recent release progress.
- `ReleaseValidation.tsx` — release runs, assignments, coverage, approval state, and baseline comparison.
- `EvidenceWorkspace.tsx` — tester/session filtering, pagination, evidence detail, deterministic evaluation, reviewer notes, and issue triage.
- `AccountManagement.tsx` — users, invitations, roles, expiry warnings, and protected deletion.
- `GovernanceWorkspace.tsx` — active/versioned policies and operational history.
- `useAdminTestingData.ts` — summary refresh, session pages, on-demand session detail, selected evidence, mutation refresh, and typed request failures.
- `admin-model.ts` — pure navigation, permissions, status-label, filtering, and request-state rules shared by the workspace sections.

Each unit must have one clear purpose and avoid duplicating permission, status-label, formatting, or request-state rules.

## Data Flow

The existing server remains authoritative. The redesign does not introduce a second Admin data model.

1. Entering the workspace fetches the testing summary and the first evidence page.
2. Role-permitted release, policy, review, audit, and account data load for the section that consumes them.
3. Evidence details load only after selection and are cached for the current workspace session.
4. Pagination appends unique evidence records and preserves the current selection.
5. Filters and selected evidence survive navigation between workspace sections.
6. Mutations refresh only the affected domain and update the visible last-sync state.
7. Assignment selection continues to update the shared agent testing context for the next voice session.
8. No raw microphone audio is added to storage or Admin transport.

Existing HTTP endpoints and shared response shapes stay compatible unless the code review confirms a contract defect. Any such contract correction requires a regression test and must preserve native-client protocol behavior.

## Error and Mutation Behavior

Admin requests will expose typed outcomes instead of collapsing every failure to `null`. The UI must distinguish:

- Authentication expiry or revocation: explain that the session expired and return through the existing login flow.
- Insufficient permission: keep readable content where allowed and explain which role is required for the blocked action.
- Relay/network unavailability: retain already loaded evidence, show stale/sync state, and offer a retry.
- Server validation failure: display the server-provided safe error beside the initiating workflow.
- Empty data: explain the next useful action instead of showing a generic loading message indefinitely.
- In-flight mutation: disable only the affected action and prevent duplicate submission.
- Successful mutation: update the affected data and announce the result without losing the user's current section or filters.

Destructive operations keep a two-step confirmation. The second step must name the target and expire automatically. Account and authorization constraints continue to be enforced server-side regardless of client presentation.

## Visual and Interaction Design

The approved concept uses a calm, high-density operational hierarchy:

- Four concise overview metrics: release gate, review queue, valid evidence, and p95 first-audio latency.
- A risk-sorted action queue that leads operators directly to blocked releases, unsafe evidence, missing coverage, or incomplete policy work.
- Secondary release progress rather than duplicating every detailed control on the overview.
- Clear surface elevation, restrained borders, consistent card radii, and fewer competing accent colors.
- Green for healthy/live, amber for caution or incomplete work, red for failure or destructive state, and neutral ink for metadata.
- Chinese-first labels and messages with stable technical abbreviations retained where operators already recognize them.
- Destructive actions appear only in their relevant detail sections, not in the overview's primary hierarchy.

All interactive controls need visible keyboard focus. Section changes, notices, and mutation results use appropriate accessible names and live-region semantics without creating excessive announcements. Reduced-motion preferences disable nonessential animation. Focus returns to the Admin entry control after leaving the workspace.

## Code Review and Remediation Method

The review focuses on web/server failure-prone paths:

- Authentication, credential precedence, session expiry, and logout behavior.
- Role enforcement across both client affordances and server endpoints.
- Async request races, stale state, pagination, filtering, and session selection.
- Admin mutation validation, duplicate submission, destructive confirmation, and refresh behavior.
- Server input validation, persistence failure handling, and session cleanup.
- Shared formatting, status mapping, and derived metric logic.
- Unreachable branches, stale React state/effects, redundant presentation helpers, and genuinely unused code.

Every behavior change follows a root-cause and regression-test workflow:

1. Reproduce the failure or prove the stale path.
2. Trace the value or state to its source.
3. Compare with a working repository pattern.
4. State one root-cause hypothesis.
5. Add the smallest failing test that proves the issue.
6. Implement the smallest production fix.
7. Run the focused test, then the broader relevant suite.

Speculative refactors and unrelated feature additions are excluded. Code is removed only when reference analysis and behavior coverage show that removal is safe.

## Testing Strategy

### Automated

- Add focused unit tests for pure workspace navigation, permission, status, filtering, request-result, and mutation-state rules introduced by the redesign.
- Add a regression test before every confirmed bug fix.
- Add server integration coverage for any corrected endpoint validation, role enforcement, or error response.
- Preserve all existing tests and protocol generation.
- Keep Knip clean after component extraction and dead-code removal.

### Browser verification

Verify the real Admin workspace with representative data at:

- Desktop width with sidebar navigation.
- Tablet width with compressed content and no horizontal page overflow.
- Narrow mobile width with the compact section bar and single-column work areas.

Exercise Admin, reviewer, and tester roles; keyboard-only navigation; focus restoration; empty, loading, offline, unauthorized, and mutation states; evidence pagination; filters; destructive confirmation; and reduced-motion behavior.

### Full acceptance commands

The final pass must run:

```bash
npm run check:protocol
npm run format:check
npm run lint
npm run check:dead-code
npm test
npm run test:fault-matrix
npm run build
```

The aggregate `npm run check` must also complete successfully after its formatting-scope issue is resolved.

## Acceptance Criteria

- Testing and management open as a dedicated, lazy-loaded, full-width in-app workspace.
- Returning to Max preserves the agent and authentication state.
- The workspace implements the approved responsive navigation and overview hierarchy.
- All existing Admin capabilities remain reachable at the correct permission level.
- Chinese-first copy is consistent across the redesigned surface.
- Request errors are distinguishable and actionable.
- Pagination, filters, selection, and mutation feedback remain stable across section navigation.
- Destructive actions remain server-authorized and require target-specific confirmation.
- Confirmed defects have regression tests that fail before and pass after their fixes.
- Proven dead code and stale branches are removed without changing unrelated behavior.
- Desktop, tablet, narrow-mobile, keyboard, focus, and reduced-motion verification pass.
- All acceptance commands and the aggregate repository check exit successfully.

## Non-Goals

- Redesigning the rider voice HUD or ordinary settings cards.
- Adding a router or public `/admin` URL.
- Changing native iOS or Android UI.
- Replacing deterministic evaluation with model-based release authority.
- Retaining raw microphone audio.
- Adding new release-management features unrelated to clarity, correctness, or the confirmed review findings.
