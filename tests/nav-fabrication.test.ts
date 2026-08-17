// tests/nav-fabrication.test.ts
import { describe, expect, it } from "vitest";
import { assertsNavigation } from "../shared/nav-fabrication";

// Navigation truth may come only from the relay. When the real pipeline fails,
// the model fills the silence with plausible fiction — invented street names,
// distances and positions — and a rider at speed follows it. These fixtures
// are real output: the 2026-08-12 bench and the 2026-08-16 h2o session.
const FABRICATED = [
  "前方800米后左转",
  "前方左转进入中山东一路",
  "沿滨河路直行，然后右转",
  "再走300米后掉头",
  "1.2公里后到达目的地",
  "你当前在朝阳路与和平西街交叉口",
  "你在滨河路上，继续直行",
  "全程约12公里，预计22分钟"
];

// Legitimate speech that must survive. A guard that silences these is worse
// than no guard: it breaks the assistant for the sake of the rule.
const ALLOWED = [
  "好的，正在为你规划路线",
  "外滩在黄浦区，靠近南京东路",
  "导航还没启动，我没法给你指路。",
  "请以导航提示为准。",
  "今天有雨，注意路面湿滑",
  "我没找到这个地方",
  "路线规划失败。",
  "已停止导航。",
  // Adversarial false positives found in review: same lexical shapes as real
  // guidance (distance + 后 + verb, "预计 N 分钟"), but not navigation at all.
  "建议每5000公里后到店保养一次",
  "预计10分钟后有阵雨，建议减速慢行",
  "油箱还有5公里的续航，建议尽快加油",
  // Whole-branch-review regression: DISTANCE_TO_MANEUVER's lead-in-word
  // alternative used to match on a bare distance with no maneuver/arrival
  // token, muting hazard and weather warnings that happen to start with
  // "前方<distance>" or "经过<distance>".
  "前方3公里有强降雨，建议减速慢行。",
  "前方200米有事故，注意避让。",
  "前方500米有加油站",
  "经过5公里的隧道时记得开灯",
  // Same review: MANEUVER_IN_CONTEXT's "然后...直行" shape matched "直行车道"
  // (a lane name), not just the maneuver verb "直行" on its own.
  "前方有减速带，然后注意直行车道的积水"
];

describe("assertsNavigation", () => {
  for (const text of FABRICATED) {
    it(`suppresses fabricated guidance: ${text}`, () => {
      expect(assertsNavigation(text)).toBe(true);
    });
  }

  for (const text of ALLOWED) {
    it(`allows legitimate speech: ${text}`, () => {
      expect(assertsNavigation(text)).toBe(false);
    });
  }

  it("ignores empty and whitespace input", () => {
    expect(assertsNavigation("")).toBe(false);
    expect(assertsNavigation("   ")).toBe(false);
  });
});
