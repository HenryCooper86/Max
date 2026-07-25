import { describe, expect, it, vi } from "vitest";
import {
  createLineDecoder,
  createVisionClient,
  encodeRequest,
  isVisionResponse,
  type VisionEvent
} from "../rdk/agent/src/vision-client";

describe("encodeRequest", () => {
  it("emits one newline-terminated JSON object", () => {
    const line = encodeRequest({ id: "c7", op: "camera.photo", args: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({ id: "c7", op: "camera.photo", args: {} });
  });
});

describe("createLineDecoder", () => {
  it("decodes whole lines", () => {
    const decode = createLineDecoder();
    const out = decode('{"id":"a","status":"ok"}\n{"event":"hazard"}\n');
    expect(out.length).toBe(2);
    expect(isVisionResponse(out[0]!)).toBe(true);
    expect(isVisionResponse(out[1]!)).toBe(false);
  });

  it("buffers a partial line until it completes", () => {
    const decode = createLineDecoder();
    expect(decode('{"id":"a","sta')).toEqual([]);
    const out = decode('tus":"ok"}\n');
    expect(out).toEqual([{ id: "a", status: "ok" }]);
  });

  it("skips malformed lines rather than throwing", () => {
    const decode = createLineDecoder();
    const out = decode('not json\n{"id":"b","status":"failed"}\n');
    expect(out).toEqual([{ id: "b", status: "failed" }]);
  });

  it("ignores blank lines", () => {
    const decode = createLineDecoder();
    expect(decode("\n\n")).toEqual([]);
  });
});

describe("createVisionClient", () => {
  it("correlates a response to its request", async () => {
    const sent: string[] = [];
    const client = createVisionClient({ send: (line) => sent.push(line), onEvent: () => {} });
    const pending = client.request("camera.photo");
    const id = JSON.parse(sent[0]!.trim()).id as string;
    client.handleChunk(`${JSON.stringify({ id, status: "ok", detail: "pair-1" })}\n`);
    await expect(pending).resolves.toEqual({ id, status: "ok", detail: "pair-1" });
  });

  it("issues distinct ids", () => {
    const sent: string[] = [];
    const client = createVisionClient({ send: (line) => sent.push(line), onEvent: () => {} });
    void client.request("camera.photo");
    void client.request("camera.photo");
    const first = JSON.parse(sent[0]!.trim()).id;
    const second = JSON.parse(sent[1]!.trim()).id;
    expect(first).not.toBe(second);
  });

  it("routes unsolicited events to onEvent", () => {
    const events: VisionEvent[] = [];
    const client = createVisionClient({ send: () => {}, onEvent: (event) => events.push(event) });
    client.handleChunk('{"event":"hazard","threat":"rear_approach"}\n');
    expect(events).toEqual([{ event: "hazard", threat: "rear_approach" }]);
  });

  it("resolves as failed when the sidecar does not answer in time", async () => {
    vi.useFakeTimers();
    const client = createVisionClient({ send: () => {}, onEvent: () => {}, timeoutMs: 5000 });
    const pending = client.request("camera.record", { start: true });
    vi.advanceTimersByTime(5000);
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "capture.failed" });
    vi.useRealTimers();
  });

  it("fails every pending request when the socket dies", async () => {
    const client = createVisionClient({ send: () => {}, onEvent: () => {} });
    const pending = client.request("camera.photo");
    client.failAllPending("capture.failed");
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "capture.failed" });
  });

  it("ignores a response for an unknown id", () => {
    const client = createVisionClient({ send: () => {}, onEvent: () => {} });
    expect(() => client.handleChunk('{"id":"ghost","status":"ok"}\n')).not.toThrow();
  });
});
