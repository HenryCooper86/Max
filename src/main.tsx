import React, { lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveRoute } from "./lib/routes";
import "./styles.css";

declare global {
  interface Window {
    __helmetMaxRoot?: Root;
  }
}

// Each surface is its own chunk: the public landing page never downloads the
// assistant app (voice session, workspaces), and the app never downloads the
// landing page.
const AssistantApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
const PublicSite = lazy(() => import("./landing/PublicSite").then((module) => ({ default: module.PublicSite })));

const route = resolveRoute(window.location);
if (route.redirect) window.history.replaceState(null, "", route.redirect);

const rootElement = document.getElementById("root")!;
const root = window.__helmetMaxRoot ?? createRoot(rootElement);
window.__helmetMaxRoot = root;

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<main className="loginShell" aria-busy="true" />}>
        {route.surface === "app" ? <AssistantApp /> : <PublicSite view={route.surface} />}
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>
);
