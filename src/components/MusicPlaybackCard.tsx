import { useRef } from "react";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
import { localized } from "../lib/i18n";
import { useLanguage } from "./LanguageToggle";

export function MusicPlaybackCard({ agent }: { agent: HelmetAgent }) {
  const { language } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const { musicState: state, musicController: player } = agent;
  const label = (zh: string, en: string) => localized(language, zh, en);
  const track = state.tracks[state.index];
  return (
    <section className="musicPlaybackCard" aria-label={label("音乐", "Music")}>
      <div className="musicTrackHeading">
        <div>
          <strong>
            {state.provider === "qq"
              ? label("QQ 音乐", "QQ Music")
              : (track?.title ?? label("本机音乐", "Local music"))}
          </strong>
          <p>
            {state.provider === "qq"
              ? label(
                  "在 QQ 音乐中播放和切歌；网页版 Max 暂不支持控制 QQ 音乐。",
                  "Play and skip in QQ Music. Max cannot control QQ Music playback on the web yet."
                )
              : track
                ? `${state.index + 1} / ${state.tracks.length}`
                : label(
                    "选择多首音频，在网页中播放并用语音切歌。",
                    "Choose audio files to play here and skip by voice."
                  )}
          </p>
        </div>
        <button
          type="button"
          onClick={player.clear}
          aria-label={track ? label("停止并关闭音乐", "Stop and close music") : label("关闭音乐", "Close music")}
        >
          ×
        </button>
      </div>
      {state.provider === "qq" ? (
        <div className="musicControls">
          <a href="https://y.qq.com/" target="_blank" rel="noopener noreferrer">
            {label("打开 QQ 音乐官网", "Open QQ Music website")}
          </a>
          <button type="button" onClick={() => input.current?.click()}>
            {label("改用本机音频文件", "Use local audio files")}
          </button>
        </div>
      ) : (
        <div className="musicControls">
          <button
            type="button"
            disabled={state.busy || state.index <= 0}
            onClick={() => void player.perform("previous")}
            aria-label={label("上一首", "Previous track")}
          >
            ⏮
          </button>
          <button
            type="button"
            disabled={!track || (state.busy && !state.playing)}
            onClick={() => void player.perform(state.playing ? "pause" : "play")}
          >
            {state.playing ? label("暂停", "Pause") : label("播放", "Play")}
          </button>
          <button
            type="button"
            disabled={state.busy || state.index + 1 >= state.tracks.length}
            onClick={() => void player.perform("next")}
            aria-label={label("下一首", "Next track")}
          >
            ⏭
          </button>
          <button type="button" onClick={() => input.current?.click()}>
            {label("选择音乐", "Choose music")}
          </button>
          <button type="button" onClick={player.selectQQ}>
            {label("改用 QQ 音乐", "Use QQ Music")}
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length)
            player.select(
              files.map((file) => ({ title: file.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(file) }))
            );
          event.target.value = "";
        }}
      />
      {state.busy ? <p role="status">{label("正在准备音乐…", "Preparing music…")}</p> : null}
      {state.provider === "local" && state.message ? <p role="status">{state.message}</p> : null}
    </section>
  );
}
