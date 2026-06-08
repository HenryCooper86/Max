export type RideMode = "ride" | "stop" | "navigation" | "emergency";

export type DemoScenario = "commute" | "wind" | "fuel" | "group" | "emergency" | "adas";

export type RideContext = {
  mode: RideMode;
  scenario: DemoScenario;
  speedKmh?: number;
  routePhase?: string;
  network?: "online" | "degraded" | "offline";
  batteryPct?: number;
};

export type RideIntelligence = {
  modeLabel: string;
  responseStyle: string;
  safetyRule: string;
  glanceableFocus: string;
  hazardLevel: "normal" | "caution" | "critical";
};

const MODE_INTELLIGENCE: Record<RideMode, RideIntelligence> = {
  ride: {
    modeLabel: "骑行",
    responseStyle: "回复必须极短，优先语音提示，不展开解释。",
    safetyRule: "拒绝会分散骑手注意力的长任务，改为建议停车后继续。",
    glanceableFocus: "速度、风、下一步提示",
    hazardLevel: "normal"
  },
  stop: {
    modeLabel: "停车",
    responseStyle: "可以给出稍完整的说明，但仍保持简洁。",
    safetyRule: "允许配置、复盘、路线比较和较长问题。",
    glanceableFocus: "设置、路线、车辆状态",
    hazardLevel: "normal"
  },
  navigation: {
    modeLabel: "导航",
    responseStyle: "只给下一步动作、距离和风险提示。",
    safetyRule: "避免闲聊；所有回答围绕路线决策和安全。",
    glanceableFocus: "下一路口、距离、车道",
    hazardLevel: "caution"
  },
  emergency: {
    modeLabel: "紧急",
    responseStyle: "使用命令式短句，先确认安全停车和求助。",
    safetyRule: "优先生命安全；不要提供复杂排障，提示靠边、警示、求助。",
    glanceableFocus: "靠边停车、求助、位置",
    hazardLevel: "critical"
  }
};

const SCENARIO_LABELS: Record<DemoScenario, string> = {
  commute: "通勤",
  wind: "横风",
  fuel: "低油",
  group: "小队",
  emergency: "紧急",
  adas: "预警"
};

export function describeRideMode(mode: RideMode): RideIntelligence {
  return MODE_INTELLIGENCE[mode];
}

export function scenarioLabel(scenario: DemoScenario): string {
  return SCENARIO_LABELS[scenario];
}

export function scenarioDefaultMode(scenario: DemoScenario): RideMode {
  if (scenario === "emergency") return "emergency";
  if (scenario === "commute" || scenario === "fuel") return "navigation";
  return "ride";
}

export function buildRideContextSummary(context: RideContext): string {
  const mode = describeRideMode(context.mode);
  const parts = [
    `模式：${mode.modeLabel}`,
    `演示场景：${scenarioLabel(context.scenario)}`,
    `交互风格：${mode.responseStyle}`,
    `安全规则：${mode.safetyRule}`,
    `HUD重点：${mode.glanceableFocus}`
  ];

  if (typeof context.speedKmh === "number") parts.push(`估计速度：${context.speedKmh} km/h`);
  if (context.routePhase) parts.push(`路线阶段：${context.routePhase}`);
  if (context.network) parts.push(`网络：${context.network}`);
  if (typeof context.batteryPct === "number") parts.push(`头盔电量：${context.batteryPct}%`);

  return parts.join("；");
}

export function rideModeFromScenario(mode: RideMode | undefined, scenario: DemoScenario): RideMode {
  return mode ?? scenarioDefaultMode(scenario);
}

export function combineHazardLevels(
  first: RideIntelligence["hazardLevel"],
  second: RideIntelligence["hazardLevel"]
): RideIntelligence["hazardLevel"] {
  const rank: Record<RideIntelligence["hazardLevel"], number> = {
    normal: 0,
    caution: 1,
    critical: 2
  };

  return rank[first] >= rank[second] ? first : second;
}
