/**
 * English for the lines the relay itself speaks.
 *
 * Most of what a wearer hears is the model, which answers in the session's
 * language. A handful of lines are composed here instead — the honest outcome
 * of a device action, a navigation summary, "I can't see that" — and they are
 * written in Chinese throughout the relay. When a session runs in English
 * they are translated at the last step, just before they are sent, so the
 * rest of the relay keeps one set of wording to reason about and to test.
 *
 * Only known lines are translated. Anything else (a model reply, a detail a
 * client supplied, a line with a place name in it that does not match a
 * pattern) passes through untouched.
 */

const LINES: Record<string, string> = {
  // Device action failures (server/device-actions.ts FAILURE_SPEECH).
  "我没有通讯录权限，去设置里开启后我再帮你拨号。":
    "I don't have access to your contacts. Turn it on in Settings and I'll place the call.",
  "我没有音乐库权限，去设置里开启后我再帮你播放。":
    "I don't have access to your music library. Turn it on in Settings and I'll play it.",
  "手机锁屏了，解锁后我再执行。": "The phone is locked. Unlock it and I'll do that.",
  "骑行中我不发短信，停车以后我再帮你发。":
    "I won't send messages while you're moving. I'll send it once you've stopped.",
  "当前平台不支持控制这个音乐应用，请使用音乐卡片中的可用来源或本机音乐。":
    "This music app can't be controlled here. Use one of the sources on the music card, or music stored on the device.",
  "请在 QQ 音乐中播放或切歌，当前平台尚未接入 QQ 音乐播放授权。":
    "Play or skip in QQ Music itself. This platform isn't linked to QQ Music playback yet.",
  "还没有播放队列，请在应用里的音乐卡片上点选择音乐。":
    "There's nothing queued. Choose music from the music card in the app.",
  "音乐暂时无法播放，请检查音乐卡片中的提示和当前播放来源。":
    "Music can't play right now. Check the music card and the current source.",
  "音乐正在准备，请稍后重试。": "Music is still getting ready. Try again in a moment.",
  "已经到播放队列末尾了，请选择更多音乐。": "That's the end of the queue. Choose more music.",
  "当前音乐应用不支持这个播放操作。": "This music app doesn't support that.",
  "没有找到这个音乐应用的播放队列，请先在该应用中选择音乐。":
    "I couldn't find a queue in that music app. Choose something to play there first.",
  "请先在音乐卡片上点控制音乐应用，按提示授权后再试。":
    "Tap Control music app on the music card and allow access, then try again.",
  "照片或视频上传失败，请检查连接后再试。": "The photo or video didn't upload. Check the connection and try again.",
  "这个设备操作暂时不支持。": "That isn't supported on this device yet.",
  "设备暂时无法完成这个操作，请检查权限后再试。": "The device couldn't do that. Check its permissions and try again.",
  "没有执行这个操作所需的设备权限，请在系统设置中检查。":
    "The device permission for that is missing. Check it in system settings.",
  "没找到这个地方。": "I couldn't find that place.",
  "路线规划失败。": "I couldn't plan a route.",
  "通讯录里没找到这个人。": "I couldn't find them in your contacts.",
  "这台设备没有可用的手电筒。": "This device doesn't have a torch I can use.",
  "我没有相机权限，去设置里开启后我再帮你拍。": "I don't have camera access. Turn it on in Settings and I'll take it.",
  "存储快满了，导出或删除一些内容后我再帮你拍。":
    "Storage is nearly full. Export or delete something and I'll take it.",
  "手机过热，这个操作先暂停，语音和摔车检测照常。":
    "The phone is too hot, so that's paused for now. Voice and crash detection keep running.",
  "手机在省电模式，暂时不录像。": "The phone is in power-saving mode, so I'm not recording video for now.",
  "已经在录了。": "Already recording.",
  "现在没有在录像。": "Nothing is recording right now.",
  "现在没有要关机。": "There's no shutdown to cancel.",
  "拍摄没成功。": "That capture didn't work.",
  "我现在不能看。": "I can't look right now.",
  "现在没有在导航。": "Navigation isn't running.",
  "我没有定位权限，去设置里开启后我再帮你导航。":
    "I don't have location access. Turn it on in Settings and I'll navigate.",
  "相册里还没有照片或视频。": "There are no photos or videos in the gallery yet.",
  "这段内容我处理不了。": "I can't work with that one.",
  "头盔上没有屏幕，看不了。": "There's no screen here to show that on.",
  "头盔上没有手机功能，这个我做不了。": "This device has no phone, so I can't do that.",
  "这个功能头盔上还没上线。": "That isn't available on this device yet.",
  "已取消导航。": "Navigation cancelled.",
  "手机定位未连接，请打开 Max 并开始头盔骑行。": "The phone's location isn't connected. Open the app and start a ride.",
  // Device action successes (deviceSuccessSpeech).
  "拍好了。": "Got it.",
  "开始录像。": "Recording.",
  "已停止录像。": "Recording stopped.",
  "已取消关机。": "Shutdown cancelled.",
  "好的，10秒后关机；说取消关机可以撤销。": "OK, shutting down in 10 seconds. Say cancel shutdown to stop it.",
  "我看看…": "Let me look…",
  "手电筒开了。": "Torch on.",
  "手电筒关了。": "Torch off.",
  "音量调大了。": "Volume up.",
  "音量调小了。": "Volume down.",
  "相册打开了。": "Gallery open.",
  "已开启环境观察。": "Watching your surroundings.",
  "已关闭环境观察。": "Stopped watching.",
  "开始播放。": "Playing.",
  "已暂停。": "Paused.",
  "下一首。": "Next track.",
  "上一首。": "Previous track.",
  // Navigation and vision.
  "已重新规划路线。": "Route updated.",
  "我看不清。": "I can't make that out."
};

const ACTIONS: Record<string, string> = {
  手电筒: "The torch",
  音量: "The volume change",
  音乐: "The music command",
  短信: "The message",
  电话: "The call",
  目的地: "Showing the destination",
  拍照: "The photo",
  录像: "The recording",
  看看: "Looking",
  相册: "Opening the gallery",
  描述照片: "Describing the photo",
  环境观察: "Watching",
  导航: "Navigation",
  关机: "The shutdown"
};

const ACTION_FAILED = /^(.+)操作没成功。$/u;
const ROUTE_FOUND = /^已找到(.+)，全程([\d.]+)公里，预计(\d+)分钟。仅供参考，请注意实际路况。$/u;

// ---- Navigation -------------------------------------------------------------

const NAV_LINES: Record<string, string> = {
  "已偏离路线，正在重新规划。": "You're off the route. Recalculating.",
  "无法重新规划路线，已停止导航。": "I couldn't find a new route. Navigation has stopped.",
  "已到达目的地。": "You have arrived.",
  "手机定位已断开，导航已暂停。": "The phone's location dropped out. Navigation is paused."
};

const AHEAD = /^前方(\d+)米，(.+)$/u;
const CONFIRM_DESTINATION = /^请确认目的地：(.+)。请说“确认导航”或点击确认，确认后开始逐向导航。$/u;

const COMPASS: Record<string, string> = {
  东: "east",
  南: "south",
  西: "west",
  北: "north",
  东北: "north-east",
  东南: "south-east",
  西北: "north-west",
  西南: "south-west"
};

// Longest first, so 向左前方行驶 is not read as 左… something else.
const MANEUVERS: Array<[RegExp, string, string]> = [
  [/^左转调头/u, "make a U-turn", "onto"],
  [/^调头/u, "make a U-turn", "onto"],
  [/^向左前方行驶/u, "bear left", "onto"],
  [/^向右前方行驶/u, "bear right", "onto"],
  [/^向左后方行驶/u, "turn sharp left", "onto"],
  [/^向右后方行驶/u, "turn sharp right", "onto"],
  [/^靠左(?:行驶)?/u, "keep left", "onto"],
  [/^靠右(?:行驶)?/u, "keep right", "onto"],
  [/^左转/u, "turn left", "onto"],
  [/^右转/u, "turn right", "onto"],
  [/^直行/u, "continue straight", "onto"],
  [/^进入环岛/u, "enter the roundabout", "towards"],
  [/^离开环岛/u, "leave the roundabout", "onto"],
  [/^减速行驶/u, "slow down", "onto"]
];

/** Things a step can lead into that are not names. */
const ROAD_FEATURES: Record<string, string> = {
  环岛: "into the roundabout",
  匝道: "onto the ramp",
  隧道: "into the tunnel",
  辅路: "onto the side road",
  主路: "onto the main road",
  高架: "onto the elevated road",
  高速: "onto the motorway"
};

const ARRIVALS = /^到达(?:终点|目的地)(?:附近)?/u;
const WAYPOINT = /^到达途经[地点]/u;

function distance(amount: string, unit: string): string {
  return unit === "公里" ? `${amount} km` : `${amount} m`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * English for one routing-service instruction, such as
 * 沿人民大道向西行驶1.2公里右转进入西藏中路 →
 * "Head west on 人民大道 for 1.2 km, then turn right onto 西藏中路".
 * Road and place names are left as written. An instruction that does not fit
 * the grammar is returned unchanged: a correct Chinese instruction is better
 * than a wrong English one.
 */
export function translateInstruction(instruction: string): string {
  let rest = instruction.trim().replace(/[。.]$/u, "");
  if (!rest || !/\p{Script=Han}/u.test(rest)) return instruction;
  const parts: string[] = [];

  let road: string | undefined;
  const along = /^沿(.+?)(?=向(?:东北|东南|西北|西南|东|南|西|北)?行驶|行驶)/u.exec(rest);
  if (along) {
    road = along[1];
    rest = rest.slice(along[0].length);
  }
  const travel = /^向(东北|东南|西北|西南|东|南|西|北)?行驶(\d+(?:\.\d+)?)(米|公里)/u.exec(rest);
  const plain = travel ? null : /^行驶(\d+(?:\.\d+)?)(米|公里)/u.exec(rest);
  if (travel) {
    const heading = travel[1] ? ` ${COMPASS[travel[1]]}` : "";
    parts.push(`head${heading}${road ? ` on ${road}` : ""} for ${distance(travel[2]!, travel[3]!)}`);
    rest = rest.slice(travel[0].length);
  } else if (plain) {
    parts.push(`continue${road ? ` on ${road}` : ""} for ${distance(plain[1]!, plain[2]!)}`);
    rest = rest.slice(plain[0].length);
  } else if (along) {
    return instruction;
  }
  rest = rest.replace(/^[，,]\s*/u, "");

  if (rest) {
    if (ARRIVALS.test(rest)) {
      parts.push("arrive at your destination");
      rest = rest.replace(ARRIVALS, "");
    } else if (WAYPOINT.test(rest)) {
      parts.push("arrive at your stop");
      rest = rest.replace(WAYPOINT, "");
    } else {
      const maneuver = MANEUVERS.find(([pattern]) => pattern.test(rest));
      if (!maneuver) return instruction;
      rest = rest.replace(maneuver[0], "");
      const onto = /^进入(.+)$/u.exec(rest);
      const feature = onto ? ROAD_FEATURES[onto[1]!] : undefined;
      parts.push(onto ? `${maneuver[1]} ${feature ?? `${maneuver[2]} ${onto[1]}`}` : maneuver[1]);
      if (onto) rest = "";
    }
  }
  if (rest || parts.length === 0) return instruction;
  return capitalise(parts.join(", then "));
}

function navigation(text: string): string | undefined {
  const fixed = NAV_LINES[text];
  if (fixed) return fixed;
  const ahead = AHEAD.exec(text);
  if (ahead) {
    const instruction = translateInstruction(ahead[2]!);
    // An instruction that could not be translated keeps the whole line as it was.
    if (instruction === ahead[2]) return undefined;
    return `In ${ahead[1]} metres, ${instruction.charAt(0).toLowerCase()}${instruction.slice(1)}`;
  }
  const confirm = CONFIRM_DESTINATION.exec(text);
  if (confirm) {
    return `Confirm the destination: ${confirm[1]}. Say “confirm navigation” or tap Confirm to start turn-by-turn guidance.`;
  }
  const instruction = translateInstruction(text);
  return instruction === text ? undefined : instruction;
}

// ---- Hazard alerts ----------------------------------------------------------

/** The ADAS catalog (shared/adas.ts) in English: label, spoken warning, advice. */
const HAZARD_TEXT: Record<string, string> = {
  后方快速接近: "Fast approach from behind",
  "注意，后方车辆高速接近。": "Careful: a vehicle is closing fast from behind.",
  "保持车道，握稳车把，不要急刹。": "Hold your lane and a steady grip. Don't brake hard.",
  前车急刹: "Vehicle ahead braking hard",
  "前车急刹，注意保持车距！": "The vehicle ahead is braking hard. Keep your distance!",
  "立即收油，平稳减速。": "Roll off the throttle and slow down smoothly.",
  左后方盲区有车: "Vehicle in left blind spot",
  "左后方盲区有车，暂时不要向左并线。": "There's a vehicle in your left blind spot. Don't move left yet.",
  "保持车道，确认安全后再变线。": "Hold your lane and change only when it's clear.",
  右后方盲区有车: "Vehicle in right blind spot",
  "右后方盲区有车，暂时不要向右并线。": "There's a vehicle in your right blind spot. Don't move right yet.",
  左侧横穿车辆: "Vehicle crossing from the left",
  "左侧路口有车横穿，注意避让！": "A vehicle is crossing from the left. Give way!",
  "立即减速，做好停车准备。": "Slow down now and be ready to stop.",
  右侧横穿车辆: "Vehicle crossing from the right",
  "右侧有车横穿，减速避让！": "A vehicle is crossing from the right. Slow down and give way!",
  前方行人: "Pedestrian ahead",
  "前方有行人横穿，立即减速！": "A pedestrian is crossing ahead. Slow down now!",
  "收油轻刹，准备停车。": "Ease off, brake gently and be ready to stop.",
  偏离车道: "Leaving your lane",
  "注意，车辆正在偏离车道。": "Careful: you're drifting out of your lane.",
  "回正方向，保持车道居中。": "Straighten up and stay centred in your lane.",
  后车跟车过近: "Vehicle following too closely",
  "后车跟车过近，注意不要急刹。": "The vehicle behind is too close. Avoid braking hard.",
  "平稳行驶，适当让出车距。": "Ride smoothly and open up some space."
};

function english(text: string): string {
  const known = LINES[text];
  if (known) return known;
  const failed = ACTION_FAILED.exec(text);
  if (failed && ACTIONS[failed[1]!]) return `${ACTIONS[failed[1]!]} didn't work.`;
  const route = ROUTE_FOUND.exec(text);
  if (route) {
    const minutes = Number(route[3]);
    return `Found ${route[1]}. ${route[2]} km, about ${minutes} minute${minutes === 1 ? "" : "s"}. Treat it as a guide and watch the road.`;
  }
  return navigation(text) ?? HAZARD_TEXT[text] ?? text;
}

/** A relay-spoken line in the session's language. `language` is the value of
 *  `sessionLanguage(…)`: "" keeps the relay's own wording. */
export function relaySpeech(text: string, language: string): string {
  return language === "en" ? english(text) : text;
}

/**
 * Rewrites an outgoing event for an English session: relay-spoken lines,
 * hazard alerts, and the instructions of a route. Relay-spoken lines are
 * exactly the assistant transcripts marked for client-side speech; a model
 * reply that fell back to client speech carries the same mark but matches no
 * known line, so it passes through unchanged.
 */
export function localizeOutgoing<T>(payload: T, language: string): T {
  if (language !== "en" || !payload || typeof payload !== "object") return payload;
  const event = payload as {
    type?: unknown;
    speaker?: unknown;
    text?: unknown;
    useBrowserSpeech?: unknown;
    label?: unknown;
    message?: unknown;
    advice?: unknown;
    steps?: unknown;
  };

  // A hazard alert: its three lines are shown and spoken by the client.
  if (event.type === "hazard.alert") {
    const line = (value: unknown) => (typeof value === "string" ? relaySpeech(value, language) : value);
    return {
      ...(payload as object),
      label: line(event.label),
      message: line(event.message),
      advice: line(event.advice)
    } as T;
  }

  // A route: each step gains its instruction in English beside the original,
  // which clients still parse for the turn icon.
  if (event.type === "nav.route" && Array.isArray(event.steps)) {
    const steps = event.steps.map((step: unknown) => {
      const instruction = (step as { instruction?: unknown } | null)?.instruction;
      if (typeof instruction !== "string") return step;
      const localized = translateInstruction(instruction);
      return localized === instruction ? step : { ...(step as object), localizedInstruction: localized };
    });
    return { ...(payload as object), steps } as T;
  }

  if (event.type !== "transcript" || event.speaker !== "agent" || event.useBrowserSpeech !== true) return payload;
  if (typeof event.text !== "string") return payload;
  const text = relaySpeech(event.text, language);
  return text === event.text ? payload : ({ ...(payload as object), text } as T);
}
