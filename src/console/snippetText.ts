/** The two things a developer pastes to put the agent in their product. */
export function mintTokenSnippet(origin: string): string {
  return `curl -X POST ${origin}/v1/session-tokens -H "Authorization: Bearer <your project key>" -H "content-type: application/json" -d '{"userId":"your-user-id"}'`;
}

export function widgetSnippet(origin: string): string {
  return `<script src="${origin}/sdk/voice-agent.iife.js"></script>\n<voice-agent relay="${origin}" token-url="/api/voice-token"></voice-agent>`;
}
