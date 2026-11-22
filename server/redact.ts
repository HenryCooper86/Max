/**
 * Personal-data redaction for transcripts that leave the relay.
 *
 * Why not one regex per kind: patterns such as "a run of digits with optional
 * separators" or "an email local part" backtrack badly on adversarial input
 * (a 100,000-character string of `a`s or `1 `s), and a transcript is text
 * somebody else controls. Every matcher below is a single left-to-right scan
 * with bounded look-ahead, so the cost grows linearly with the text.
 *
 * Redaction is best effort and leans towards removing too much: a time, a date,
 * a price, a short number or an order number such as `A-1042` is left alone,
 * but a spaced-out run of digits that could be a phone number is replaced.
 * A bare run of digits with no `+` and no separators is not treated as a phone
 * number (order numbers and timestamps look the same); only the card check,
 * which has the Luhn test to lean on, looks at those.
 */

export type RedactionKind = "email" | "phone" | "card" | "ssn" | "ip";

/** In the order they are applied: a card number must go before the phone check
 *  can take a slice of it, and an SSN or address before a phone takes it as one. */
export const REDACTION_KINDS: readonly RedactionKind[] = ["email", "card", "ssn", "ip", "phone"];

/** Parses the config value: `true` or "all" means every kind; an array picks kinds; false/absent means none.
 *  Unknown entries give a problem. */
export function redactionKindsFrom(raw: unknown): { kinds: RedactionKind[]; problem?: string } {
  if (raw === undefined || raw === null || raw === false) return { kinds: [] };
  if (raw === true) return { kinds: [...REDACTION_KINDS] };
  const known = REDACTION_KINDS.join(", ");
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (word === "all") return { kinds: [...REDACTION_KINDS] };
    if (word === "" || word === "none") return { kinds: [] };
    return { kinds: [], problem: `redact: unknown kind "${raw.slice(0, 40)}" (use true, "all" or a list of ${known})` };
  }
  if (!Array.isArray(raw)) return { kinds: [], problem: `redact must be true, "all" or a list of ${known}` };
  const picked = new Set<RedactionKind>();
  for (const entry of raw) {
    const word = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (word === "all") return { kinds: [...REDACTION_KINDS] };
    const kind = REDACTION_KINDS.find((item) => item === word);
    if (!kind)
      return { kinds: [], problem: `redact: unknown kind ${JSON.stringify(entry).slice(0, 40)} (use ${known})` };
    picked.add(kind);
  }
  return { kinds: REDACTION_KINDS.filter((kind) => picked.has(kind)) };
}

type Span = { start: number; end: number };

function replaceSpans(text: string, spans: Span[], label: string): string {
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + label;
    at = span.end;
  }
  return out + text.slice(at);
}

const isDigit = (code: number) => code >= 48 && code <= 57;
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isAlnum = (code: number) => isDigit(code) || isLetter(code);

/** Every maximal run of ASCII digits. */
function digitRuns(text: string): Span[] {
  const runs: Span[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && isDigit(text.charCodeAt(i))) i += 1;
    runs.push({ start, end: i });
  }
  return runs;
}

// ---- email -----------------------------------------------------------------

const isLocalChar = (code: number) => isAlnum(code) || "._%+-".includes(String.fromCharCode(code));
const isDomainChar = (code: number) => isAlnum(code) || code === 45 || code === 46;

function redactEmail(text: string): string {
  const spans: Span[] = [];
  let floor = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > floor && isLocalChar(text.charCodeAt(start - 1))) start -= 1;
    while (start < at && text[start] === ".") start += 1;
    let end = at + 1;
    while (end < text.length && isDomainChar(text.charCodeAt(end))) end += 1;
    while (end > at + 1 && (text[end - 1] === "." || text[end - 1] === "-")) end -= 1;
    const domain = text.slice(at + 1, end);
    const labels = domain.split(".");
    const tld = labels[labels.length - 1] ?? "";
    const valid =
      start < at &&
      labels.length >= 2 &&
      labels.every((part) => part.length > 0 && !part.startsWith("-") && !part.endsWith("-")) &&
      tld.length >= 2 &&
      /^[A-Za-z]+$/.test(tld);
    if (valid) {
      spans.push({ start, end });
      floor = end;
    }
    at = text.indexOf("@", Math.max(at + 1, valid ? end : at + 1));
  }
  return replaceSpans(text, spans, "[email]");
}

// ---- card ------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 13-19 digits, grouped by single spaces or dashes (or spoken one digit at a
 *  time), that pass the Luhn check. Each start looks at most 19 digits ahead. */
function redactCard(text: string): string {
  const runs = digitRuns(text);
  const spans: Span[] = [];
  let i = 0;
  while (i < runs.length) {
    let digits = "";
    let best = -1;
    for (let k = i; k < runs.length; k += 1) {
      const run = runs[k]!;
      if (k > i) {
        const gap = text.slice(runs[k - 1]!.end, run.start);
        if (gap !== " " && gap !== "-") break;
      }
      digits += text.slice(run.start, run.end);
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhn(digits)) best = k;
    }
    if (best >= 0) {
      spans.push({ start: runs[i]!.start, end: runs[best]!.end });
      i = best + 1;
    } else i += 1;
  }
  return replaceSpans(text, spans, "[card]");
}

// ---- ssn -------------------------------------------------------------------

function redactSsn(text: string): string {
  const runs = digitRuns(text);
  const spans: Span[] = [];
  for (let i = 0; i + 2 < runs.length; i += 1) {
    const [a, b, c] = [runs[i]!, runs[i + 1]!, runs[i + 2]!];
    if (a.end - a.start !== 3 || b.end - b.start !== 2 || c.end - c.start !== 4) continue;
    if (text.slice(a.end, b.start) !== "-" || text.slice(b.end, c.start) !== "-") continue;
    const area = text.slice(a.start, a.end);
    if (area === "000" || area === "666" || area.startsWith("9")) continue;
    if (text.slice(b.start, b.end) === "00" || text.slice(c.start, c.end) === "0000") continue;
    // Part of a longer dashed number such as 1-123-45-6789 or a letter-prefixed code.
    const before = a.start > 0 ? text.charCodeAt(a.start - 1) : 0;
    const after = c.end < text.length ? text.charCodeAt(c.end) : 0;
    if (isLetter(before) || isLetter(after)) continue;
    if (before === 45 || (after === 45 && c.end + 1 < text.length && isDigit(text.charCodeAt(c.end + 1)))) continue;
    spans.push({ start: a.start, end: c.end });
    i += 2;
  }
  return replaceSpans(text, spans, "[ssn]");
}

// ---- ip --------------------------------------------------------------------

function redactIpv4(text: string): string {
  const runs = digitRuns(text);
  const spans: Span[] = [];
  for (let i = 0; i + 3 < runs.length; i += 1) {
    const group = runs.slice(i, i + 4);
    if (group.some((run) => run.end - run.start > 3 || Number(text.slice(run.start, run.end)) > 255)) continue;
    if (group.some((run, k) => k > 0 && text.slice(group[k - 1]!.end, run.start) !== ".")) continue;
    const first = group[0]!;
    const last = group[3]!;
    const before = first.start > 0 ? text.charCodeAt(first.start - 1) : 0;
    const after = last.end < text.length ? text.charCodeAt(last.end) : 0;
    // 1.2.3.4.5 is a version or a number, and v1.2.3.4 is a version.
    if (isLetter(before)) continue;
    if (before === 46 && first.start > 1 && isDigit(text.charCodeAt(first.start - 2))) continue;
    if (after === 46 && last.end + 1 < text.length && isDigit(text.charCodeAt(last.end + 1))) continue;
    spans.push({ start: first.start, end: last.end });
    i += 3;
  }
  return replaceSpans(text, spans, "[ip]");
}

const isHexOrColon = (code: number) =>
  isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102) || code === 58;

function validIpv6(candidate: string): boolean {
  if (!/\d/.test(candidate)) return false;
  const halves = candidate.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const all = halves.flatMap(groups);
  if (!all.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  return halves.length === 1 ? all.length === 8 : all.length >= 1 && all.length <= 7;
}

function redactIpv6(text: string): string {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isHexOrColon(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let start = i;
    while (i < text.length && isHexOrColon(text.charCodeAt(i))) i += 1;
    let end = i;
    // A sentence colon after the address, or a colon before it, is not part of it.
    if (text[end - 1] === ":" && text[end - 2] !== ":") end -= 1;
    if (text[start] === ":" && text[start + 1] !== ":") start += 1;
    if (start >= end || text.indexOf(":", start) === -1 || text.indexOf(":", start) >= end) continue;
    const before = start > 0 ? text.charCodeAt(start - 1) : 0;
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (isAlnum(before) || isAlnum(after) || before === 46 || after === 46) continue;
    if (validIpv6(text.slice(start, end))) spans.push({ start, end });
  }
  return replaceSpans(text, spans, "[ip]");
}

// ---- phone -----------------------------------------------------------------

type Chain = { first: number; last: number; digits: number; gaps: string[] };

function gapAllowed(gap: string): boolean {
  if (gap.length === 0 || gap.length > 3) return false;
  for (const char of gap) if (!" -.()".includes(char)) return false;
  return !gap.includes(".") || gap === ".";
}

function dateShaped(runs: Span[], chain: Chain): boolean {
  if (chain.last - chain.first !== 2) return false;
  const lengths = [0, 1, 2].map((k) => runs[chain.first + k]!.end - runs[chain.first + k]!.start);
  const year = lengths[0] === 4 && lengths[1]! <= 2 && lengths[2]! <= 2;
  const dayFirst = lengths[2] === 4 && lengths[0]! <= 2 && lengths[1]! <= 2;
  const first = chain.gaps[0];
  return (year || dayFirst) && (first === "-" || first === ".") && chain.gaps[1] === first;
}

/** Runs next to a clock colon, a slash or a currency sign are times, dates,
 *  fractions and prices: they neither start nor join a phone number. */
function isolated(text: string, run: Span): boolean {
  const before = run.start > 0 ? text[run.start - 1]! : "";
  const after = run.end < text.length ? text[run.end]! : "";
  if (before === "/" || after === "/" || (before !== "" && "$€£¥".includes(before))) return true;
  if (after === ":" && run.end + 1 < text.length && isDigit(text.charCodeAt(run.end + 1))) return true;
  if (before === ":" && run.start > 1 && isDigit(text.charCodeAt(run.start - 2))) return true;
  return false;
}

function redactPhone(text: string): string {
  const runs = digitRuns(text);
  const spans: Span[] = [];
  let i = 0;
  while (i < runs.length) {
    const chain: Chain = { first: i, last: i, digits: runs[i]!.end - runs[i]!.start, gaps: [] };
    if (!isolated(text, runs[i]!)) {
      while (chain.last + 1 < runs.length) {
        const next = runs[chain.last + 1]!;
        if (isolated(text, next)) break;
        const gap = text.slice(runs[chain.last]!.end, next.start);
        if (!gapAllowed(gap)) break;
        // Dots separate every group or none: "3. 555" is a sentence end.
        if (chain.gaps.length && (gap === ".") !== (chain.gaps[0] === ".")) break;
        chain.gaps.push(gap);
        chain.last += 1;
        chain.digits += next.end - next.start;
        if (dateShaped(runs, chain)) break;
      }
    }
    const span = phoneSpan(text, runs, chain);
    if (span) spans.push(span);
    i = chain.last + 1;
  }
  return replaceSpans(text, spans, "[phone]");
}

function phoneSpan(text: string, runs: Span[], chain: Chain): Span | undefined {
  const first = runs[chain.first]!;
  const last = runs[chain.last]!;
  if (isolated(text, first) || dateShaped(runs, chain)) return undefined;
  if (chain.digits < 7 || chain.digits > 15) return undefined;
  const before = first.start > 0 ? text.charCodeAt(first.start - 1) : 0;
  const after = last.end < text.length ? text.charCodeAt(last.end) : 0;
  if (isLetter(after) || isLetter(before)) return undefined;
  if (before === 45 && first.start > 1 && isLetter(text.charCodeAt(first.start - 2))) return undefined;
  const plus = before === 43;
  if (plus) return { start: first.start - 1, end: last.end };
  if (!chain.gaps.length) return undefined;
  const dotted = chain.gaps[0] === ".";
  const spaced = chain.gaps.every((gap) => gap === " ");
  if (spaced && chain.digits < 9) return undefined;
  if (dotted && chain.digits < 10) return undefined;
  const paren = before === 40 && chain.gaps[0]!.includes(")");
  return { start: paren ? first.start - 1 : first.start, end: last.end };
}

// ---- public ----------------------------------------------------------------

const REDACTORS: Record<RedactionKind, (text: string) => string> = {
  email: redactEmail,
  card: redactCard,
  ssn: redactSsn,
  ip: (text) => redactIpv6(redactIpv4(text)),
  phone: redactPhone
};

/** Replaces each match with a placeholder such as "[email]". */
export function redactText(text: string, kinds: readonly RedactionKind[]): string {
  if (!text || !kinds.length) return text;
  let out = text;
  for (const kind of REDACTION_KINDS) if (kinds.includes(kind)) out = REDACTORS[kind](out);
  return out;
}

/** Redacts the text of every turn; returns new objects. */
export function redactTurns<T extends { text: string }>(turns: readonly T[], kinds: readonly RedactionKind[]): T[] {
  return turns.map((turn) => ({ ...turn, text: redactText(turn.text, kinds) }));
}
