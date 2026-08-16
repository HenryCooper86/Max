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

// Note there is deliberately no bare-maneuver-verb pattern: 左转/直行 alone are
// not guidance ("进入导航模式", "直行区间测速"), so every rule below requires a
// distance, a road, a position or a sequencing word alongside the verb.

/**
 * A distance leading to a maneuver or arrival: "前方800米后左转", "再走300米",
 * or a bare leading distance immediately followed by "后" and the maneuver/
 * arrival itself, e.g. "1.2公里后到达目的地" (no lead-in word, but still a
 * distance the model cannot know without a route).
 */
const DISTANCE_TO_MANEUVER =
  /(前方|再走|还有|经过)\s*\d+(?:\.\d+)?\s*(?:米|公里|千米)|\d+(?:\.\d+)?\s*(?:米|公里|千米)\s*后\s*(?:到达|到|左转|右转|掉头|直行)/;

/** A claim about where the rider currently is. */
const POSITION_CLAIM = /(?:你|您)(?:现在|当前)?(?:在|位于)[^，。！？]{0,24}(?:路|街|大道|巷|桥|口|交叉|附近)/;

/** Whole-route statistics the model cannot know without a route. */
const ROUTE_STATS = /全程(?:约)?\s*\d+(?:\.\d+)?\s*(?:公里|千米|米)|预计\s*\d+\s*分钟/;

/** A maneuver verb given a road or sequencing context, i.e. actual guidance. */
const MANEUVER_IN_CONTEXT =
  /(?:前方|然后|接着|沿|再)[^，。！？]{0,16}(?:左转|右转|掉头|直行)|(?:左转|右转|驶入)[^，。！？]{0,16}(?:路|街|大道|匝道)/;

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
