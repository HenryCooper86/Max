/**
 * The characters that can fly on Max's pages and beside the Cloud widget: real
 * creatures, filmed or rendered photo-real, cut out of a green screen into
 * public/character/<id>.webm / .webp / .png (scripts/cut-out-character.py).
 * Footage credits: public/character/CREDITS.txt.
 */

export type CharacterId = "hummingbird" | "bee" | "butterfly";

export type CharacterInfo = {
  id: CharacterId;
  label: { zh: string; en: string };
  /** Where the head is, from the centre, as a fraction of the 660 × 480 frame, facing right:
   *  it stops with its head just short of the cursor, as at a flower. */
  head: { x: number; y: number };
};

export const CHARACTERS: readonly CharacterInfo[] = [
  { id: "hummingbird", label: { zh: "蜂鸟", en: "Hummingbird" }, head: { x: 0.2, y: -0.12 } },
  { id: "bee", label: { zh: "蜜蜂", en: "Bee" }, head: { x: 0.18, y: -0.02 } },
  { id: "butterfly", label: { zh: "蝴蝶", en: "Butterfly" }, head: { x: 0.02, y: 0.06 } }
];

/** How many may fly at once. */
export const MAX_CHARACTERS = 3;

export const DEFAULT_CHARACTERS: readonly CharacterId[] = ["hummingbird"];

export function characterInfo(id: CharacterId): CharacterInfo {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0]!;
}

function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && CHARACTERS.some((character) => character.id === value);
}

/**
 * A valid list of characters from config or an attribute: known ids only, in
 * order, at most MAX_CHARACTERS (repeats allowed: two bees). A comma-separated
 * string works too. Undefined when nothing valid is left.
 */
export function characterList(value: unknown): CharacterId[] | undefined {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const list = raw
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : item))
    .filter(isCharacterId)
    .slice(0, MAX_CHARACTERS);
  return list.length ? list : undefined;
}
