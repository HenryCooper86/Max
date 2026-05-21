/** Connection signal strength bars; animated while connected. */
export function SignalBars({ active }: { active: boolean }) {
  return (
    <div className={`signalBars ${active ? "active" : ""}`} role="img" aria-label={active ? "已连接" : "未连接"}>
      {[38, 58, 78, 100].map((height, index) => (
        <span key={height} style={{ height: `${height}%`, animationDelay: `${index * 0.12}s` }} />
      ))}
    </div>
  );
}
