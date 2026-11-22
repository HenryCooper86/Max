import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { loginUser, logoutSession, registerUser, resetAccounts, sessionUser } from "../server/accounts";
import {
  closeAuthenticatedConnections,
  registerAuthenticatedConnection,
  unregisterAuthenticatedConnection
} from "../server/authenticated-connections";

// The registry is what turns logout, password changes, account deletion and
// session expiry into closed sockets. A socket it misses keeps a revoked
// login talking to the voice line until the client hangs up.

function fakeSocket() {
  return { close: vi.fn() } as unknown as WebSocket & { close: ReturnType<typeof vi.fn> };
}

const registered: WebSocket[] = [];
function track(client: WebSocket, connection: { userId: string; token: string }) {
  registered.push(client);
  registerAuthenticatedConnection(client, connection);
}

afterEach(() => {
  for (const client of registered.splice(0)) unregisterAuthenticatedConnection(client);
  resetAccounts();
});

describe("authenticated connection registry", () => {
  it("closes only the sockets the predicate selects, with the given code and reason", () => {
    const mine = fakeSocket();
    const mineOtherDevice = fakeSocket();
    const someoneElse = fakeSocket();
    track(mine, { userId: "u1", token: "sess_a" });
    track(mineOtherDevice, { userId: "u1", token: "sess_b" });
    track(someoneElse, { userId: "u2", token: "sess_c" });

    closeAuthenticatedConnections((connection) => connection.token === "sess_a", 1008, "signed out");
    expect(mine.close).toHaveBeenCalledWith(1008, "signed out");
    expect(mineOtherDevice.close).not.toHaveBeenCalled();
    expect(someoneElse.close).not.toHaveBeenCalled();

    // Password change: every session of the user except the one that changed it.
    closeAuthenticatedConnections(
      (connection) => connection.userId === "u1" && connection.token !== "sess_a",
      1008,
      "session revoked"
    );
    expect(mineOtherDevice.close).toHaveBeenCalledWith(1008, "session revoked");
    expect(someoneElse.close).not.toHaveBeenCalled();
  });

  it("forgets a socket once it is unregistered", () => {
    const client = fakeSocket();
    track(client, { userId: "u1", token: "sess_a" });
    unregisterAuthenticatedConnection(client);
    closeAuthenticatedConnections(() => true, 1008, "signed out");
    expect(client.close).not.toHaveBeenCalled();
  });

  it("closes the sockets of a logged-out session in the sweep the relay runs", async () => {
    await registerUser("rider", "password123");
    const phone = await loginUser("rider", "password123");
    const helmet = await loginUser("rider", "password123");
    expect(phone.ok && helmet.ok).toBe(true);
    if (!phone.ok || !helmet.ok) return;
    const phoneSocket = fakeSocket();
    const helmetSocket = fakeSocket();
    track(phoneSocket, { userId: phone.user.id, token: phone.token });
    track(helmetSocket, { userId: helmet.user.id, token: helmet.token });

    expect(logoutSession(phone.token)).toBe(true);
    // Same predicate as the relay's periodic sweep in server/index.ts.
    closeAuthenticatedConnections((connection) => !sessionUser(connection.token), 1008, "session expired");
    expect(phoneSocket.close).toHaveBeenCalledWith(1008, "session expired");
    expect(helmetSocket.close).not.toHaveBeenCalled();
  });
});
