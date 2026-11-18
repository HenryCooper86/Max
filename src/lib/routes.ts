// Top-level surfaces. The public landing page is the root; the assistant app
// (sign-in gate, voice HUD, Testing and Admin workspaces) lives under /app;
// the public configurator is /build, and what it costs is /pricing. The relay serves index.html for every
// path, so this is decided in the browser before anything heavy loads.

type Surface = "landing" | "build" | "pricing" | "app" | "console";

export const APP_PATH = "/app";
export const BUILD_PATH = "/build";
export const PRICING_PATH = "/pricing";
export const CONSOLE_PATH = "/console";
/** The public repository. */
export const REPOSITORY_URL = "https://github.com/HenryCooper86/Max";

export type Route = { surface: Surface; redirect?: string };

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Which surface a location shows. A bookmark from before the landing page
 *  existed (`/#/admin/...`, `/#/testing/...`) is sent to the same hash
 *  under /app so testers' links keep working. */
export function resolveRoute(location: { pathname: string; hash: string; search?: string }): Route {
  const path = normalizePath(location.pathname);
  if (path === APP_PATH || path.startsWith(`${APP_PATH}/`)) return { surface: "app" };
  if (path === CONSOLE_PATH || path.startsWith(`${CONSOLE_PATH}/`)) return { surface: "console" };
  if (path === BUILD_PATH) return { surface: "build" };
  if (path === PRICING_PATH) return { surface: "pricing" };
  if (path === "/" && /^#\/(admin|testing)(\/|\?|$)/.test(location.hash)) {
    return { surface: "app", redirect: `${APP_PATH}${location.search ?? ""}${location.hash}` };
  }
  return { surface: "landing" };
}
