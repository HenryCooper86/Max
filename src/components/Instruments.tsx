// Length of a radius-50 semicircle, used for the arc gauge dash math.
const ARC_LENGTH = Math.PI * 50;

const COMPASS_TICKS = Array.from({ length: 12 }, (_, i) => i * 30);

type CompassProps = {
  route: string;
  instruction: string;
  heading?: number;
};

/** Navigation compass dial with a fixed north-up needle. */
export function Compass({ route, instruction, heading = 0 }: CompassProps) {
  return (
    <div className="instrument compass">
      <div className="instrumentHead">
        <span>导航</span>
        <strong>{route}</strong>
      </div>
      <div className="compassBody">
        <svg viewBox="0 0 120 120" role="img" aria-label={`导航 ${route}`}>
          <circle className="compassRing" cx="60" cy="60" r="52" />
          <circle className="compassRingInner" cx="60" cy="60" r="40" />
          {COMPASS_TICKS.map((angle) => (
            <line
              key={angle}
              className={angle % 90 === 0 ? "compassTick major" : "compassTick"}
              x1="60"
              y1="10"
              x2="60"
              y2={angle % 90 === 0 ? 18 : 15}
              transform={`rotate(${angle} 60 60)`}
            />
          ))}
          <text className="compassLabel" x="60" y="30">
            N
          </text>
          <text className="compassLabel" x="92" y="64">
            E
          </text>
          <text className="compassLabel" x="60" y="98">
            S
          </text>
          <text className="compassLabel" x="28" y="64">
            W
          </text>
          <g className="compassNeedle" style={{ transform: `rotate(${heading}deg)` }}>
            <path className="needleNorth" d="M60 26 L67 60 L53 60 Z" />
            <path className="needleSouth" d="M60 94 L67 60 L53 60 Z" />
          </g>
          <circle className="compassHub" cx="60" cy="60" r="5" />
        </svg>
      </div>
      <small>{instruction}</small>
    </div>
  );
}

type ArcGaugeProps = {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
};

/** Semicircular arc gauge that colours itself green / amber / red by fill. */
export function ArcGauge({ label, value, unit, min, max }: ArcGaugeProps) {
  const fraction = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const tone = fraction < 0.5 ? "good" : fraction < 0.8 ? "warn" : "alert";

  return (
    <div className={`instrument gauge ${tone}`}>
      <div className="instrumentHead">
        <span>{label}</span>
      </div>
      <svg viewBox="0 0 120 74" role="img" aria-label={`${label} ${value}${unit}`}>
        <path className="gaugeTrack" d="M10 64 A50 50 0 0 1 110 64" />
        <path
          className="gaugeFill"
          d="M10 64 A50 50 0 0 1 110 64"
          strokeDasharray={ARC_LENGTH}
          strokeDashoffset={ARC_LENGTH * (1 - fraction)}
        />
      </svg>
      <div className="gaugeValue">
        <strong>{value}</strong>
        <span>{unit}</span>
      </div>
    </div>
  );
}

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
