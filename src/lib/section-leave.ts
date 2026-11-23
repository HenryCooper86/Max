/**
 * Cancelable event sent on `window` before the section or tab that is open
 * gives way to another. An editor with unsaved changes asks about them and
 * calls `preventDefault()` to stay.
 */
export const SECTION_LEAVE_EVENT = "admin:beforesection";

/** Asks whatever is open whether it can be left. False: it wants to stay. */
export function mayLeaveSection(scope: "section" | "project" = "section"): boolean {
  return window.dispatchEvent(new CustomEvent(SECTION_LEAVE_EVENT, { cancelable: true, detail: scope }));
}
