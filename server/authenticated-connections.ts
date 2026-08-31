import type { WebSocket } from "ws";

export type AuthenticatedConnection = { userId: string; token: string };

const authenticatedConnections = new Map<WebSocket, AuthenticatedConnection>();

export function registerAuthenticatedConnection(client: WebSocket, connection: AuthenticatedConnection): void {
  authenticatedConnections.set(client, connection);
}

export function unregisterAuthenticatedConnection(client: WebSocket): void {
  authenticatedConnections.delete(client);
}

export function closeAuthenticatedConnections(
  matches: (connection: AuthenticatedConnection) => boolean,
  code: number,
  reason: string
): void {
  for (const [client, connection] of authenticatedConnections) {
    if (matches(connection)) client.close(code, reason);
  }
}
