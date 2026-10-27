import { Temporal } from 'temporal-polyfill';

const UNITS_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses durations like `500ms`, `10s`, `5m`, `2h`, `1d` or `1.5h` into milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  const [, amount, unit] = match ?? [];
  if (amount === undefined || unit === undefined || !(unit in UNITS_MS)) {
    throw new RangeError(`invalid duration "${text}" (use e.g. 500ms, 10s, 5m, 2h, 1d)`);
  }
  return Math.round(Number(amount) * UNITS_MS[unit as keyof typeof UNITS_MS]);
}

export function parseInteger(text: string, name: string, min = 0): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${name} must be an integer >= ${min}`);
  return n;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`;
}

/** `2026-03-29 03:30:00+02:00`, in the given time zone. */
export function formatTime(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toString({ smallestUnit: 'second', timeZoneName: 'never' })
    .replace('T', ' ');
}

/** Left-aligned text table with a header row. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
