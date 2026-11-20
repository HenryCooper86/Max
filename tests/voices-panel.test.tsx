import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoicesPanel, type VoicesAudio } from "../src/components/studio/VoicesPanel";
import type { SpeechVoice, VoiceResult, VoicesApi, VoicesOverview } from "../src/lib/voices-api";
import type { WavRecorder } from "../src/lib/wav-recorder";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PRESET: SpeechVoice = { id: "af_heart", name: "Heart", kind: "preset", languages: ["en"], gender: "female" };
const CUSTOM: SpeechVoice = {
  id: "v_0123456789",
  name: "Ann",
  kind: "custom",
  languages: ["zh"],
  gender: "female",
  origin: "recorded",
  created_at: "2026-11-01T10:00:00Z",
  created_by: "admin",
  consent: { speaker: "Ann Lee", statement: "I, Ann Lee, agree to this clone." }
};

type Ready = Extract<VoicesOverview, { available: true }>;
const ready = (patch: Partial<Ready> = {}): VoicesOverview => ({
  available: true,
  cloning: true,
  design: true,
  voices: [PRESET, CUSTOM],
  attributions: [{ model: "kokoro", weights_license: "Apache-2.0", text: "Kokoro-82M by hexgrad" }],
  ...patch
});
const good = <T,>(data: T): VoiceResult<T> => ({ ok: true, data });
const bad = (code: string, message = "server said no", kind: "invalid" | "unauthorized" = "invalid") =>
  ({ ok: false, error: { kind, message, code, status: 400 } }) as const;
const wav = () => new Blob(["RIFF"], { type: "audio/wav" });

function fakeApi(overrides: Partial<VoicesApi> = {}) {
  const api = {
    listVoices: vi.fn(async () => good(ready())),
    cloneVoice: vi.fn(async (input) => good({ ...CUSTOM, id: "v_aaaaaaaaaa", name: input.name })),
    updateVoice: vi.fn(async (_id: string, patch: { name?: string }) => good({ ...CUSTOM, ...patch })),
    deleteVoice: vi.fn(async () => good(undefined)),
    fetchReference: vi.fn(async () => good(wav())),
    previewVoice: vi.fn(async () => good(wav())),
    designVoice: vi.fn(async () =>
      good([
        { id: "c_000000000001", text: "t", description: "d" },
        { id: "c_000000000002", text: "t", description: "d" },
        { id: "c_000000000003", text: "t", description: "d" }
      ])
    ),
    fetchCandidateAudio: vi.fn(async () => good(wav())),
    saveCandidate: vi.fn(async (_id: string, body: { name: string }) =>
      good({ ...CUSTOM, id: "v_bbbbbbbbbb", name: body.name, origin: "designed" as const })
    ),
    getLexicon: vi.fn(async () => good({ GPU: "gee pee you" })),
    putLexicon: vi.fn(async (entries: Record<string, string>) => good(entries)),
    ...overrides
  };
  return api satisfies VoicesApi;
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

let renderer: ReactTestRenderer | undefined;
let urlCounter = 0;
const revoked: string[] = [];

beforeEach(() => {
  urlCounter = 0;
  revoked.length = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${urlCounter++}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revoked.push(url));
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

type Mounted = ReturnType<typeof fakeApi>;

async function mount(api: Mounted, props: Partial<Parameters<typeof VoicesPanel>[0]> = {}, audio?: VoicesAudio) {
  const onVoiceChange = vi.fn();
  const onAuthenticationExpired = vi.fn();
  await act(async () => {
    renderer = create(
      <VoicesPanel
        voiceId=""
        onVoiceChange={onVoiceChange}
        assistantName="Max"
        onAuthenticationExpired={onAuthenticationExpired}
        api={api}
        audio={audio}
        {...props}
      />
    );
  });
  return { onVoiceChange, onAuthenticationExpired };
}

const root = () => renderer!.root;
const text = () => textOf(root());
const button = (label: RegExp, scope: ReactTestInstance = root()) =>
  scope.find((node) => node.type === "button" && label.test(textOf(node).trim()));
/** The control a <label> points to, or one carrying the aria-label. */
function control(label: RegExp, scope: ReactTestInstance = root()): ReactTestInstance {
  const tagged = scope.findAll(
    (node) => typeof node.type === "string" && label.test(String(node.props["aria-label"] ?? ""))
  );
  if (tagged[0]) return tagged[0];
  const target = scope.find((node) => node.type === "label" && label.test(textOf(node)));
  return scope.find((node) => node.props.id === target.props.htmlFor && typeof node.type === "string");
}
const type = (label: RegExp, value: string, scope?: ReactTestInstance) =>
  act(async () => control(label, scope).props.onChange({ currentTarget: { value } }));
const consentBox = () => root().find((node) => node.type === "input" && node.props.type === "checkbox");
const click = (node: ReactTestInstance) => act(async () => node.props.onClick());
const rowOf = (name: string) =>
  root().find((node) => node.type === "li" && node.props.className === "voiceRow" && textOf(node).includes(name));

describe("VoicesPanel states", () => {
  it("shows loading until the library answers", async () => {
    let finish: (value: VoiceResult<VoicesOverview>) => void = () => undefined;
    const api = fakeApi({ listVoices: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    await mount(api);
    expect(text()).toContain("正在读取声音库");
    await act(async () => finish(good(ready())));
    expect(text()).not.toContain("正在读取声音库");
  });

  it("explains how to set up Max Speech, with the reason, when it is unavailable", async () => {
    const api = fakeApi({
      listVoices: vi.fn(async () => good<VoicesOverview>({ available: false, reason: "MAX_SPEECH_URL is not set" }))
    });
    await mount(api);
    expect(text()).toContain("MAX_SPEECH_URL is not set");
    expect(text()).toContain("启动 Max Speech");
    expect(root().findAll((node) => node.type === "select")).toHaveLength(0);
  });

  it("maps an error code to readable text, and signs out on 401", async () => {
    const api = fakeApi({ listVoices: vi.fn(async () => bad("speech_unavailable", "upstream down")) });
    await mount(api);
    expect(text()).toContain("连不上 Max Speech");
    expect(text()).not.toContain("upstream down");

    act(() => renderer?.unmount());
    const expired = fakeApi({ listVoices: vi.fn(async () => bad("", "no", "unauthorized")) });
    const { onAuthenticationExpired } = await mount(expired);
    expect(onAuthenticationExpired).toHaveBeenCalledOnce();
  });

  it("falls back to the server's message for an unknown code", async () => {
    const api = fakeApi({ listVoices: vi.fn(async () => bad("weird_code", "Something odd happened")) });
    await mount(api);
    expect(text()).toContain("Something odd happened");
  });

  it("lists custom voices with origin, creator, consent and the credits", async () => {
    await mount(fakeApi());
    const row = rowOf("Ann");
    expect(textOf(row)).toContain("录制");
    expect(textOf(row)).toContain("创建者 admin");
    expect(textOf(row)).toContain("Ann Lee");
    expect(text()).toContain("Kokoro-82M by hexgrad");
  });

  it("shows designed voices by their description and treats a missing origin as recorded", async () => {
    const designed: SpeechVoice = {
      id: "v_dddddddddd",
      name: "Warm",
      kind: "custom",
      languages: ["en"],
      origin: "designed",
      design: { description: "a warm older voice", seed: 7, model: "m", text: "hi" }
    };
    const legacy: SpeechVoice = { ...CUSTOM, id: "v_eeeeeeeeee", name: "Old", origin: undefined };
    await mount(
      fakeApi({ listVoices: vi.fn(async () => good(ready({ voices: [PRESET, CUSTOM, designed, legacy] }))) })
    );
    expect(textOf(rowOf("Warm"))).toContain("设计：a warm older voice");
    expect(textOf(rowOf("Warm"))).not.toContain("Ann Lee");
    expect(textOf(rowOf("Old"))).toContain("录制");
    expect(textOf(rowOf("Old"))).toContain("Ann Lee");
  });

  it("shows empty states and hides cloning and design when the server lacks them", async () => {
    await mount(
      fakeApi({
        listVoices: vi.fn(async () =>
          good(ready({ voices: [PRESET], cloning: false, design: false, attributions: [] }))
        )
      })
    );
    expect(text()).toContain("还没有自定义声音");
    expect(text()).toContain("没有开启声音克隆");
    expect(text()).not.toContain("设计声音");
    expect(text()).toContain("暂无模型署名");
  });
});

describe("assistant voice picker", () => {
  it("offers Default, presets and custom voices, and reports the choice", async () => {
    const { onVoiceChange } = await mount(fakeApi());
    const select = control(/助手的声音/);
    expect(select.findAll((node) => node.type === "option").map(textOf)).toEqual([
      "默认",
      "Heart · 英语",
      "Ann · 录制"
    ]);
    expect(select.findAll((node) => node.type === "optgroup").map((node) => node.props.label)).toEqual([
      "内置声音",
      "自定义声音"
    ]);
    await act(async () => select.props.onChange({ currentTarget: { value: CUSTOM.id } }));
    expect(onVoiceChange).toHaveBeenCalledWith(CUSTOM.id);
  });

  it("plays a preview for a preset voice", async () => {
    const api = fakeApi();
    await mount(api, { voiceId: PRESET.id });
    const play = button(/^试听$/, control(/助手的声音/).parent!.parent!);
    expect(play.props.disabled).toBeFalsy();
    await click(play);
    expect(api.previewVoice).toHaveBeenCalledWith(PRESET.id);
    expect(text()).not.toContain("目前只支持自定义声音");
  });

  it("plays a preview for a custom voice and keeps an unknown stored id visible", async () => {
    const api = fakeApi();
    await mount(api, { voiceId: CUSTOM.id });
    await click(button(/^试听$/, control(/助手的声音/).parent!.parent!));
    expect(api.previewVoice).toHaveBeenCalledWith(CUSTOM.id);
    expect(
      root()
        .findAll((node) => node.type === "audio")
        .map((node) => node.props.src)
    ).toContain("blob:test/0");

    act(() => renderer?.unmount());
    await mount(api, { voiceId: "v_gone000000" });
    expect(textOf(control(/助手的声音/))).toContain("v_gone000000");
  });
});

describe("clone a voice", () => {
  const fileAudio = (seconds: number): VoicesAudio => ({
    getStream: vi.fn(),
    createRecorder: vi.fn(),
    decodeFile: vi.fn(async () => ({ samples: new Float32Array(seconds * 8000), sampleRate: 8000 }))
  });
  const upload = (file: Blob = new Blob(["x"])) =>
    act(async () => {
      const input = root().find((node) => node.type === "input" && node.props.type === "file");
      input.props.onChange({ currentTarget: { files: [file], value: "x" } });
    });
  const submit = () => button(/^克隆声音$/);

  it("keeps Clone disabled until name, audio, speaker, statement and consent are all in", async () => {
    await mount(fakeApi(), {}, fileAudio(6));
    expect(submit().props.disabled).toBe(true);
    expect(text()).toContain("还需要");
    await type(/^名称$/, "Ann");
    await upload();
    expect(text()).toContain("已准备好 6.0 秒");
    expect(submit().props.disabled).toBe(true);
    await type(/说话人姓名/, "Ann Lee");
    expect(submit().props.disabled).toBe(true);
    await act(async () => consentBox().props.onChange({ currentTarget: { checked: true } }));
    expect(submit().props.disabled).toBe(false);
    await type(/同意声明/, "too short");
    expect(submit().props.disabled).toBe(true);
    expect(text()).toContain("同意声明至少 20 个字符");
  });

  it("states that only the person's own or a permitted voice may be cloned", async () => {
    await mount(fakeApi(), {}, fileAudio(6));
    expect(text()).toContain("书面许可");
  });

  it("rejects audio outside 5 to 30 seconds", async () => {
    const api = fakeApi();
    await mount(api, {}, fileAudio(3));
    await upload();
    expect(text()).toContain("至少需要 5 秒");
    act(() => renderer?.unmount());
    await mount(api, {}, fileAudio(45));
    await upload();
    expect(text()).toContain("太长了");
    expect(submit().props.disabled).toBe(true);
  });

  it("prefills the statement with the speaker and assistant, and sends the whole request", async () => {
    const api = fakeApi();
    await mount(api, { assistantName: "Iris" }, fileAudio(6));
    await type(/^名称$/, "  Bea ");
    await type(/说话人姓名/, "Ann Lee");
    expect(control(/同意声明/).props.value).toBe("我，Ann Lee，同意我的声音被录制并克隆，供“Iris”助手使用。");
    await upload();
    await act(async () => consentBox().props.onChange({ currentTarget: { checked: true } }));
    await click(submit());
    expect(api.cloneVoice).toHaveBeenCalledOnce();
    const sent = api.cloneVoice.mock.calls[0]![0];
    expect(sent).toMatchObject({
      name: "Bea",
      gender: "neutral",
      languages: ["zh"],
      consentSpeaker: "Ann Lee",
      consentStatement: "我，Ann Lee，同意我的声音被录制并克隆，供“Iris”助手使用。"
    });
    expect(sent.transcript).toBeUndefined();
    expect(sent.audio.type).toBe("audio/wav");
    expect(sent.audio.size).toBe(44 + 6 * 8000 * 2);
    expect(text()).toContain("已创建声音“Bea”");
    expect(rowOf("Bea")).toBeTruthy();
    // The form is cleared for the next voice.
    expect(submit().props.disabled).toBe(true);
  });

  it("shows a readable message when the server refuses the recording", async () => {
    const api = fakeApi({ cloneVoice: vi.fn(async () => bad("reference_silent")) });
    await mount(api, {}, fileAudio(6));
    await type(/^名称$/, "Ann");
    await type(/说话人姓名/, "Ann Lee");
    await upload();
    await act(async () => consentBox().props.onChange({ currentTarget: { checked: true } }));
    await click(submit());
    expect(text()).toContain("几乎没有声音");
  });

  it("records from the microphone with a timer and level, then stops", async () => {
    let onProgress: (progress: { level: number; seconds: number }) => void = () => undefined;
    const recorder: WavRecorder = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ blob: wav(), seconds: 7 })),
      cancel: vi.fn()
    };
    const track = { stop: vi.fn() };
    const audio: VoicesAudio = {
      getStream: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
      createRecorder: vi.fn((options) => {
        onProgress = options.onProgress;
        return recorder;
      }),
      decodeFile: vi.fn()
    };
    await mount(fakeApi(), {}, audio);
    await click(button(/^开始录音$/));
    expect(recorder.start).toHaveBeenCalled();
    await act(async () => onProgress({ level: 0.5, seconds: 3 }));
    const meter = root().find((node) => node.props.role === "meter");
    expect(meter.props["aria-valuenow"]).toBe(50);
    expect(text()).toContain("3 / 30 s");
    await click(button(/^停止录音$/));
    expect(recorder.stop).toHaveBeenCalled();
    expect(text()).toContain("已准备好 7.0 秒");
  });

  it("releases the recorder if the panel unmounts mid-recording, and explains a refused microphone", async () => {
    const recorder: WavRecorder = { start: vi.fn(async () => undefined), stop: vi.fn(), cancel: vi.fn() };
    const audio: VoicesAudio = {
      getStream: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
      createRecorder: vi.fn(() => recorder),
      decodeFile: vi.fn()
    };
    await mount(fakeApi(), {}, audio);
    await click(button(/^开始录音$/));
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(recorder.cancel).toHaveBeenCalled();

    const denied: VoicesAudio = { ...audio, getStream: vi.fn(async () => Promise.reject(new Error("denied"))) };
    await mount(fakeApi(), {}, denied);
    await click(button(/^开始录音$/));
    expect(text()).toContain("无法使用麦克风");
  });
});

describe("microphone", () => {
  it("asks for the raw microphone, with no browser processing, for a cloning reference", async () => {
    const getUserMedia = vi.fn(async () => Promise.reject(new Error("denied")));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    try {
      await mount(fakeApi());
      await click(button(/^开始录音$/));
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        })
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops the microphone that arrives after the panel was closed", async () => {
    let arrive: (stream: MediaStream) => void = () => undefined;
    const track = { stop: vi.fn() };
    const audio: VoicesAudio = {
      getStream: vi.fn(() => new Promise<MediaStream>((resolve) => (arrive = resolve))),
      createRecorder: vi.fn(),
      decodeFile: vi.fn()
    };
    await mount(fakeApi(), {}, audio);
    await click(button(/^开始录音$/));
    act(() => renderer?.unmount());
    renderer = undefined;
    await act(async () => arrive({ getTracks: () => [track] } as unknown as MediaStream));
    expect(track.stop).toHaveBeenCalled();
    expect(audio.createRecorder).not.toHaveBeenCalled();
  });
});

describe("custom voice actions", () => {
  it("plays the original and a preview", async () => {
    const api = fakeApi();
    await mount(api);
    await click(button(/播放原声/, rowOf("Ann")));
    await click(button(/^试听$/, rowOf("Ann")));
    expect(api.fetchReference).toHaveBeenCalledWith(CUSTOM.id);
    expect(api.previewVoice).toHaveBeenCalledWith(CUSTOM.id);
    expect(rowOf("Ann").findAll((node) => node.type === "audio")).toHaveLength(2);
  });

  it("renames", async () => {
    const api = fakeApi();
    await mount(api);
    await click(button(/^改名$/, rowOf("Ann")));
    await type(/新名称/, "Anna", rowOf("Ann"));
    await act(async () =>
      rowOf("Ann")
        .find((node) => node.type === "form")
        .props.onSubmit({ preventDefault() {} })
    );
    expect(api.updateVoice).toHaveBeenCalledWith(CUSTOM.id, { name: "Anna" });
    expect(text()).toContain("已改名为“Anna”");
  });

  it("deletes only after an in-page confirmation, and resets the assistant voice if it was chosen", async () => {
    const api = fakeApi();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { onVoiceChange } = await mount(api, { voiceId: CUSTOM.id });
    await click(button(/^删除$/, rowOf("Ann")));
    expect(api.deleteVoice).not.toHaveBeenCalled();
    expect(textOf(rowOf("Ann"))).toContain("无法撤销");
    await click(button(/^取消$/, rowOf("Ann")));
    expect(api.deleteVoice).not.toHaveBeenCalled();
    await click(button(/^删除$/, rowOf("Ann")));
    await click(button(/确认删除/, rowOf("Ann")));
    expect(api.deleteVoice).toHaveBeenCalledWith(CUSTOM.id);
    expect(onVoiceChange).toHaveBeenCalledWith("");
    expect(text()).toContain("已删除“Ann”");
    expect(root().findAll((node) => node.props.className === "voiceRow")).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("hands a deleted voice to the parent when it supplies onVoiceDeleted, without editing the draft", async () => {
    const onVoiceDeleted = vi.fn();
    const { onVoiceChange } = await mount(fakeApi(), { voiceId: CUSTOM.id, onVoiceDeleted });
    await click(button(/^删除$/, rowOf("Ann")));
    await click(button(/确认删除/, rowOf("Ann")));
    expect(onVoiceDeleted).toHaveBeenCalledWith(CUSTOM.id);
    expect(onVoiceChange).not.toHaveBeenCalled();
  });

  it("revokes object URLs when it unmounts", async () => {
    await mount(fakeApi());
    await click(button(/^试听$/, rowOf("Ann")));
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(revoked).toContain("blob:test/0");
  });
});

describe("design a voice", () => {
  it("generates candidates with players and saves one", async () => {
    const api = fakeApi();
    await mount(api);
    expect(button(/^生成候选$/).props.disabled).toBe(true);
    await type(/声音描述/, " warm and calm ");
    await click(button(/^生成候选$/));
    expect(api.designVoice).toHaveBeenCalledWith({ description: "warm and calm", language: "zh", count: 3 });
    expect(api.fetchCandidateAudio).toHaveBeenCalledTimes(3);
    const players = root().findAll((node) => node.type === "audio");
    expect(players).toHaveLength(3);

    const second = root().findAll((node) => node.type === "li" && textOf(node).includes("候选 2"))[0]!;
    expect(button(/保存为声音/, second).props.disabled).toBe(true);
    await type(/候选 2的名称/, "Calm", second);
    await click(button(/保存为声音/, second));
    expect(api.saveCandidate).toHaveBeenCalledWith("c_000000000002", {
      name: "Calm",
      gender: "neutral",
      languages: ["zh"]
    });
    expect(text()).toContain("已保存声音“Calm”");
    expect(rowOf("Calm")).toBeTruthy();
  });

  it("explains an expired candidate", async () => {
    const api = fakeApi({ saveCandidate: vi.fn(async () => bad("candidate_not_found")) });
    await mount(api);
    await type(/声音描述/, "calm");
    await click(button(/^生成候选$/));
    const first = root().findAll((node) => node.type === "li" && textOf(node).includes("候选 1"))[0]!;
    await type(/候选 1的名称/, "Calm", first);
    await click(button(/保存为声音/, first));
    expect(text()).toContain("候选已过期");
  });
});

describe("error codes from design and the relay", () => {
  const cases: Array<[string, string]> = [
    ["design_refused", "模仿某个真实的人"],
    ["sample_text_too_short", "试听文字太短"],
    ["speech_unauthorized", "MAX_SPEECH_API_KEY"]
  ];
  for (const [code, expected] of cases) {
    it(`explains ${code}`, async () => {
      const api = fakeApi({ designVoice: vi.fn(async () => bad(code)) });
      await mount(api);
      await type(/声音描述/, "calm");
      await click(button(/^生成候选$/));
      expect(text()).toContain(expected);
    });
  }

  it("tells the two kinds of not-found apart", async () => {
    const api = fakeApi({ saveCandidate: vi.fn(async () => bad("candidate_not_found")) });
    await mount(api);
    await type(/声音描述/, "calm");
    await click(button(/^生成候选$/));
    const first = root().findAll((node) => node.type === "li" && textOf(node).includes("候选 1"))[0]!;
    await type(/候选 1的名称/, "Calm", first);
    await click(button(/保存为声音/, first));
    expect(text()).toContain("已保存过");
    expect(text()).not.toContain("刷新声音库");
  });
});

describe("pronunciation", () => {
  it("adds, removes and saves entries", async () => {
    const api = fakeApi();
    await mount(api);
    expect(control(/^词 1$/).props.value).toBe("GPU");
    expect(button(/保存发音表/).props.disabled).toBe(true);
    await click(button(/^添加词条$/));
    await type(/^词 2$/, "Max ");
    await type(/^读法 2$/, "maks");
    expect(button(/保存发音表/).props.disabled).toBe(false);
    await click(control(/删除词条 1/));
    await click(button(/保存发音表/));
    expect(api.putLexicon).toHaveBeenCalledWith({ Max: "maks" });
    expect(text()).toContain("发音表已保存");
    expect(button(/保存发音表/).props.disabled).toBe(true);
  });

  it("refuses duplicates and blank readings before calling the server", async () => {
    const api = fakeApi();
    await mount(api);
    await click(button(/^添加词条$/));
    await type(/^词 2$/, "GPU");
    await type(/^读法 2$/, "x");
    await click(button(/保存发音表/));
    expect(text()).toContain("重复");
    expect(api.putLexicon).not.toHaveBeenCalled();
    await type(/^词 2$/, "CPU");
    await type(/^读法 2$/, " ");
    await click(button(/保存发音表/));
    expect(text()).toContain("读法");
    expect(api.putLexicon).not.toHaveBeenCalled();
  });

  it("maps invalid_lexicon", async () => {
    const api = fakeApi({ putLexicon: vi.fn(async () => bad("invalid_lexicon")) });
    await mount(api);
    await type(/^读法 1$/, "changed");
    await click(button(/保存发音表/));
    expect(text()).toContain("发音表无效");
  });
});
