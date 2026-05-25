import type { RawData, WebSocket } from "ws";
import type { AgentProvider, ClientEvent } from "./providers/types";

export type ProviderFactory = (client: WebSocket) => AgentProvider;

export class AgentSessionController {
  private readonly provider: AgentProvider;

  constructor(
    private readonly client: WebSocket,
    providerFactory: ProviderFactory
  ) {
    this.provider = providerFactory(client);
    this.send({ type: "connection", state: "relay", detail: "语音中继 WebSocket 已连接" });
  }

  async handleMessage(data: RawData, isBinary: boolean) {
    try {
      if (isBinary) {
        await this.provider.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }

      const event = JSON.parse(data.toString()) as ClientEvent;
      if (event.type === "session.start") await this.provider.start(event);
      if (event.type === "audio.start") await this.provider.startAudio();
      if (event.type === "audio.stop") await this.provider.stopAudio();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice relay failed";
      this.send({ type: "error", message });
    }
  }

  async close() {
    await this.provider.close();
  }

  private send(payload: unknown) {
    if (this.client.readyState === this.client.OPEN) {
      this.client.send(JSON.stringify(payload));
    }
  }
}
