import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  Recurrence,
  RecurrenceError,
  WEEKDAYS,
  formatRRule,
  parseRRule,
  resolveStart,
  type RecurrenceRule,
} from '../src/recurrence.js';

/** Formats an epoch-ms instant as local ISO time with offset, e.g. 2026-03-29T03:30:00+02:00. */
function local(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toString({ timeZoneName: 'never' });
}

function localTimes(rec: Recurrence, n: number, after?: number): string[] {
  return rec.take(n, after).map((t) => local(t, rec.timeZone));
}

describe('parseRRule', () => {
  it('parses every supported part and normalises lists', () => {
    expect(
      parseRRule('RRULE:freq=weekly;interval=2;byday=FR,MO,MO;byhour=17,9;byminute=30;count=10'),
    ).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      count: 10,
      byDay: ['MO', 'FR'],
      byHour: [9, 17],
      byMinute: [30],
    });
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1,15;UNTIL=20261231T235959Z')).toEqual({
      freq: 'MONTHLY',
      interval: 1,
      byMonthDay: [-1, 15],
      until: Date.parse('2026-12-31T23:59:59Z'),
    });
  });

  it('formats rules canonically so they round-trip', () => {
    const text = 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T235959Z;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0';
    expect(formatRRule(parseRRule(text))).toBe(text);
    expect(formatRRule(parseRRule('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3'))).toBe(
      'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=1',
    );
  });

  it.each([
    ['', 'RRULE is empty'],
    ['INTERVAL=2', 'FREQ must be one of'],
    ['FREQ=YEARLY', 'FREQ must be one of'],
    ['FREQ=DAILY;BYSETPOS=1', 'unsupported RRULE part BYSETPOS'],
    ['FREQ=DAILY;FREQ=WEEKLY', 'duplicate RRULE part FREQ'],
    ['FREQ=DAILY;;', 'malformed RRULE part'],
    ['FREQ=DAILY;INTERVAL', 'malformed RRULE part'],
    ['FREQ=DAILY;INTERVAL=0', 'INTERVAL must be between 1'],
    ['FREQ=DAILY;INTERVAL=1.5', 'INTERVAL must be an integer'],
    ['FREQ=DAILY;COUNT=2;UNTIL=20261231T000000Z', 'COUNT and UNTIL cannot be used together'],
    ['FREQ=DAILY;UNTIL=2026-12-31', 'UNTIL must be a UTC date-time'],
    ['FREQ=DAILY;UNTIL=20261332T000000Z', 'UNTIL is not a valid date-time'],
    ['FREQ=DAILY;BYDAY=MO', 'BYDAY is only supported with FREQ=WEEKLY'],
    ['FREQ=WEEKLY;BYDAY=1MO', 'BYDAY values must be MO..SU'],
    ['FREQ=WEEKLY;BYMONTHDAY=1', 'BYMONTHDAY is only supported with FREQ=MONTHLY'],
    ['FREQ=MONTHLY;BYMONTHDAY=0', 'BYMONTHDAY cannot be 0'],
    ['FREQ=MONTHLY;BYMONTHDAY=32', 'BYMONTHDAY must be between -31 and 31'],
    ['FREQ=HOURLY;BYMINUTE=5', 'not supported with FREQ=HOURLY'],
    ['FREQ=DAILY;BYHOUR=24', 'BYHOUR must be between 0 and 23'],
  ])('rejects %j', (text, message) => {
    expect(() => parseRRule(text)).toThrow(RecurrenceError);
    expect(() => parseRRule(text)).toThrow(message);
  });
});

describe('resolveStart', () => {
  it('reads local wall time, instants and zoned strings', () => {
    const tz = 'Europe/Helsinki';
    expect(resolveStart('2026-06-01T09:00', tz).toString()).toBe(
      '2026-06-01T09:00:00+03:00[Europe/Helsinki]',
    );
    expect(resolveStart('2026-06-01T06:00:00Z', tz).hour).toBe(9);
    expect(resolveStart(Date.parse('2026-06-01T06:00:00Z'), tz).hour).toBe(9);
    expect(resolveStart(new Date('2026-06-01T06:00:00Z'), tz).hour).toBe(9);
    expect(resolveStart('2026-06-01T09:00:00+03:00[Europe/Helsinki]', 'UTC').hour).toBe(6);
    expect(resolveStart(Temporal.ZonedDateTime.from('2026-06-01T09:00[UTC]'), tz).hour).toBe(12);
  });

  it('uses the system time zone by default, but keeps an explicit zone', () => {
    expect(resolveStart('2026-06-01T09:00').timeZoneId).toBe(Temporal.Now.timeZoneId());
    expect(resolveStart('2026-06-01T09:00:00+02:00[Europe/Berlin]').toString()).toBe(
      '2026-06-01T09:00:00+02:00[Europe/Berlin]',
    );
  });

  it('reports invalid input as RecurrenceError', () => {
    expect(() => resolveStart('not a date', 'UTC')).toThrow(RecurrenceError);
    expect(() => resolveStart('2026-06-01T09:00', 'Mars/Olympus')).toThrow(RecurrenceError);
  });
});

describe('Recurrence', () => {
  it('daily at 09:00 local time', () => {
    const rec = Recurrence.parse(
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      '2026-06-01T08:00',
      'Europe/Helsinki',
    );
    expect(localTimes(rec, 3)).toEqual([
      '2026-06-01T09:00:00+03:00',
      '2026-06-02T09:00:00+03:00',
      '2026-06-03T09:00:00+03:00',
    ]);
    expect(rec.toString()).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
  });

  it('takes the time of day from the start when BYHOUR/BYMINUTE are absent', () => {
    const rec = Recurrence.parse('FREQ=DAILY;INTERVAL=3', '2026-06-01T07:45:30', 'UTC');
    expect(localTimes(rec, 2)).toEqual(['2026-06-01T07:45:30+00:00', '2026-06-04T07:45:30+00:00']);
  });

  it('weekly on several days, every other week', () => {
    // 2026-06-03 is a Wednesday; its week starts Monday 2026-06-01.
    const rec = Recurrence.parse(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;BYHOUR=9',
      '2026-06-03T00:00',
      'UTC',
    );
    expect(localTimes(rec, 5).map((s) => s.slice(0, 10))).toEqual([
      '2026-06-03',
      '2026-06-05',
      '2026-06-15',
      '2026-06-17',
      '2026-06-19',
    ]);
  });

  it('weekly without BYDAY repeats on the start weekday', () => {
    const rec = Recurrence.parse('FREQ=WEEKLY', '2026-06-03T10:00', 'UTC');
    expect(localTimes(rec, 2).map((s) => s.slice(0, 10))).toEqual(['2026-06-03', '2026-06-10']);
  });

  it('monthly on the last day of the month, including February in a leap year', () => {
    const rec = Recurrence.parse('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18', '2028-01-01', 'UTC');
    expect(localTimes(rec, 4).map((s) => s.slice(0, 10))).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
      '2028-04-30',
    ]);
  });

  it('monthly on day 31 skips months without a 31st (RFC 5545)', () => {
    const rec = Recurrence.parse('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-01T12:00', 'UTC');
    expect(localTimes(rec, 3).map((s) => s.slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
  });

  it('stops after COUNT occurrences', () => {
    const rec = Recurrence.parse('FREQ=DAILY;COUNT=3', '2026-06-01T09:00', 'UTC');
    expect(localTimes(rec, 10)).toHaveLength(3);
    expect([...rec.occurrences()]).toHaveLength(3);
    const third = rec.take(3)[2] ?? 0;
    expect(rec.next(third)).toBeNull();
  });

  it('stops at UNTIL (inclusive)', () => {
    const rec = Recurrence.parse('FREQ=DAILY;UNTIL=20260603T090000Z', '2026-06-01T09:00', 'UTC');
    expect(localTimes(rec, 10).map((s) => s.slice(0, 10))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('never produces occurrences before the start', () => {
    const rec = Recurrence.parse('FREQ=DAILY;BYHOUR=9', '2026-06-01T10:00', 'UTC');
    expect(localTimes(rec, 1)).toEqual(['2026-06-02T09:00:00+00:00']);
    expect(rec.next(0)).toBe(Date.parse('2026-06-02T09:00:00Z'));
  });

  it('gives up on rules that can never match', () => {
    const rec = Recurrence.parse('FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30', '2026-02-01', 'UTC');
    expect(rec.next(0)).toBeNull();
  });

  describe('intraday rules use exact elapsed time', () => {
    it('every 15 minutes with COUNT', () => {
      const rec = Recurrence.parse('FREQ=MINUTELY;INTERVAL=15;COUNT=3', '2026-06-01T09:00', 'UTC');
      expect(localTimes(rec, 5)).toEqual([
        '2026-06-01T09:00:00+00:00',
        '2026-06-01T09:15:00+00:00',
        '2026-06-01T09:30:00+00:00',
      ]);
    });

    it('hourly across a spring-forward change is still 60 minutes apart', () => {
      const rec = Recurrence.parse('FREQ=HOURLY', '2026-03-29T00:30', 'Europe/Berlin');
      const times = rec.take(4);
      expect(times.map((t) => local(t, 'Europe/Berlin'))).toEqual([
        '2026-03-29T00:30:00+01:00',
        '2026-03-29T01:30:00+01:00',
        '2026-03-29T03:30:00+02:00',
        '2026-03-29T04:30:00+02:00',
      ]);
    });

    it('respects UNTIL', () => {
      const rec = Recurrence.parse(
        'FREQ=HOURLY;UNTIL=20260601T110000Z',
        '2026-06-01T09:00Z',
        'UTC',
      );
      expect(rec.take(10)).toHaveLength(3);
    });
  });

  describe('daylight saving time (Europe/Berlin)', () => {
    it('02:30 on the spring-forward day runs at 03:30', () => {
      const rec = Recurrence.parse(
        'FREQ=DAILY;BYHOUR=2;BYMINUTE=30',
        '2026-03-27T00:00',
        'Europe/Berlin',
      );
      expect(localTimes(rec, 4)).toEqual([
        '2026-03-27T02:30:00+01:00',
        '2026-03-28T02:30:00+01:00',
        '2026-03-29T03:30:00+02:00',
        '2026-03-30T02:30:00+02:00',
      ]);
    });

    it('02:30 on the fall-back day runs once, at the first 02:30', () => {
      const rec = Recurrence.parse(
        'FREQ=DAILY;BYHOUR=2;BYMINUTE=30',
        '2026-10-24T00:00',
        'Europe/Berlin',
      );
      expect(localTimes(rec, 3)).toEqual([
        '2026-10-24T02:30:00+02:00',
        '2026-10-25T02:30:00+02:00',
        '2026-10-26T02:30:00+01:00',
      ]);
    });

    it('02:30 and 03:30 on the spring-forward day collapse into one run', () => {
      const rec = Recurrence.parse(
        'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=30',
        '2026-03-29T00:00',
        'Europe/Berlin',
      );
      expect(localTimes(rec, 3)).toEqual([
        '2026-03-29T03:30:00+02:00',
        '2026-03-30T02:30:00+02:00',
        '2026-03-30T03:30:00+02:00',
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

const ZONES = [
  'UTC',
  'Europe/Helsinki',
  'Europe/Berlin',
  'America/New_York',
  'America/Santiago', // DST changes at midnight
  'Australia/Lord_Howe', // 30-minute DST shift
  'Asia/Tokyo',
];

const DAY_MS = 86_400_000;
const RANGE_START = Date.parse('2024-01-01T00:00:00Z');
const RANGE_END = Date.parse('2028-01-01T00:00:00Z');

const sortedSubset = <T>(arb: fc.Arbitrary<T>) =>
  fc.uniqueArray(arb, { minLength: 1, maxLength: 3 });

const calendarRule: fc.Arbitrary<RecurrenceRule> = fc
  .record({
    freq: fc.constantFrom('DAILY' as const, 'WEEKLY' as const, 'MONTHLY' as const),
    interval: fc.integer({ min: 1, max: 3 }),
    byHour: fc.option(sortedSubset(fc.integer({ min: 0, max: 23 })), { nil: undefined }),
    byMinute: fc.option(sortedSubset(fc.constantFrom(0, 15, 30, 45)), { nil: undefined }),
    byDay: fc.option(sortedSubset(fc.constantFrom(...WEEKDAYS)), { nil: undefined }),
    byMonthDay: fc.option(sortedSubset(fc.constantFrom(1, 15, 28, 29, 30, 31, -1, -2)), {
      nil: undefined,
    }),
  })
  .map((r) =>
    parseRRule(
      formatRRule({
        freq: r.freq,
        interval: r.interval,
        ...(r.byHour && { byHour: r.byHour }),
        ...(r.byMinute && { byMinute: r.byMinute }),
        ...(r.freq === 'WEEKLY' && r.byDay && { byDay: r.byDay }),
        ...(r.freq === 'MONTHLY' && r.byMonthDay && { byMonthDay: r.byMonthDay }),
      }),
    ),
  );

const startInstant = fc.integer({ min: RANGE_START, max: RANGE_START + 365 * DAY_MS });

/**
 * Independent reference implementation: walk local calendar days, ask "does
 * this day match the rule?", and resolve each wall-clock time with Temporal's
 * default ('compatible') disambiguation. Slow but obviously right. The match
 * checks only depend on the distance from the start date, so the walk can
 * begin at any day.
 */
function* referenceOccurrences(
  rec: Recurrence,
  fromMs: number,
  untilMs: number,
): Generator<number> {
  const { rule, start } = rec;
  const startDate = start.toPlainDate();
  const startMonday = startDate.subtract({ days: startDate.dayOfWeek - 1 });
  const hours = rule.byHour ?? [start.hour];
  const minutes = rule.byMinute ?? [start.minute];
  const toDate = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(rec.timeZone).toPlainDate();
  const fromDate = toDate(Math.max(fromMs, start.epochMilliseconds)).subtract({ days: 1 });
  const endDate = toDate(untilMs);
  let last = -Infinity;
  for (
    let day = fromDate;
    Temporal.PlainDate.compare(day, endDate) <= 0;
    day = day.add({ days: 1 })
  ) {
    let matches: boolean;
    if (rule.freq === 'DAILY') {
      matches = startDate.until(day).days % rule.interval === 0;
    } else if (rule.freq === 'WEEKLY') {
      const monday = day.subtract({ days: day.dayOfWeek - 1 });
      const weeks = startMonday.until(monday).days / 7;
      const weekday = WEEKDAYS[day.dayOfWeek - 1] ?? 'MO';
      const days = rule.byDay ?? [WEEKDAYS[startDate.dayOfWeek - 1] ?? 'MO'];
      matches = weeks % rule.interval === 0 && days.includes(weekday);
    } else {
      const months = (day.year - startDate.year) * 12 + (day.month - startDate.month);
      const days = rule.byMonthDay ?? [startDate.day];
      matches =
        months % rule.interval === 0 &&
        days.some((d) => (d > 0 ? d : day.daysInMonth + d + 1) === day.day);
    }
    if (!matches) continue;
    const instants = hours.flatMap((hour) =>
      minutes.map(
        (minute) =>
          day.toZonedDateTime({
            timeZone: rec.timeZone,
            plainTime: { hour, minute, second: start.second },
          }).epochMilliseconds,
      ),
    );
    for (const t of instants.sort((a, b) => a - b)) {
      if (t < start.epochMilliseconds || t <= last) continue;
      if (t > untilMs) return;
      last = t;
      yield t;
    }
  }
}

function first<T>(iterable: Iterable<T>, predicate: (value: T) => boolean): T | undefined {
  for (const value of iterable) if (predicate(value)) return value;
  return undefined;
}

describe('Recurrence properties', { timeout: 60_000 }, () => {
  it('next(t) is always the first reference occurrence after t', () => {
    fc.assert(
      fc.property(
        calendarRule,
        fc.constantFrom(...ZONES),
        startInstant,
        fc.integer({ min: 0, max: 400 * DAY_MS }),
        (rule, zone, start, offset) => {
          const rec = new Recurrence(rule, resolveStart(start, zone));
          const after = rec.start.epochMilliseconds + offset - 2 * DAY_MS;
          const horizon = after + 800 * DAY_MS;
          const expected = first(referenceOccurrences(rec, after, horizon), (t) => t > after);
          const actual = rec.next(after);
          if (expected === undefined) {
            expect(actual === null || actual > horizon).toBe(true);
          } else {
            expect(actual).toBe(expected);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('iterating next() matches the reference exactly: no skips, no duplicates', () => {
    fc.assert(
      fc.property(calendarRule, fc.constantFrom(...ZONES), startInstant, (rule, zone, start) => {
        const rec = new Recurrence(rule, resolveStart(start, zone));
        const horizon = rec.start.epochMilliseconds + 90 * DAY_MS;
        const actual: number[] = [];
        for (const t of rec.occurrences()) {
          if (t > horizon) break;
          actual.push(t);
        }
        expect(actual).toEqual([...referenceOccurrences(rec, 0, horizon)]);
      }),
      { numRuns: 150 },
    );
  });

  it('a daily wall-clock rule runs exactly once per local day across DST', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        startInstant,
        fc.integer({ min: 0, max: 23 }),
        fc.constantFrom(0, 15, 30, 45),
        (zone, start, hour, minute) => {
          const rec = new Recurrence(
            parseRRule(`FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`),
            resolveStart(start, zone),
          );
          const days = rec
            .take(400)
            .map((t) => Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(zone))
            .map((z) => z.toPlainDate());
          for (let i = 1; i < days.length; i++) {
            const prev = days[i - 1];
            const cur = days[i];
            if (!prev || !cur) throw new Error('unreachable');
            expect(prev.until(cur).days).toBe(1);
          }
        },
      ),
      // 400 days always crosses both DST changes; each run does 400 zone conversions.
      { numRuns: 30 },
    );
  });

  it('intraday rules are evenly spaced in elapsed time', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('MINUTELY', 'HOURLY'),
        fc.integer({ min: 1, max: 90 }),
        fc.constantFrom(...ZONES),
        startInstant,
        fc.integer({ min: -DAY_MS, max: 30 * DAY_MS }),
        (freq, interval, zone, start, offset) => {
          const rec = Recurrence.parse(`FREQ=${freq};INTERVAL=${interval}`, start, zone);
          const step = interval * (freq === 'MINUTELY' ? 60_000 : 3_600_000);
          const after = rec.start.epochMilliseconds + offset;
          const next = rec.next(after);
          expect(next).not.toBeNull();
          if (next === null) return;
          expect(next).toBeGreaterThan(after);
          expect(next - step).toBeLessThanOrEqual(Math.max(after, rec.start.epochMilliseconds - 1));
          expect((next - rec.start.epochMilliseconds) % step).toBe(0);
        },
      ),
    );
  });

  it('next(t) is strictly after t for any rule and time', () => {
    fc.assert(
      fc.property(
        calendarRule,
        fc.constantFrom(...ZONES),
        startInstant,
        fc.integer({ min: RANGE_START, max: RANGE_END }),
        (rule, zone, start, after) => {
          const next = new Recurrence(rule, resolveStart(start, zone)).next(after);
          if (next !== null) expect(next).toBeGreaterThan(after);
        },
      ),
    );
  });
});
