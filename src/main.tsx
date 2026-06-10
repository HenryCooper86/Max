import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

declare global {
  interface Window {
    __helmetMaxRoot?: Root;
  }
}

const rootElement = document.getElementById("root")!;
const root = window.__helmetMaxRoot ?? createRoot(rootElement);
window.__helmetMaxRoot = root;

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
