// ADAS (advanced rider-assistance) hazard catalog for the test framework. These
// model proactive safety alerts a sensor suite would raise — a car closing fast
// from behind, hard braking ahead, a vehicle in the blind spot — that the agent
// must announce by *interrupting* whatever it is saying. The live Doubao agent
// has no sensor feed, so these are driven by the mock provider (see
// server/providers/mock.ts) and exercised by tests/adas.test.ts.

/** Where the threat is relative to the rider. */
export type AdasDirection = "front" | "rear" | "left" | "right" | "left_rear" | "right_rear";

/** The kind of hazard the assistance system detected. */
export type AdasThreat =
  | "rear_approach"
  | "forward_collision"
  | "left_blind_spot"
  | "right_blind_spot"
  | "lane_departure"
  | "left_cross_traffic"
  | "right_cross_traffic"
  | "pedestrian_ahead"
  | "tailgating";

/** ADAS alerts only ever raise caution or critical — never "normal". */
export type AdasSeverity = "caution" | "critical";

export type AdasScenario = {
  threat: AdasThreat;
  direction: AdasDirection;
  severity: AdasSeverity;
  /** Short HUD label, e.g. 后方快速接近. */
  label: string;
  /** The urgent spoken warning delivered by interrupting the conversation. */
  message: string;
  /** A brief, safe action — kept short so it does not distract the rider. */
  advice: string;
  /** Estimated time-to-collision / reaction window, seconds. */
  ttcSeconds: number;
};

const DIRECTION_LABELS: Record<AdasDirection, string> = {
  front: "前方",
  rear: "后方",
  left: "左侧",
  right: "右侧",
  left_rear: "左后方",
  right_rear: "右后方"
};

/** Human-readable Chinese label for an alert direction. */
export function adasDirectionLabel(direction: AdasDirection): string {
  return DIRECTION_LABELS[direction];
}

// The catalog. Ordered so the mock provider cycles through a representative mix
// of directions (rear, front, sides) and severities.
export const ADAS_SCENARIOS: AdasScenario[] = [
  {
    threat: "rear_approach",
    direction: "rear",
    severity: "critical",
    label: "后方快速接近",
    message: "注意，后方车辆高速接近。",
    advice: "保持车道，握稳车把，不要急刹。",
    ttcSeconds: 3
  },
  {
    threat: "forward_collision",
    direction: "front",
    severity: "critical",
    label: "前车急刹",
    message: "前车急刹，注意保持车距！",
    advice: "立即收油，平稳减速。",
    ttcSeconds: 2
  },
  {
    threat: "left_blind_spot",
    direction: "left_rear",
    severity: "caution",
    label: "左后方盲区有车",
    message: "左后方盲区有车，暂时不要向左并线。",
    advice: "保持车道，确认安全后再变线。",
    ttcSeconds: 4
  },
  {
    threat: "right_blind_spot",
    direction: "right_rear",
    severity: "caution",
    label: "右后方盲区有车",
    message: "右后方盲区有车，暂时不要向右并线。",
    advice: "保持车道，确认安全后再变线。",
    ttcSeconds: 4
  },
  {
    threat: "left_cross_traffic",
    direction: "left",
    severity: "critical",
    label: "左侧横穿车辆",
    message: "左侧路口有车横穿，注意避让！",
    advice: "立即减速，做好停车准备。",
    ttcSeconds: 2
  },
  {
    threat: "right_cross_traffic",
    direction: "right",
    severity: "critical",
    label: "右侧横穿车辆",
    message: "右侧有车横穿，减速避让！",
    advice: "立即减速，做好停车准备。",
    ttcSeconds: 2
  },
  {
    threat: "pedestrian_ahead",
    direction: "front",
    severity: "critical",
    label: "前方行人",
    message: "前方有行人横穿，立即减速！",
    advice: "收油轻刹，准备停车。",
    ttcSeconds: 2
  },
  {
    threat: "lane_departure",
    direction: "left",
    severity: "caution",
    label: "偏离车道",
    message: "注意，车辆正在偏离车道。",
    advice: "回正方向，保持车道居中。",
    ttcSeconds: 3
  },
  {
    threat: "tailgating",
    direction: "rear",
    severity: "caution",
    label: "后车跟车过近",
    message: "后车跟车过近，注意不要急刹。",
    advice: "平稳行驶，适当让出车距。",
    ttcSeconds: 4
  }
];

/** Looks up a scenario by threat id. */
export function getAdasScenario(threat: AdasThreat): AdasScenario | undefined {
  return ADAS_SCENARIOS.find((scenario) => scenario.threat === threat);
}

/**
 * Builds the spoken/HUD alert line: the directional warning plus the brief
 * action, e.g. "[后方] 注意，后方车辆高速接近。保持车道，握稳车把，不要急刹。".
 */
export function formatAdasAlert(scenario: AdasScenario): string {
  return `[${adasDirectionLabel(scenario.direction)}] ${scenario.message} ${scenario.advice}`;
}
