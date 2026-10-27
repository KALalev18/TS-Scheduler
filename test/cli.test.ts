import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parseInteger, table } from '../src/cli/format.js';
import { lockPath } from '../src/cli/lock.js';
import { runCli, type CliIO } from '../src/cli/program.js';
import { FakeClock } from '../src/clock.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-scheduler-cli-'));
  file = join(dir, 'schedule.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(options: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env: { TS_SCHEDULER_FILE: file },
    color: false,
    ...options,
  };
  return {
    out,
    err,
    run: (...args: string[]) => runCli(args, io),
    text: () => out.join('\n'),
  };
}

describe('cli: next', () => {
  it('previews a rule across the spring-forward change', async () => {
    const cli = harness();
    const code = await cli.run(
      'next',
      'FREQ=DAILY;BYHOUR=2;BYMINUTE=30',
      '--tz',
      'Europe/Berlin',
      '--start',
      '2026-03-27T00:00',
      '-n',
      '4',
    );
    expect(code).toBe(0);
    expect(cli.out).toEqual([
      'FREQ=DAILY;BYHOUR=2;BYMINUTE=30 in Europe/Berlin',
      '  2026-03-27 02:30:00+01:00',
      '  2026-03-28 02:30:00+01:00',
      '  2026-03-29 03:30:00+02:00',
      '  2026-03-30 02:30:00+02:00',
    ]);
  });

  it('says when a rule runs out', async () => {
    const cli = harness();
    await cli.run('next', 'FREQ=DAILY;COUNT=2', '--tz', 'UTC', '--start', '2026-01-01T09:00');
    expect(cli.out.at(-1)).toBe('  (no more occurrences)');
  });

  it('reports invalid rules with exit code 1', async () => {
    const cli = harness();
    expect(await cli.run('next', 'FREQ=YEARLY')).toBe(1);
    expect(cli.err[0]).toMatch(/^error: FREQ must be one of/);
  });
});

describe('cli: add, list, remove', () => {
  it('adds tasks, lists them soonest first, and removes by id prefix', async () => {
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    const cli = harness({ clock });
    expect(await cli.run('add', 'later', '--in', '1h')).toBe(0);
    expect(await cli.run('add', 'sooner', '--at', '2026-06-01T00:10:00Z', '-p', '3')).toBe(0);
    expect(
      await cli.run(
        'add',
        'standup',
        '--rrule',
        'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30',
        '--tz',
        'Europe/Helsinki',
        '--name',
        'Monday standup',
      ),
    ).toBe(0);
    expect(cli.out[0]).toMatch(/^added "later" \([0-9a-f]{8}\), first run 2026-06-01 \d\d:00:00/);
    expect(cli.out[2]).toMatch(/^added "Monday standup" \([0-9a-f]{8}\), first run /);

    cli.out.length = 0;
    await cli.run('list', '--tz', 'UTC');
    const [header, ...rows] = cli.out[0]?.split('\n') ?? [];
    expect(header).toMatch(/^ID\s+TASK\s+STATE\s+PRI\s+NEXT RUN/);
    expect(rows.map((r) => r.split(/\s{2,}/)[1])).toEqual(['sooner', 'later', 'Monday standup']);
    expect(rows[2]).toContain('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30 (Europe/Helsinki)');
    expect(rows[2]).toContain('2026-06-01 06:30:00+00:00');

    const id = rows[0]?.slice(0, 8) ?? '';
    cli.out.length = 0;
    expect(await cli.run('rm', id.slice(0, 6))).toBe(0);
    expect(cli.out).toEqual([`removed ${id}`]);
    cli.out.length = 0;
    await cli.run('ls');
    expect(cli.text()).not.toContain('sooner');
  });

  it('prints "no tasks" for an empty file', async () => {
    const cli = harness();
    await cli.run('list');
    expect(cli.out).toEqual(['no tasks']);
  });

  it('rejects unknown and ambiguous ids', async () => {
    const ids = ['aaaa1111-0000', 'aaaa2222-0000'];
    const cli = harness();
    expect(await cli.run('rm', 'zzz')).toBe(1);
    expect(cli.err).toEqual(['error: no task matches "zzz"']);
    // Two tasks whose ids share a prefix: use the library to create them.
    const { Scheduler, JsonFileStorage } = await import('../src/index.js');
    const scheduler = new Scheduler<{
      echo: { message: string; failFirst: number; workMs: number };
    }>({
      handlers: { echo: () => undefined },
      storage: new JsonFileStorage(file),
      generateId: () => ids.shift() ?? 'x',
    });
    for (let i = 0; i < 2; i++) {
      await scheduler.add('echo', { message: 'm', failFirst: 0, workMs: 0 }, { delayMs: 1000 });
    }
    await scheduler.stop();
    cli.err.length = 0;
    expect(await cli.run('rm', 'aaaa')).toBe(1);
    expect(cli.err).toEqual(['error: "aaaa" matches 2 tasks']);
  });

  it.each([
    [['add', 'x', '--in', 'soon'], 'invalid duration "soon"'],
    [['add', 'x', '--at', '2026-06-01T09:00'], 'include Z or an offset'],
    [['add', 'x', '--rrule', 'FREQ=DAILY', '--tz', 'Mars/Base'], 'MARS/BASE'],
    [['add', 'x', '--retries', '-1'], '--retries must be an integer >= 0'],
  ])('rejects bad input: %j', async (args, message) => {
    const cli = harness();
    expect(await cli.run(...args)).toBe(1);
    expect(cli.err.join('\n')).toContain(message);
  });

  it('lets commander report usage errors', async () => {
    const cli = harness();
    expect(await cli.run('add')).toBe(1);
    expect(cli.err.join('\n')).toContain("missing required argument 'message'");
    expect(await cli.run('add', 'x', '--at', '2026-06-01T09:00:00Z', '--in', '1s')).toBe(1);
    expect(await cli.run('--version')).toBe(0);
  });
});

describe('cli: run', () => {
  /**
   * The CLI does real file IO, so fake time is advanced in small steps with a
   * short real pause between them until the command finishes.
   */
  async function drive(clock: FakeClock, done: Promise<number>, stepMs = 100) {
    const state = { finished: false };
    void done.finally(() => (state.finished = true));
    for (let i = 0; i < 1000 && !state.finished; i++) {
      await clock.advance(stepMs);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return done;
  }

  const runFor = (cli: ReturnType<typeof harness>, clock: FakeClock, ms: number) =>
    drive(clock, cli.run('run', '--for', `${ms}ms`));

  it('runs tasks and shows retries with backoff', async () => {
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    const cli = harness({ clock });
    await cli.run('add', 'backup', '--in', '1s', '-p', '5');
    await cli.run(
      'add',
      'upload',
      '--in',
      '1s',
      '--retries',
      '1',
      '--fail-first',
      '1',
      '--backoff',
      '100ms',
    );
    cli.out.length = 0;
    expect(await runFor(cli, clock, 5000)).toBe(0);
    const log = cli.text();
    expect(log).toContain('running 2 pending tasks,');
    expect(log).toMatch(/started\s+\w{8}\s+backup/);
    expect(log).toMatch(/failed\s+\w{8}\s+upload simulated failure 1\/1, retry in/);
    expect(log).toMatch(/started\s+\w{8}\s+upload \(attempt 2\)/);
    expect(log).toContain('↳ output: upload');
    expect(log.indexOf('output: backup')).toBeLessThan(log.indexOf('output: upload'));
    // Times include milliseconds, so retry spacing is visible.
    expect(log).toMatch(/^\d\d:\d\d:\d\d\.\d{3} {2}started/m);
    expect(log).toContain('stopping…');
  });

  it('prints "runs now" and exact doubling with --jitter none', async () => {
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    const cli = harness({ clock });
    await cli.run(
      'add',
      'upload',
      '--retries',
      '2',
      '--fail-first',
      '2',
      '--backoff',
      '200ms',
      '--jitter',
      'none',
    );
    expect(cli.out[0]).toMatch(/^added "upload" \([0-9a-f]{8}\), runs now$/);
    cli.out.length = 0;
    await runFor(cli, clock, 2000);
    expect(cli.text()).toContain('simulated failure 1/2, retry in 200ms');
    expect(cli.text()).toContain('simulated failure 2/2, retry in 400ms');
  });

  it('shows missed deadlines, timeouts and the next occurrence', async () => {
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    const cli = harness({ clock });
    await cli.run('add', 'slow', '--work', '2s', '-p', '1');
    await cli.run('add', 'urgent', '--deadline', '500ms');
    await cli.run('add', 'stuck', '--work', '1h', '--timeout', '1s');
    await cli.run(
      'add',
      'tick',
      '--rrule',
      'FREQ=MINUTELY',
      '--tz',
      'UTC',
      '--start',
      '2026-06-01T00:00:05Z',
    );
    cli.out.length = 0;
    await runFor(cli, clock, 10_000);
    const log = cli.text();
    expect(log).toMatch(/missed\s+\w{8}\s+urgent missed its deadline by .*, skipped/);
    expect(log).toMatch(/failed\s+\w{8}\s+stuck task timed out after 1000 ms, giving up/);
    expect(log).toMatch(/next\s+\w{8}\s+tick at 2026-06-01/);
  });

  it('aborts running tasks on a second interrupt', async () => {
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    let interrupt: (how: 'graceful' | 'abort') => void = () => undefined;
    const cli = harness({
      clock,
      waitForInterrupt: () => new Promise((resolve) => (interrupt = resolve)),
    });
    await cli.run('add', 'long job', '--work', '1h');
    const done = cli.run('run');
    while (!cli.text().includes('started')) await new Promise((resolve) => setTimeout(resolve, 5));
    interrupt('abort');
    expect(await drive(clock, done)).toBe(0);
    expect(cli.text()).toContain('aborting running tasks…');
    cli.out.length = 0;
    await cli.run('ls');
    expect(cli.text()).toMatch(/long job\s+pending/);
  });
});

describe('cli: run lock', () => {
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  it('refuses a second run and edits while a run is active', async () => {
    let interrupt: (how: 'graceful' | 'abort') => void = () => undefined;
    const first = harness({
      waitForInterrupt: () => new Promise((resolve) => (interrupt = resolve)),
    });
    const running = first.run('run');
    while (!first.text().includes('running'))
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await exists(lockPath(file))).toBe(true);

    const second = harness();
    expect(await second.run('run')).toBe(1);
    expect(await second.run('add', 'x', '--in', '1s')).toBe(1);
    expect(await second.run('rm', 'abc')).toBe(1);
    expect(second.err).toHaveLength(3);
    for (const message of second.err) {
      expect(message).toContain(`"ts-scheduler run" (process ${process.pid}) is using`);
    }
    // Read-only commands still work.
    expect(await second.run('list')).toBe(0);

    interrupt('graceful');
    expect(await running).toBe(0);
    expect(await exists(lockPath(file))).toBe(false);
    expect(await second.run('add', 'x', '--in', '1s')).toBe(0);
  });

  it('takes over a lock left by a process that no longer exists', async () => {
    await writeFile(lockPath(file), '2147483646');
    const cli = harness();
    expect(await cli.run('run', '--for', '10ms')).toBe(0);
    expect(cli.err).toEqual([]);
    expect(await exists(lockPath(file))).toBe(false);
  });

  it('validates options before taking the lock', async () => {
    const cli = harness();
    expect(await cli.run('run', '--for', 'forever')).toBe(1);
    expect(await exists(lockPath(file))).toBe(false);
  });
});

describe('cli: format helpers', () => {
  it('parses durations', () => {
    expect([
      parseDuration('250ms'),
      parseDuration('2s'),
      parseDuration('1.5m'),
      parseDuration('2h'),
      parseDuration('1d'),
    ]).toEqual([250, 2000, 90_000, 7_200_000, 86_400_000]);
    expect(() => parseDuration('5 minutes')).toThrow('invalid duration');
    expect(() => parseInteger('1.5', 'n')).toThrow('n must be an integer >= 0');
  });

  it('formats durations', () => {
    expect([500, 1500, 60_000, 90 * 60_000, 3_600_000].map(formatDuration)).toEqual([
      '500ms',
      '1.5s',
      '1m',
      '1.5h',
      '1h',
    ]);
  });

  it('aligns table columns', () => {
    expect(table(['A', 'BB'], [['long', 'x']])).toBe('A     BB\nlong  x');
  });
});
