import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  FakeClock,
  MemoryStorage,
  RecurrenceError,
  Scheduler,
  TaskCancelledError,
  TaskTimeoutError,
  UnknownTaskTypeError,
  type Clock,
  type SchedulerEvents,
  type StorageAdapter,
  type StoredTask,
  type TaskContext,
} from '../src/index.js';

const T0 = Date.parse('2026-06-01T00:00:00Z');
const SECOND = 1_000;
const DAY = 86_400_000;

interface Payloads {
  job: { label: string };
  slow: { ms: number };
  flaky: { failTimes: number };
}

/** Waits `ms` on the given clock; rejects with the abort reason if the signal fires. */
function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = clock.setTimer(resolve, ms);
    signal.addEventListener('abort', () => {
      cancel();
      reject(signal.reason as Error);
    });
  });
}

function setup(options: { concurrency?: number; storage?: StorageAdapter; clock?: Clock } = {}) {
  const clock = options.clock ?? new FakeClock(T0);
  const storage = options.storage ?? new MemoryStorage();
  const ran: string[] = [];
  const contexts: TaskContext<unknown>[] = [];
  const scheduler = new Scheduler<Payloads>({
    clock,
    storage,
    concurrency: options.concurrency ?? 1,
    random: () => 0.5,
    handlers: {
      job: (ctx) => {
        contexts.push(ctx);
        ran.push(ctx.payload.label);
      },
      slow: async (ctx) => {
        contexts.push(ctx);
        await sleep(clock, ctx.payload.ms, ctx.signal);
        ran.push(`slow:${ctx.payload.ms}`);
      },
      flaky: (ctx) => {
        contexts.push(ctx);
        if (ctx.attempt <= ctx.payload.failTimes) throw new Error(`boom ${ctx.attempt}`);
        ran.push(`flaky:${ctx.attempt}`);
      },
    },
  });
  const events: string[] = [];
  const eventNames: (keyof SchedulerEvents<Payloads>)[] = [
    'taskScheduled',
    'taskStarted',
    'taskCompleted',
    'taskFailed',
    'taskMissed',
    'taskCancelled',
    'error',
  ];
  for (const name of eventNames) scheduler.on(name, () => events.push(name));
  return { scheduler, clock: clock as FakeClock, storage, ran, contexts, events };
}

describe('Scheduler: one-off tasks', () => {
  it('runs a task at its time, not before', async () => {
    const { scheduler, clock, ran } = setup();
    const task = await scheduler.add('job', { label: 'a' }, { delayMs: 5 * SECOND });
    await scheduler.start();
    await clock.advance(4 * SECOND);
    expect(ran).toEqual([]);
    await clock.advance(SECOND);
    expect(ran).toEqual(['a']);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'done', runs: 1, nextRunAt: null });
    await scheduler.stop();
  });

  it('accepts Date, epoch ms and ISO strings with an offset', async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('job', { label: 'date' }, { at: new Date(T0 + 3000) });
    await scheduler.add('job', { label: 'ms' }, { at: T0 + 1000 });
    await scheduler.add('job', { label: 'iso' }, { at: '2026-06-01T03:00:02+03:00' });
    await scheduler.start();
    await clock.advance(5 * SECOND);
    expect(ran).toEqual(['ms', 'iso', 'date']);
  });

  it('runs tasks whose time has already passed immediately', async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('job', { label: 'late' }, { at: T0 - DAY });
    await scheduler.start();
    await clock.advance(0);
    expect(ran).toEqual(['late']);
  });

  it('does not run anything before start()', async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('job', { label: 'a' }, { delayMs: 0 });
    await clock.advance(DAY);
    expect(ran).toEqual([]);
    expect(scheduler.isRunning).toBe(false);
  });
});

describe('Scheduler: ordering', () => {
  it('runs due tasks by priority, then earliest deadline, then insertion order', async () => {
    const { scheduler, clock, ran } = setup();
    const at = { at: T0 + SECOND };
    await scheduler.add('job', { label: 'low' }, at, { priority: 0 });
    await scheduler.add('job', { label: 'high-late-deadline' }, at, {
      priority: 5,
      deadlineMs: 60_000,
    });
    await scheduler.add('job', { label: 'high-no-deadline' }, at, { priority: 5 });
    await scheduler.add('job', { label: 'high-early-deadline' }, at, {
      priority: 5,
      deadlineMs: 30_000,
    });
    await scheduler.add('job', { label: 'low-2' }, at, { priority: 0 });
    await scheduler.start();
    await clock.advance(2 * SECOND);
    expect(ran).toEqual([
      'high-early-deadline',
      'high-late-deadline',
      'high-no-deadline',
      'low',
      'low-2',
    ]);
  });

  it('runs tasks at different times in time order regardless of priority', async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('job', { label: 'second' }, { delayMs: 2000 }, { priority: 100 });
    await scheduler.add('job', { label: 'first' }, { delayMs: 1000 }, { priority: -100 });
    await scheduler.start();
    await clock.advance(3000);
    expect(ran).toEqual(['first', 'second']);
  });

  it('limits parallel work to `concurrency`', async () => {
    const { scheduler, clock, ran } = setup({ concurrency: 2 });
    for (const ms of [1000, 1000, 1000]) await scheduler.add('slow', { ms }, { delayMs: 0 });
    await scheduler.start();
    await clock.advance(1000);
    expect(ran).toEqual(['slow:1000', 'slow:1000']);
    await clock.advance(1000);
    expect(ran).toHaveLength(3);
  });

  it('rejects an invalid concurrency', () => {
    expect(() => new Scheduler({ handlers: {}, concurrency: 0 })).toThrow(RangeError);
  });
});

describe('Scheduler: recurring tasks', () => {
  it('runs daily at 09:00 Helsinki time and stays pending', async () => {
    const { scheduler, clock, ran, contexts } = setup();
    const task = await scheduler.add(
      'job',
      { label: 'daily' },
      { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', timeZone: 'Europe/Helsinki' },
    );
    expect(task.nextRunAt).toBe(Date.parse('2026-06-01T06:00:00Z'));
    await scheduler.start();
    await clock.advance(3 * DAY);
    expect(ran).toEqual(['daily', 'daily', 'daily']);
    expect(contexts.map((c) => new Date(c.scheduledAt).toISOString())).toEqual([
      '2026-06-01T06:00:00.000Z',
      '2026-06-02T06:00:00.000Z',
      '2026-06-03T06:00:00.000Z',
    ]);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'pending',
      runs: 3,
      nextRunAt: Date.parse('2026-06-04T06:00:00Z'),
    });
  });

  it('finishes when the rule runs out (COUNT)', async () => {
    const { scheduler, clock, ran } = setup();
    const task = await scheduler.add(
      'job',
      { label: 'x' },
      { rrule: 'FREQ=HOURLY;COUNT=2', timeZone: 'UTC', start: T0 },
    );
    await scheduler.start();
    await clock.advance(DAY);
    expect(ran).toEqual(['x', 'x']);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'done', nextRunAt: null });
  });

  it('rejects a rule with no future occurrences', async () => {
    const { scheduler } = setup();
    await expect(
      scheduler.add('job', { label: 'x' }, { rrule: 'FREQ=DAILY;COUNT=1', start: T0 - DAY }),
    ).rejects.toThrow(RecurrenceError);
  });

  it('coalesces occurrences missed while the process was down into one run', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    const task = await first.scheduler.add(
      'job',
      { label: 'daily' },
      { rrule: 'FREQ=DAILY;BYHOUR=9', timeZone: 'UTC', start: T0 },
    );
    await first.scheduler.stop();

    // Three days later, a new process starts with the same storage.
    const second = setup({ storage, clock: new FakeClock(T0 + 3 * DAY + 60 * 60 * 1000) });
    await second.scheduler.start();
    await second.clock.advance(0);
    expect(second.ran).toEqual(['daily']);
    expect(second.scheduler.get(task.id)?.nextRunAt).toBe(Date.parse('2026-06-04T09:00:00Z'));
  });
});

describe('Scheduler: retries and timeouts', () => {
  it('retries with exponential backoff and then succeeds', async () => {
    const { scheduler, clock, ran, contexts, events } = setup();
    const task = await scheduler.add(
      'flaky',
      { failTimes: 2 },
      { delayMs: 0 },
      { retry: { maxAttempts: 3, baseDelayMs: 1000, jitter: 'none' } },
    );
    const failures: { retryAt: number | null; message: string }[] = [];
    scheduler.on('taskFailed', ({ retryAt, error }) =>
      failures.push({ retryAt, message: error.message }),
    );
    await scheduler.start();
    await clock.advance(10 * SECOND);
    expect(failures).toEqual([
      { retryAt: T0 + 1000, message: 'boom 1' },
      { retryAt: T0 + 3000, message: 'boom 2' },
    ]);
    expect(contexts.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(ran).toEqual(['flaky:3']);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'done', runs: 1, failures: 0 });
    expect(scheduler.get(task.id)?.lastError).toBeUndefined();
    expect(events.filter((e) => e === 'taskFailed')).toHaveLength(2);
  });

  it('uses full jitter: a random delay up to the exponential delay', async () => {
    const { scheduler, clock } = setup();
    await scheduler.add(
      'flaky',
      { failTimes: 1 },
      { delayMs: 0 },
      { retry: { maxAttempts: 2, baseDelayMs: 1000 } },
    );
    const retryAt = new Promise<number | null>((resolve) =>
      scheduler.once('taskFailed', (e) => {
        resolve(e.retryAt);
      }),
    );
    await scheduler.start();
    await clock.advance(0);
    expect(await retryAt).toBe(T0 + 500); // random() = 0.5
  });

  it('marks the task failed when attempts run out', async () => {
    const { scheduler, clock } = setup();
    const task = await scheduler.add(
      'flaky',
      { failTimes: 5 },
      { delayMs: 0 },
      { retry: { maxAttempts: 2, baseDelayMs: 10, jitter: 'none' } },
    );
    const final = vi.fn();
    scheduler.on('taskFailed', (e) => {
      if (!e.willRetry) final(e.error.message);
    });
    await scheduler.start();
    await clock.advance(SECOND);
    expect(final).toHaveBeenCalledWith('boom 2');
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'failed',
      failures: 1,
      lastError: 'boom 2',
    });
  });

  it('a failed occurrence of a recurring task still schedules the next one', async () => {
    const { scheduler, clock } = setup();
    const task = await scheduler.add(
      'flaky',
      { failTimes: 1 },
      { rrule: 'FREQ=HOURLY', timeZone: 'UTC', start: T0 },
    );
    await scheduler.start();
    await clock.advance(0);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'pending',
      failures: 1,
      nextRunAt: T0 + 3_600_000,
    });
  });

  it('times out a slow task and aborts its signal', async () => {
    const { scheduler, clock, contexts } = setup();
    const errors: Error[] = [];
    scheduler.on('taskFailed', (e) => errors.push(e.error));
    const task = await scheduler.add('slow', { ms: 10_000 }, { delayMs: 0 }, { timeoutMs: 2000 });
    await scheduler.start();
    await clock.advance(2000);
    expect(errors[0]).toBeInstanceOf(TaskTimeoutError);
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'failed',
      lastError: 'task timed out after 2000 ms',
    });
  });

  it('times out even if the handler ignores the signal', async () => {
    const clock = new FakeClock(T0);
    const scheduler = new Scheduler<{ stuck: null }>({
      clock,
      handlers: { stuck: () => new Promise<void>(() => undefined) },
    });
    const task = await scheduler.add('stuck', null, { delayMs: 0 }, { timeoutMs: 100 });
    await scheduler.start();
    await clock.advance(100);
    expect(scheduler.get(task.id)?.state).toBe('failed');
  });
});

describe('Scheduler: deadlines', () => {
  it('skips an occurrence whose start deadline passed while waiting for a slot', async () => {
    const { scheduler, clock, ran } = setup();
    // Higher priority, so it takes the only slot even though it has no deadline.
    await scheduler.add('slow', { ms: 5000 }, { delayMs: 0 }, { priority: 1 });
    const urgent = await scheduler.add(
      'job',
      { label: 'urgent' },
      { delayMs: 0 },
      { deadlineMs: 1000 },
    );
    const missed = vi.fn();
    scheduler.on('taskMissed', missed);
    await scheduler.start();
    await clock.advance(10 * SECOND);
    expect(ran).toEqual(['slow:5000']);
    expect(missed).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: T0, deadline: T0 + 1000, action: 'skip' }),
    );
    expect(scheduler.get(urgent.id)).toMatchObject({ state: 'missed', misses: 1, runs: 0 });
  });

  it("runs late when onMissed is 'run'", async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('slow', { ms: 5000 }, { delayMs: 0 }, { priority: 1 });
    await scheduler.add(
      'job',
      { label: 'late' },
      { delayMs: 0 },
      { deadlineMs: 1000, onMissed: 'run' },
    );
    await scheduler.start();
    await clock.advance(10 * SECOND);
    expect(ran).toEqual(['slow:5000', 'late']);
  });

  it('a missed occurrence of a recurring task moves on to the next one', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    const task = await first.scheduler.add(
      'job',
      { label: 'x' },
      { rrule: 'FREQ=DAILY;BYHOUR=9', timeZone: 'UTC', start: T0 },
      { deadlineMs: 60_000 },
    );
    await first.scheduler.stop();
    const second = setup({ storage, clock: new FakeClock(Date.parse('2026-06-01T10:00:00Z')) });
    await second.scheduler.start();
    await second.clock.advance(0);
    expect(second.ran).toEqual([]);
    expect(second.scheduler.get(task.id)).toMatchObject({
      state: 'pending',
      misses: 1,
      nextRunAt: Date.parse('2026-06-02T09:00:00Z'),
    });
  });
});

describe('Scheduler: cancellation', () => {
  it('cancels a pending task so it never runs', async () => {
    const { scheduler, clock, ran, events } = setup();
    const task = await scheduler.add('job', { label: 'a' }, { delayMs: 1000 });
    await scheduler.start();
    expect(await scheduler.cancel(task.id)).toBe(true);
    await clock.advance(5000);
    expect(ran).toEqual([]);
    expect(scheduler.get(task.id)?.state).toBe('cancelled');
    expect(events).toContain('taskCancelled');
    expect(await scheduler.cancel(task.id)).toBe(false);
    expect(await scheduler.cancel('missing')).toBe(false);
  });

  it('cancels a running task by aborting its signal, without retrying', async () => {
    const { scheduler, clock, contexts } = setup();
    const task = await scheduler.add(
      'slow',
      { ms: 10_000 },
      { delayMs: 0 },
      { retry: { maxAttempts: 3 } },
    );
    await scheduler.start();
    await clock.advance(1000);
    await scheduler.cancel(task.id);
    await clock.advance(30_000);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.signal.reason).toBeInstanceOf(TaskCancelledError);
    expect(scheduler.get(task.id)?.state).toBe('cancelled');
  });

  it('cannot cancel a finished task', async () => {
    const { scheduler, clock } = setup();
    const task = await scheduler.add('job', { label: 'a' }, { delayMs: 0 });
    await scheduler.start();
    await clock.advance(0);
    expect(await scheduler.cancel(task.id)).toBe(false);
  });

  it('cancels through an AbortSignal passed to add()', async () => {
    const { scheduler, clock, ran } = setup();
    const controller = new AbortController();
    const task = await scheduler.add(
      'job',
      { label: 'a' },
      { delayMs: 1000 },
      { signal: controller.signal },
    );
    await scheduler.start();
    controller.abort();
    await clock.advance(5000);
    expect(ran).toEqual([]);
    expect(scheduler.get(task.id)?.state).toBe('cancelled');

    const already = AbortSignal.abort();
    const other = await scheduler.add('job', { label: 'b' }, { delayMs: 0 }, { signal: already });
    await clock.advance(1000);
    expect(scheduler.get(other.id)?.state).toBe('cancelled');
  });

  it('remove() deletes a task, even while it runs', async () => {
    const { scheduler, clock, ran } = setup();
    const task = await scheduler.add('slow', { ms: 5000 }, { delayMs: 0 });
    await scheduler.start();
    await clock.advance(1000);
    expect(await scheduler.remove(task.id)).toBe(true);
    await clock.advance(10_000);
    expect(ran).toEqual([]);
    expect(scheduler.get(task.id)).toBeUndefined();
    expect(await scheduler.remove(task.id)).toBe(false);
  });
});

describe('Scheduler: persistence and lifecycle', () => {
  it('saves tasks and a new scheduler picks them up', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    const task = await first.scheduler.add(
      'job',
      { label: 'persisted' },
      { delayMs: DAY },
      { name: 'nightly' },
    );
    await first.scheduler.stop();
    expect(storage.snapshot()).toEqual([expect.objectContaining({ id: task.id, name: 'nightly' })]);

    const second = setup({ storage });
    await second.scheduler.start();
    expect(second.scheduler.list().map((t) => t.id)).toEqual([task.id]);
    await second.clock.advance(DAY);
    expect(second.ran).toEqual(['persisted']);
    expect(storage.snapshot()[0]).toMatchObject({ state: 'done', runs: 1 });
  });

  it('re-runs an attempt that was running when the process died (at-least-once)', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    const task = await first.scheduler.add('slow', { ms: 5000 }, { delayMs: 0 });
    await first.scheduler.start();
    await first.clock.advance(1000);
    expect(storage.snapshot()[0]?.state).toBe('running');
    // Simulate a crash: the first scheduler is abandoned without stop().

    const second = setup({ storage, clock: new FakeClock(T0 + 60_000) });
    await second.scheduler.load();
    expect(second.scheduler.get(task.id)).toMatchObject({ state: 'pending', attempt: 0 });
    await second.scheduler.start();
    await second.clock.advance(5000);
    expect(second.ran).toEqual(['slow:5000']);
    expect(second.contexts[0]?.attempt).toBe(1);
  });

  it('stop() waits for running tasks to finish', async () => {
    const { scheduler, clock, ran } = setup();
    await scheduler.add('slow', { ms: 1000 }, { delayMs: 0 });
    await scheduler.add('job', { label: 'later' }, { delayMs: 500 });
    await scheduler.start();
    await clock.advance(0);
    const stopped = scheduler.stop();
    await clock.advance(5000);
    await stopped;
    expect(ran).toEqual(['slow:1000']);
  });

  it('stop({ abortRunning }) aborts running tasks and keeps them for the next start', async () => {
    const storage = new MemoryStorage();
    const { scheduler, clock, ran } = setup({ storage });
    const task = await scheduler.add(
      'slow',
      { ms: 5000 },
      { delayMs: 0 },
      { retry: { maxAttempts: 1 } },
    );
    await scheduler.start();
    await clock.advance(1000);
    await scheduler.stop({ abortRunning: true });
    expect(ran).toEqual([]);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'pending', attempt: 0, failures: 0 });
    await scheduler.start();
    await clock.advance(5000);
    expect(ran).toEqual(['slow:5000']);
  });

  it('start() and stop() are idempotent', async () => {
    const { scheduler } = setup();
    await scheduler.start();
    await scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('fails to load tasks whose handler is not registered', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    await first.scheduler.add('job', { label: 'x' }, { delayMs: 0 });
    const stored = storage.snapshot();
    const renamed: StoredTask[] = stored.map((t) => ({ ...t, type: 'gone' }));
    const second = setup({ storage: new MemoryStorage(renamed) });
    await expect(second.scheduler.start()).rejects.toThrow(UnknownTaskTypeError);
  });

  it('reports storage failures as error events instead of crashing', async () => {
    const failing: StorageAdapter = {
      load: () => Promise.resolve([]),
      save: () => Promise.reject(new Error('disk full')),
    };
    const { scheduler } = setup({ storage: failing });
    const errors: string[] = [];
    scheduler.on('error', (e) => errors.push(e.error.message));
    await scheduler.add('job', { label: 'x' }, { delayMs: 0 });
    expect(errors).toContain('disk full');
  });

  it('reports listener exceptions as error events', async () => {
    const { scheduler } = setup();
    const errors: string[] = [];
    scheduler.on('error', (e) => errors.push(e.error.message));
    scheduler.on('taskScheduled', () => {
      throw new Error('bad listener');
    });
    await scheduler.add('job', { label: 'x' }, { delayMs: 0 });
    expect(errors).toEqual(['bad listener']);
  });

  it('keeps a task on time when the clock caps long timer delays', async () => {
    // A clock whose timers never wait more than 1 s, like setTimeout's 24.8-day cap.
    const fake = new FakeClock(T0);
    const capped: Clock = {
      now: () => fake.now(),
      setTimer: (cb, ms) => fake.setTimer(cb, Math.min(ms, 1000)),
    };
    const { scheduler, ran } = setup({ clock: capped });
    await scheduler.add('job', { label: 'far' }, { delayMs: 10_000 });
    await scheduler.start();
    await fake.advance(9_999);
    expect(ran).toEqual([]);
    await fake.advance(1);
    expect(ran).toEqual(['far']);
  });

  it('lists tasks by next run time, finished ones last', async () => {
    const { scheduler, clock } = setup();
    const done = await scheduler.add('job', { label: 'done' }, { delayMs: 0 });
    const later = await scheduler.add('job', { label: 'later' }, { delayMs: 5000 });
    const sooner = await scheduler.add('job', { label: 'sooner' }, { delayMs: 1000 });
    await scheduler.start();
    await clock.advance(0);
    expect(scheduler.list().map((t) => t.id)).toEqual([sooner.id, later.id, done.id]);
  });
});

describe('Scheduler: input validation', () => {
  it.each([
    ['a duplicate id', { id: 'same' }, 'already exists'],
    ['a non-finite priority', { priority: Number.NaN }, 'priority must be a finite number'],
    ['a negative deadline', { deadlineMs: -1 }, 'deadlineMs must be >= 0'],
    ['a zero timeout', { timeoutMs: 0 }, 'timeoutMs must be > 0'],
    ['zero attempts', { retry: { maxAttempts: 0 } }, 'retry.maxAttempts'],
  ])('rejects %s', async (_, options, message) => {
    const { scheduler } = setup();
    await scheduler.add('job', { label: 'x' }, { delayMs: 0 }, { id: 'same' });
    await expect(scheduler.add('job', { label: 'y' }, { delayMs: 0 }, options)).rejects.toThrow(
      message,
    );
  });

  it('rejects times that are not exact instants', async () => {
    const { scheduler } = setup();
    await expect(scheduler.add('job', { label: 'x' }, { at: '2026-06-01T09:00' })).rejects.toThrow(
      'include Z or an offset',
    );
    await expect(scheduler.add('job', { label: 'x' }, { at: Number.NaN })).rejects.toThrow(
      'finite',
    );
    await expect(scheduler.add('job', { label: 'x' }, { delayMs: Infinity })).rejects.toThrow(
      'finite',
    );
  });

  it('rejects unknown task types at runtime too', async () => {
    const { scheduler } = setup();
    await expect(scheduler.add('nope' as 'job', { label: 'x' }, { delayMs: 0 })).rejects.toThrow(
      UnknownTaskTypeError,
    );
  });
});

describe('Scheduler: types', () => {
  it('infers payload types from handlers and checks add() and events', async () => {
    const clock = new FakeClock(T0);
    const scheduler = new Scheduler({
      clock,
      handlers: {
        email: (ctx: TaskContext<{ to: string }>) => {
          expectTypeOf(ctx.payload.to).toBeString();
        },
        report: (ctx: TaskContext<{ id: number }>) => {
          expectTypeOf(ctx.payload.id).toBeNumber();
        },
      },
    });
    await scheduler.add('email', { to: 'a@example.com' }, { delayMs: 0 });
    // @ts-expect-error wrong payload shape for "email"
    await scheduler.add('email', { to: 1 }, { delayMs: 0 }).catch(() => undefined);
    // @ts-expect-error unknown task type
    await scheduler.add('sms', { to: 'x' }, { delayMs: 0 }).catch(() => undefined);
    // @ts-expect-error unknown event name
    scheduler.on('taskExploded', () => undefined);

    scheduler.on('taskCompleted', ({ task }) => {
      // `type` narrows `payload`.
      if (task.type === 'report') expectTypeOf(task.payload).toEqualTypeOf<{ id: number }>();
      else expectTypeOf(task.payload).toEqualTypeOf<{ to: string }>();
    });
    // Types are compile-time only: the bad payload above was still added at runtime.
    expect(scheduler.list()).toHaveLength(2);
  });

  it('accepts payload maps declared as interfaces', () => {
    interface Jobs {
      resize: { width: number; height: number };
      purge: null;
    }
    const scheduler = new Scheduler<Jobs>({
      handlers: { resize: () => undefined, purge: () => undefined },
    });
    expect(scheduler.list()).toEqual([]);
  });
});
