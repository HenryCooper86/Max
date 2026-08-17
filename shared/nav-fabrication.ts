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

// Note there is deliberately no bare-maneuver-verb pattern: 左转/直行 alone are
// not guidance ("进入导航模式", "直行区间测速"), so every rule below requires a
// distance, a road, a position or a sequencing word alongside the verb.

/**
 * A distance leading to a maneuver or arrival: "前方800米后左转", "再走300米",
 * or a bare leading distance immediately followed by "后" and the maneuver/
 * arrival itself, e.g. "1.2公里后到达目的地" (no lead-in word, but still a
 * distance the model cannot know without a route).
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
  /(前方|再走|经过)\s*\d+(?:\.\d+)?\s*(?:米|公里|千米)|\d+(?:\.\d+)?\s*(?:米|公里|千米)\s*后\s*(?:到达|左转|右转|掉头|直行)/;

/** A claim about where the rider currently is. */
const POSITION_CLAIM = /(?:你|您)(?:现在|当前)?(?:在|位于)[^，。！？]{0,24}(?:路|街|大道|巷|桥|口|交叉|附近)/;

/**
 * Whole-route statistics the model cannot know without a route. The "预计 N
 * 分钟" half is scoped to arrival wording nearby ("预计22分钟后到达/抵达"):
 * unscoped, it also matches unrelated ETA phrasing like weather warnings
 * ("预计10分钟后有阵雨"), which is not a navigation claim at all.
 */
const ROUTE_STATS = /全程(?:约)?\s*\d+(?:\.\d+)?\s*(?:公里|千米|米)|预计\s*\d+\s*分钟[^，。！？]{0,12}(?:到达|抵达)/;

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
