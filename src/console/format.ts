/** Fen (¥0.01) as "¥50.00". Negative amounts keep their sign: "-¥0.04". */
export function formatYuan(fen: number): string {
  const rounded = Math.round(fen);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}¥${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Whole minutes in a number of seconds, rounded down: "free minutes left". */
export function wholeMinutes(seconds: number): number {
  return Math.max(0, Math.floor(seconds / 60));
}

/** Minutes with at most one decimal: 1.5 -> "1.5", 3 -> "3". */
export function formatMinutes(minutes: number): string {
  return (Math.round(minutes * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
}
