import { Temporal } from 'temporal-polyfill';

/**
 * A documented subset of iCalendar RRULE (RFC 5545, section 3.3.10).
 *
 * | Part         | Supported values                                   |
 * | ------------ | -------------------------------------------------- |
 * | `FREQ`       | `MINUTELY`, `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY` |
 * | `INTERVAL`   | positive integer (default 1)                       |
 * | `COUNT`      | positive integer (not together with `UNTIL`)       |
 * | `UNTIL`      | UTC date-time, e.g. `20261231T235959Z`             |
 * | `BYDAY`      | `MO`..`SU`, `WEEKLY` only, no ordinals (`1MO`)     |
 * | `BYMONTHDAY` | 1..31 or -31..-1 (from month end), `MONTHLY` only  |
 * | `BYHOUR`     | 0..23, `DAILY`/`WEEKLY`/`MONTHLY` only             |
 * | `BYMINUTE`   | 0..59, `DAILY`/`WEEKLY`/`MONTHLY` only             |
 */
export type Frequency = 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RecurrenceRule {
  readonly freq: Frequency;
  readonly interval: number;
  readonly count?: number;
  /** Last allowed occurrence, epoch ms (inclusive). */
  readonly until?: number;
  readonly byDay?: readonly Weekday[];
  readonly byMonthDay?: readonly number[];
  readonly byHour?: readonly number[];
  readonly byMinute?: readonly number[];
}

export class RecurrenceError extends Error {
  override readonly name = 'RecurrenceError';
}

/** Accepted ways to give a recurrence start time. Strings without a zone or offset are local wall time. */
export type StartInput = Temporal.ZonedDateTime | Date | number | string;

const FREQUENCIES: readonly Frequency[] = ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];
const SUPPORTED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYHOUR',
  'BYMINUTE',
]);
const STEP_MS = { MINUTELY: 60_000, HOURLY: 3_600_000 } as const;

/**
 * Stop searching after this many consecutive periods without an occurrence.
 * Guards against rules that can never match, e.g.
 * `FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30` starting in February.
 */
const MAX_EMPTY_PERIODS = 10_000;

function parseInteger(value: string, part: string, min: number, max: number): number {
  if (!/^[+-]?\d+$/.test(value))
    throw new RecurrenceError(`${part} must be an integer, got "${value}"`);
  const n = Number(value);
  if (n < min || n > max) throw new RecurrenceError(`${part} must be between ${min} and ${max}`);
  return n;
}

function parseIntegerList(value: string, part: string, min: number, max: number): number[] {
  const list = value.split(',').map((v) => parseInteger(v, part, min, max));
  return [...new Set(list)].sort((a, b) => a - b);
}

function parseUntil(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new RecurrenceError(`UNTIL must be a UTC date-time like 20261231T235959Z`);
  const [, y, mo, d, h, mi, s] = m;
  try {
    return Temporal.Instant.from(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).epochMilliseconds;
  } catch {
    throw new RecurrenceError(`UNTIL is not a valid date-time: "${value}"`);
  }
}

function parseWeekdays(value: string): Weekday[] {
  const days = value.split(',').map((v) => {
    const day = WEEKDAYS.find((w) => w === v);
    if (!day) throw new RecurrenceError(`BYDAY values must be MO..SU without ordinals, got "${v}"`);
    return day;
  });
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** Parses an RRULE string (with or without the `RRULE:` prefix) into a validated rule. */
export function parseRRule(text: string): RecurrenceRule {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (body === '') throw new RecurrenceError('RRULE is empty');

  const parts = new Map<string, string>();
  for (const part of body.split(';')) {
    const [key, value, ...rest] = part.split('=');
    if (key === undefined || key === '' || value === undefined || value === '' || rest.length > 0) {
      throw new RecurrenceError(`malformed RRULE part "${part}"`);
    }
    const name = key.toUpperCase();
    if (!SUPPORTED_PARTS.has(name)) {
      throw new RecurrenceError(
        `unsupported RRULE part ${name}; supported: ${[...SUPPORTED_PARTS].join(', ')}`,
      );
    }
    if (parts.has(name)) throw new RecurrenceError(`duplicate RRULE part ${name}`);
    parts.set(name, value.toUpperCase());
  }

  const freq = FREQUENCIES.find((f) => f === parts.get('FREQ'));
  if (!freq) throw new RecurrenceError(`FREQ must be one of ${FREQUENCIES.join(', ')}`);

  const raw = (name: string) => parts.get(name);
  const count = raw('COUNT');
  const until = raw('UNTIL');
  const byDay = raw('BYDAY');
  const byMonthDay = raw('BYMONTHDAY');
  const byHour = raw('BYHOUR');
  const byMinute = raw('BYMINUTE');

  if (count !== undefined && until !== undefined) {
    throw new RecurrenceError('COUNT and UNTIL cannot be used together');
  }
  if (byDay !== undefined && freq !== 'WEEKLY') {
    throw new RecurrenceError('BYDAY is only supported with FREQ=WEEKLY');
  }
  if (byMonthDay !== undefined && freq !== 'MONTHLY') {
    throw new RecurrenceError('BYMONTHDAY is only supported with FREQ=MONTHLY');
  }
  if ((byHour !== undefined || byMinute !== undefined) && freq in STEP_MS) {
    throw new RecurrenceError(`BYHOUR and BYMINUTE are not supported with FREQ=${freq}`);
  }

  const monthDays =
    byMonthDay === undefined ? undefined : parseIntegerList(byMonthDay, 'BYMONTHDAY', -31, 31);
  if (monthDays?.includes(0)) throw new RecurrenceError('BYMONTHDAY cannot be 0');

  return {
    freq,
    interval: parts.has('INTERVAL')
      ? parseInteger(raw('INTERVAL') ?? '', 'INTERVAL', 1, 10_000)
      : 1,
    ...(count !== undefined && { count: parseInteger(count, 'COUNT', 1, 1_000_000) }),
    ...(until !== undefined && { until: parseUntil(until) }),
    ...(byDay !== undefined && { byDay: parseWeekdays(byDay) }),
    ...(monthDays !== undefined && { byMonthDay: monthDays }),
    ...(byHour !== undefined && { byHour: parseIntegerList(byHour, 'BYHOUR', 0, 23) }),
    ...(byMinute !== undefined && { byMinute: parseIntegerList(byMinute, 'BYMINUTE', 0, 59) }),
  };
}

function formatUntil(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toString({ smallestUnit: 'second' })
    .replace(/[-:]/g, '');
}

/** Formats a rule as a canonical RRULE string (parts in a fixed order). */
export function formatRRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${formatUntil(rule.until)}`);
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byHour) parts.push(`BYHOUR=${rule.byHour.join(',')}`);
  if (rule.byMinute) parts.push(`BYMINUTE=${rule.byMinute.join(',')}`);
  return parts.join(';');
}

function wrapRangeError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new RecurrenceError(error.message);
    }
    throw error;
  }
}

/**
 * Turns a start input into a zoned date-time.
 * - `ZonedDateTime` / strings with a `[Zone/Id]` suffix: kept in their own zone,
 *   or converted to `timeZone` if one is given.
 * - `Date` / epoch ms / strings with `Z` or an offset: an exact instant, shown in `timeZone`.
 * - Other strings (`2026-03-29T02:30`): local wall time in `timeZone`.
 *
 * `timeZone` defaults to the system time zone.
 */
export function resolveStart(start: StartInput, timeZone?: string): Temporal.ZonedDateTime {
  return wrapRangeError(() => {
    const zone = timeZone ?? Temporal.Now.timeZoneId();
    if (typeof start === 'string' && start.includes('[')) {
      start = Temporal.ZonedDateTime.from(start);
    }
    if (start instanceof Temporal.ZonedDateTime) {
      return timeZone === undefined ? start : start.withTimeZone(timeZone);
    }
    if (typeof start === 'number' || start instanceof Date) {
      const ms = typeof start === 'number' ? start : start.getTime();
      return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
    }
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(start)) {
      return Temporal.Instant.from(start).toZonedDateTimeISO(zone);
    }
    return Temporal.PlainDateTime.from(start).toZonedDateTime(zone);
  });
}

/**
 * A recurrence rule anchored at a start time in a time zone.
 *
 * Time-zone and DST behaviour:
 * - `DAILY`, `WEEKLY` and `MONTHLY` follow wall-clock time: "09:00 every day"
 *   stays at 09:00 local time across DST changes.
 * - A wall-clock time that does not exist (spring-forward gap) moves forward by
 *   the length of the gap: 02:30 becomes 03:30. This matches RFC 5545 and
 *   Temporal's `'compatible'` disambiguation.
 * - A wall-clock time that happens twice (fall-back overlap) runs once, at the
 *   first (earlier) of the two instants.
 * - `MINUTELY` and `HOURLY` step in exact elapsed time from the start, so
 *   "every hour" is always 60 minutes apart and DST never skips or doubles a run.
 * - Occurrences before `start` are never produced; `start` itself is only an
 *   occurrence if it matches the rule.
 * - With `BYHOUR` or `BYMINUTE`, occurrences fall on second 0; otherwise the
 *   time of day (including seconds) comes from `start`.
 */
export class Recurrence {
  readonly start: Temporal.ZonedDateTime;
  private readonly startMs: number;
  private readonly startDate: Temporal.PlainDate;
  private readonly startMonday: Temporal.PlainDate;
  private readonly times: readonly Temporal.PlainTime[];

  constructor(
    readonly rule: RecurrenceRule,
    start: Temporal.ZonedDateTime,
  ) {
    this.start = start.round({ smallestUnit: 'second', roundingMode: 'floor' });
    this.startMs = this.start.epochMilliseconds;
    this.startDate = this.start.toPlainDate();
    this.startMonday = this.startDate.subtract({ days: this.startDate.dayOfWeek - 1 });
    const hours = rule.byHour ?? [this.start.hour];
    const minutes = rule.byMinute ?? [this.start.minute];
    // An explicit time of day ("BYHOUR=9;BYMINUTE=30") means 09:30:00, not the
    // seconds of whenever the task was created.
    const second = rule.byHour || rule.byMinute ? 0 : this.start.second;
    this.times = hours.flatMap((hour) =>
      minutes.map((minute) => new Temporal.PlainTime(hour, minute, second)),
    );
  }

  /** Parses `rrule` and anchors it at `start` in `timeZone` (default: the system time zone). */
  static parse(rrule: string, start: StartInput, timeZone?: string): Recurrence {
    return new Recurrence(parseRRule(rrule), resolveStart(start, timeZone));
  }

  get timeZone(): string {
    return this.start.timeZoneId;
  }

  /** The first occurrence strictly after `afterMs` (epoch ms), or `null` if the rule has ended. */
  next(afterMs: number): number | null {
    for (const t of this.after(afterMs)) return t;
    return null;
  }

  /** Up to `limit` occurrences strictly after `afterMs`, in order. */
  take(limit: number, afterMs: number = this.startMs - 1): number[] {
    const out: number[] = [];
    if (limit <= 0) return out;
    for (const t of this.after(afterMs)) {
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Every occurrence from the start, in order. Infinite for rules without COUNT or UNTIL. */
  occurrences(): Generator<number> {
    return this.after(this.startMs - 1);
  }

  /** Lazily yields occurrences strictly after `afterMs`, in order. */
  *after(afterMs: number): Generator<number> {
    const { count } = this.rule;
    if (this.rule.freq === 'MINUTELY' || this.rule.freq === 'HOURLY') {
      const step = this.rule.interval * STEP_MS[this.rule.freq];
      let n = afterMs < this.startMs ? 0 : Math.floor((afterMs - this.startMs) / step) + 1;
      for (; count === undefined || n < count; n++) {
        const t = this.withinUntil(this.startMs + n * step);
        if (t === null) return;
        yield t;
      }
      return;
    }
    // COUNT is defined from the first occurrence, so those rules must be walked
    // from the start. Otherwise jump close to `afterMs` (one period early, to be
    // safe around midnight and DST) instead of walking years of occurrences.
    const fromPeriod = count === undefined ? Math.max(0, this.periodIndex(afterMs) - 1) : 0;
    let seen = 0;
    for (const t of this.walk(fromPeriod)) {
      if (count !== undefined && ++seen > count) return;
      if (t > afterMs) yield t;
    }
  }

  toString(): string {
    return formatRRule(this.rule);
  }

  private withinUntil(t: number): number | null {
    return this.rule.until !== undefined && t > this.rule.until ? null : t;
  }

  /** Occurrences from period `fromPeriod` on, strictly increasing, ending at UNTIL. */
  private *walk(fromPeriod: number): Generator<number> {
    let last = -Infinity;
    let emptyPeriods = 0;
    for (let k = fromPeriod; emptyPeriods <= MAX_EMPTY_PERIODS; k++) {
      const instants = this.instantsInPeriod(k);
      emptyPeriods = instants.length === 0 ? emptyPeriods + 1 : 0;
      for (const t of instants) {
        if (this.withinUntil(t) === null) return;
        // Two wall-clock times can land on the same instant (02:30 inside a DST gap
        // becomes 03:30), so only strictly increasing instants are produced.
        if (t > last) {
          last = t;
          yield t;
        }
      }
    }
  }

  private instantsInPeriod(k: number): number[] {
    const out: number[] = [];
    for (const date of this.datesInPeriod(k)) {
      for (const plainTime of this.times) {
        const t = date.toZonedDateTime({ timeZone: this.timeZone, plainTime }).epochMilliseconds;
        if (t >= this.startMs) out.push(t);
      }
    }
    return out.sort((a, b) => a - b);
  }

  private datesInPeriod(k: number): Temporal.PlainDate[] {
    const step = k * this.rule.interval;
    switch (this.rule.freq) {
      case 'WEEKLY': {
        const monday = this.startMonday.add({ weeks: step });
        const days = this.rule.byDay ?? [WEEKDAYS[this.startDate.dayOfWeek - 1] ?? 'MO'];
        return days.map((day) => monday.add({ days: WEEKDAYS.indexOf(day) }));
      }
      case 'MONTHLY': {
        const month = this.startDate.toPlainYearMonth().add({ months: step });
        const days = (this.rule.byMonthDay ?? [this.startDate.day])
          .map((d) => (d > 0 ? d : month.daysInMonth + d + 1))
          .filter((d) => d >= 1 && d <= month.daysInMonth);
        return [...new Set(days)].sort((a, b) => a - b).map((day) => month.toPlainDate({ day }));
      }
      default:
        return [this.startDate.add({ days: step })];
    }
  }

  /** Index of the period that contains `ms` in this rule's time zone (may be negative). */
  private periodIndex(ms: number): number {
    const date = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(this.timeZone);
    let elapsed: number;
    switch (this.rule.freq) {
      case 'WEEKLY': {
        const monday = date.toPlainDate().subtract({ days: date.dayOfWeek - 1 });
        elapsed = this.startMonday.until(monday, { largestUnit: 'days' }).days / 7;
        break;
      }
      case 'MONTHLY':
        elapsed = (date.year - this.startDate.year) * 12 + (date.month - this.startDate.month);
        break;
      default:
        elapsed = this.startDate.until(date.toPlainDate(), { largestUnit: 'days' }).days;
    }
    return Math.floor(elapsed / this.rule.interval);
  }
}
