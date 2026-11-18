/** Text generators for the Studio's Install tab. Pure, so they can be tested without a browser. */
import type { WidgetPosition } from "../../../shared/cloud-studio";

export type WidgetLook = { label: string; accent: string; position: WidgetPosition };

export type Framework = "html" | "react" | "next" | "express" | "flask";

export const FRAMEWORKS: readonly Framework[] = ["html", "react", "next", "express", "flask"];

/** Escapes text for use inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** The one-line, no-backend embed. The script auto-mounts from its data-* attributes. */
export function publicEmbedSnippet(origin: string, publicId: string, widget: WidgetLook): string {
  const base = trimOrigin(origin);
  const attributes = [`src="${base}/sdk/voice-agent.iife.js"`, `data-relay="${escapeAttribute(base)}"`];
  attributes.push(`data-project="${escapeAttribute(publicId)}"`);
  if (widget.label.trim()) attributes.push(`data-label="${escapeAttribute(widget.label.trim())}"`);
  if (/^#[0-9a-f]{6}$/i.test(widget.accent)) attributes.push(`data-accent="${escapeAttribute(widget.accent)}"`);
  if (widget.position === "bottom-left") attributes.push(`data-position="bottom-left"`);
  return `<script ${attributes.join(" ")}></script>`;
}

/** curl to mint a token, for the backend section's intro. */
export function mintTokenCurl(origin: string): string {
  return `curl -X POST ${trimOrigin(origin)}/v1/session-tokens \\\n  -H "Authorization: Bearer $MAX_PROJECT_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"userId":"user-123","context":"Plan: Pro"}'`;
}

export type FrameworkSnippets = {
  install: string;
  serverFile: string;
  server: string;
  clientFile: string;
  client: string;
};

export function frameworkSnippets(framework: Framework, origin: string): FrameworkSnippets {
  const base = trimOrigin(origin);
  const mint = `fetch("${base}/v1/session-tokens", {
    method: "POST",
    headers: {
      authorization: \`Bearer \${process.env.MAX_PROJECT_KEY}\`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ userId, context })
  })`;
  switch (framework) {
    case "html":
      return {
        install: "",
        serverFile: "server.mjs (Node 18+)",
        server: `import { createServer } from "node:http";

createServer(async (req, res) => {
  if (req.url !== "/api/voice-token") return res.writeHead(404).end();
  const userId = "user-123"; // who is signed in on your side
  const context = "Plan: Pro"; // optional facts for the agent
  const reply = await ${mint};
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(await reply.text());
}).listen(3000);`,
        clientFile: "index.html",
        client: `<script src="${base}/sdk/voice-agent.iife.js"></script>
<voice-agent relay="${base}" token-url="/api/voice-token"></voice-agent>`
      };
    case "react":
      return {
        install: "npm install max-voice-agent",
        serverFile: "server.js (Express: see the Express tab)",
        server: `// Same route as the Express tab: POST /api/voice-token returns { "token": "..." }.`,
        clientFile: "Talk.tsx",
        client: `import { useVoiceAgent } from "max-voice-agent/react";

export function Talk() {
  const { status, start, stop } = useVoiceAgent({
    url: "${base}",
    token: async () => {
      const reply = await fetch("/api/voice-token", { method: "POST" });
      return (await reply.json()).token;
    }
  });
  return (
    <button onClick={() => (status === "idle" ? start() : stop())}>
      {status === "idle" ? "Talk to us" : "End"}
    </button>
  );
}`
      };
    case "next":
      return {
        install: "npm install max-voice-agent",
        serverFile: "app/api/voice-token/route.ts",
        server: `export async function POST() {
  const userId = "user-123"; // read it from your session
  const reply = await fetch("${base}/v1/session-tokens", {
    method: "POST",
    headers: {
      authorization: \`Bearer \${process.env.MAX_PROJECT_KEY}\`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ userId })
  });
  if (!reply.ok) return Response.json({ error: "Could not start" }, { status: 502 });
  return Response.json(await reply.json());
}`,
        clientFile: "app/talk.tsx",
        client: `"use client";
import { useVoiceAgent } from "max-voice-agent/react";

export function Talk() {
  const { status, start, stop } = useVoiceAgent({
    url: "${base}",
    token: async () => {
      const reply = await fetch("/api/voice-token", { method: "POST" });
      return (await reply.json()).token;
    }
  });
  return (
    <button onClick={() => (status === "idle" ? start() : stop())}>
      {status === "idle" ? "Talk to us" : "End"}
    </button>
  );
}`
      };
    case "express":
      return {
        install: "npm install express",
        serverFile: "server.js",
        server: `import express from "express";

const app = express();

app.post("/api/voice-token", async (req, res) => {
  const userId = "user-123"; // who is signed in on your side
  const reply = await fetch("${base}/v1/session-tokens", {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.MAX_PROJECT_KEY}\`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userId })
  });
  res.status(reply.ok ? 200 : 502).json(reply.ok ? await reply.json() : { error: "Could not start" });
});

app.listen(3000);`,
        clientFile: "index.html",
        client: `<script src="${base}/sdk/voice-agent.iife.js"></script>
<voice-agent relay="${base}" token-url="/api/voice-token"></voice-agent>`
      };
    case "flask":
      return {
        install: "pip install flask requests",
        serverFile: "app.py",
        server: `import os
import requests
from flask import Flask, jsonify

app = Flask(__name__)

@app.post("/api/voice-token")
def voice_token():
    reply = requests.post(
        "${base}/v1/session-tokens",
        headers={"Authorization": "Bearer " + os.environ["MAX_PROJECT_KEY"]},
        json={"userId": "user-123"},  # who is signed in on your side
        timeout=10,
    )
    if not reply.ok:
        return jsonify(error="Could not start"), 502
    return jsonify(reply.json())`,
        clientFile: "index.html",
        client: `<script src="${base}/sdk/voice-agent.iife.js"></script>
<voice-agent relay="${base}" token-url="/api/voice-token"></voice-agent>`
      };
  }
}
