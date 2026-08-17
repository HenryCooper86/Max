// Whether a spoken sentence asserts navigation the model has no authority to
// give. Navigation truth may originate only from the relay's nav.* speech;
// when the real pipeline fails, the model otherwise narrates invented streets,
// distances and positions, and a rider at speed follows them.
//
// Deliberately lexical rather than a model call: this sits in the speech path,
// where latency is the product, and a guard that cannot be tested is not a
// guard. It has false negatives by construction — a paraphrase outside these
// families still reaches the rider, and the grounding prompt covers that tail.
// A false positive is the worse defect: it silences legitimate speech.
//
// Known false negatives (accepted by design — do not chase these into the
// patterns below; each one widens the match surface and risks a new false
// positive for a paraphrase that the grounding prompt is responsible for):
//   - "目的地就在你右手边" — reversed word order evades POSITION_CLAIM, which
//     expects "你/您 ... 在/位于 ... 路/街/...", not the destination-first form.
//   - "两百米后左转" — Chinese numerals ("两百") bypass the \d+ distance match;
//     only Arabic-numeral distances are recognized.
//   - "靠左行驶进入辅路" — a paraphrase with no literal turn token (左转/右转/
//     掉头/直行/驶入-road) that MANEUVER_IN_CONTEXT looks for.
//   - "前方800米进入匝道" / "再走500米到达目的地" / "前方300米靠右行驶" — a bare
//     leading distance with no maneuver/arrival token immediately after "后"
//     is deliberately allowed (see DISTANCE_TO_MANEUVER below), so these slip
//     through along with the hazard/weather warnings the allowance exists to
//     protect. Not chased for the same reason: catching them would re-mute
//     the sentences in tests/nav-fabrication.test.ts's ALLOWED fixtures.

// Note there is deliberately no bare-maneuver-verb pattern: 左转/直行 alone are
// not guidance ("进入导航模式", "直行区间测速"), so every rule below requires a
// distance, a road, a position or a sequencing word alongside the verb.

/**
 * A distance leading to a maneuver or arrival: "前方800米后左转", "再走300米后
 * 掉头", or a bare leading distance with no lead-in word, e.g. "1.2公里后到达
 * 目的地" (still a distance the model cannot know without a route). The
 * lead-in word ("前方"/"再走"/"经过") is optional, but the trailing "后" plus
 * a maneuver/arrival verb is REQUIRED in every case — a distance alone, even
 * with a lead-in word, is not navigation on its own: "前方3公里有强降雨" is a
 * weather warning, "前方200米有事故" is a hazard warning, "前方500米有加油站"
 * is a landmark note, and "经过5公里的隧道" is a scenery note, not guidance.
 * An earlier version of this pattern let the lead-in-word branch match on the
 * distance alone with no trailing verb requirement, which suppressed all four
 * of the sentences above — a hazard/weather warning muted in favor of a
 * navigation non-sequitur is a worse defect than the fabrication this file
 * exists to catch. See tests/nav-fabrication.test.ts's ALLOWED fixtures.
 *
 * The post-"后" verb list intentionally omits bare "到" (kept only "到达"):
 * "到" alone matches inside unrelated phrases like "5000公里后到店保养"
 * (a maintenance reminder, not navigation), so it is excluded even though it
 * costs us that specific paraphrase of "arrive" — a false negative, not a
 * false positive. There is likewise no "还有" lead-in word: "还有" alone
 * ties a distance to nothing in particular ("油箱还有5公里的续航" is a fuel
 * warning, not guidance), so a bare "还有<distance>" is not treated as
 * navigation on its own.
 */
const DISTANCE_TO_MANEUVER =
  /(?:(?:前方|再走|经过)\s*)?\d+(?:\.\d+)?\s*(?:米|公里|千米)\s*后\s*(?:到达|左转|右转|掉头|直行(?!车道|区间))/;

/** A claim about where the rider currently is. */
const POSITION_CLAIM = /(?:你|您)(?:现在|当前)?(?:在|位于)[^，。！？]{0,24}(?:路|街|大道|巷|桥|口|交叉|附近)/;

/**
 * Whole-route statistics the model cannot know without a route. The "预计 N
 * 分钟" half is scoped to arrival wording nearby ("预计22分钟后到达/抵达"):
 * unscoped, it also matches unrelated ETA phrasing like weather warnings
 * ("预计10分钟后有阵雨"), which is not a navigation claim at all.
 */
const ROUTE_STATS = /全程(?:约)?\s*\d+(?:\.\d+)?\s*(?:公里|千米|米)|预计\s*\d+\s*分钟[^，。！？]{0,12}(?:到达|抵达)/;

/**
 * A maneuver verb given a road or sequencing context, i.e. actual guidance.
 * "直行" excludes a following "车道"/"区间": "直行车道"/"直行区间" name a lane
 * or a speed-camera zone, not an instruction to go straight — "前方有减速带，
 * 然后注意直行车道的积水" is a hazard warning ("then watch for standing water
 * in the straight-ahead lane"), not guidance, even though "然后...直行" alone
 * has the same sequencing shape as real guidance like "然后直行".
 */
const MANEUVER_IN_CONTEXT =
  /(?:前方|然后|接着|沿|再)[^，。！？]{0,16}(?:左转|右转|掉头|直行(?!车道|区间))|(?:左转|右转|驶入)[^，。！？]{0,16}(?:路|街|大道|匝道)/;

export function assertsNavigation(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (DISTANCE_TO_MANEUVER.test(value)) return true;
  if (POSITION_CLAIM.test(value)) return true;
  if (ROUTE_STATS.test(value)) return true;
  if (MANEUVER_IN_CONTEXT.test(value)) return true;
  // A bare maneuver verb with no road, distance or sequencing context is not
  // guidance on its own ("进入导航模式", "直行区间测速").
  return false;
}

/**
 * The `detail` string the relay sends on the fabrication guard's client-clear
 * `status`/`hearing` event (server/providers/doubao.ts's
 * clearClientPlayback). A shared constant, not two independently hand-typed
 * literals, because RDK (rdk/agent/src/main.ts) must match it exactly to
 * route this specific signal to an unconditional playback flush instead of
 * its normal mic-corroborated barge-in path: a fabrication event has no
 * rider speech to corroborate, so the mic-gated path would silently let the
 * fabricated audio already queued play out in full.
 */
export const NAV_FABRICATION_CLEAR_DETAIL = "豆包检测到导航虚构内容，已拦截";
