import { describe, expect, it } from "vitest";
import { geminiRealtimeInput, openAiInputSettings, turnSettingProblems } from "../server/providers/live/turn-settings";

const from =
  (values: Record<string, string>) =>
  (...names: string[]) =>
    names.map((name) => values[name]?.trim()).find(Boolean);

describe("OpenAI Realtime input settings", () => {
  it("sends server VAD and nothing else when nothing is set", () => {
    expect(openAiInputSettings(false, from({}))).toEqual({
      settings: { turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
      problems: []
    });
    // The relay decides when to answer when a wake word gates the reply.
    expect(openAiInputSettings(true, from({})).settings.turn_detection).toMatchObject({ create_response: false });
  });

  it("tunes server VAD", () => {
    const { settings, problems } = openAiInputSettings(
      false,
      from({ OPENAI_VAD_THRESHOLD: "0.7", OPENAI_VAD_SILENCE_MS: "800", OPENAI_VAD_PREFIX_MS: "200" })
    );
    expect(problems).toEqual([]);
    expect(settings.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
      threshold: 0.7,
      silence_duration_ms: 800,
      prefix_padding_ms: 200
    });
  });

  it("uses semantic VAD with an eagerness, and leaves the server VAD numbers out of it", () => {
    const { settings, problems } = openAiInputSettings(
      false,
      from({ OPENAI_TURN_DETECTION: "semantic_vad", OPENAI_TURN_EAGERNESS: "LOW", OPENAI_VAD_SILENCE_MS: "800" })
    );
    expect(settings.turn_detection).toEqual({
      type: "semantic_vad",
      create_response: true,
      interrupt_response: true,
      eagerness: "low"
    });
    expect(problems).toEqual([
      "OPENAI_VAD_THRESHOLD, OPENAI_VAD_SILENCE_MS and OPENAI_VAD_PREFIX_MS apply only with server_vad"
    ]);
  });

  it("says so when eagerness is set without semantic VAD", () => {
    const { settings, problems } = openAiInputSettings(false, from({ OPENAI_TURN_EAGERNESS: "high" }));
    expect(settings.turn_detection).not.toHaveProperty("eagerness");
    expect(problems).toEqual(["OPENAI_TURN_EAGERNESS applies only with OPENAI_TURN_DETECTION=semantic_vad"]);
  });

  it("asks for noise reduction, or turns it off, only when told to", () => {
    expect(openAiInputSettings(false, from({ OPENAI_NOISE_REDUCTION: "far_field" })).settings.noise_reduction).toEqual({
      type: "far_field"
    });
    expect(openAiInputSettings(false, from({ OPENAI_NOISE_REDUCTION: "near" })).settings.noise_reduction).toEqual({
      type: "near_field"
    });
    expect(openAiInputSettings(false, from({ OPENAI_NOISE_REDUCTION: "off" })).settings.noise_reduction).toBeNull();
    expect(openAiInputSettings(false, from({})).settings).not.toHaveProperty("noise_reduction");
  });

  it("ignores values it cannot use and names them", () => {
    const { settings, problems } = openAiInputSettings(
      false,
      from({
        OPENAI_VAD_THRESHOLD: "2",
        OPENAI_VAD_SILENCE_MS: "soon",
        OPENAI_VAD_PREFIX_MS: "1.5",
        OPENAI_NOISE_REDUCTION: "loud"
      })
    );
    expect(settings).toEqual({
      turn_detection: { type: "server_vad", create_response: true, interrupt_response: true }
    });
    expect(problems).toEqual([
      "OPENAI_VAD_THRESHOLD=2 must be a number from 0 to 1",
      "OPENAI_VAD_SILENCE_MS=soon must be a whole number from 100 to 5000",
      "OPENAI_VAD_PREFIX_MS=1.5 must be a whole number from 0 to 2000",
      "OPENAI_NOISE_REDUCTION=loud is not one of near_field, far_field, off"
    ]);
  });

  it("passes on a detection type it does not know", () => {
    expect(
      openAiInputSettings(false, from({ OPENAI_TURN_DETECTION: "future_vad" })).settings.turn_detection
    ).toMatchObject({ type: "future_vad" });
  });
});

describe("Gemini Live activity detection", () => {
  it("sends nothing when nothing is set, so Gemini's defaults apply", () => {
    expect(geminiRealtimeInput(from({}))).toEqual({ problems: [] });
  });

  it("maps sensitivities and durations to Gemini's names", () => {
    expect(
      geminiRealtimeInput(
        from({
          GEMINI_START_SENSITIVITY: "low",
          GEMINI_END_SENSITIVITY: "High",
          GEMINI_VAD_SILENCE_MS: "700",
          GEMINI_VAD_PREFIX_MS: "40"
        })
      )
    ).toEqual({
      config: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          silenceDurationMs: 700,
          prefixPaddingMs: 40
        }
      },
      problems: []
    });
  });

  it("keeps what it can use and names what it cannot", () => {
    const { config, problems } = geminiRealtimeInput(
      from({ GEMINI_END_SENSITIVITY: "medium", GEMINI_VAD_SILENCE_MS: "600" })
    );
    expect(config).toEqual({ automaticActivityDetection: { silenceDurationMs: 600 } });
    expect(problems).toEqual(["GEMINI_END_SENSITIVITY=medium is not one of END_SENSITIVITY_HIGH, END_SENSITIVITY_LOW"]);
  });
});

describe("turnSettingProblems", () => {
  it("collects the problems of every backend", () => {
    expect(turnSettingProblems(from({}))).toEqual([]);
    expect(turnSettingProblems(from({ OPENAI_NOISE_REDUCTION: "x", GEMINI_START_SENSITIVITY: "y" }))).toHaveLength(2);
  });
});
