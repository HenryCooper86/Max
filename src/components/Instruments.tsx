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

export type Weather = {
  description: string;
  temperatureC: number;
  windSpeedKmh: number;
  isDay: boolean;
  riskLevel: "normal" | "caution" | "critical";
  riderAdvice: string;
};

/** Live weather instrument; the agent answers weather questions from this data. */
export function WeatherReadout({ weather }: { weather: Weather | null }) {
  return (
    <div className={`instrument weather ${weather?.riskLevel ?? "normal"}`}>
      <div className="instrumentHead">
        <span>实时天气</span>
        {weather ? (
          <b>{weather.riskLevel === "critical" ? "高风险" : weather.riskLevel === "caution" ? "注意" : "正常"}</b>
        ) : null}
      </div>
      {weather ? (
        <>
          <div className="weatherMain">
            <strong>{weather.temperatureC}°</strong>
            <span>{weather.description}</span>
          </div>
          <p className="weatherWind">风速 {weather.windSpeedKmh} km/h</p>
          <p className="weatherAdvice">{weather.riderAdvice}</p>
        </>
      ) : (
        <p className="weatherEmpty">激活后接入定位天气</p>
      )}
    </div>
  );
}
