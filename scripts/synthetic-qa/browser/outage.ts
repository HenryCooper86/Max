/** Application close code deliberately distinct from the relay's terminal idle close. */
export function closeForSyntheticOutage(socket: Pick<WebSocket, "close">): void {
  socket.close(4999, "synthetic QA transport outage");
}
