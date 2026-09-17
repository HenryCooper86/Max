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
          <strong>{track?.title ?? label("随行音乐", "Ride music")}</strong>
          <p>
            {track
              ? `${state.index + 1} / ${state.tracks.length}`
              : label("选择多首音频，在网页中播放并用语音切歌。", "Choose audio files to play here and skip by voice.")}
          </p>
        </div>
        {track ? (
          <button type="button" onClick={player.clear} aria-label={label("停止并清空音乐", "Stop and clear music")}>
            ×
          </button>
        ) : null}
      </div>
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
      </div>
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
      {state.message ? <p role="status">{state.message}</p> : null}
    </section>
  );
}
