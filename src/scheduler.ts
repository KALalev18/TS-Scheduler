import { randomUUID } from 'node:crypto';
import { Temporal } from 'temporal-polyfill';
import { systemClock, type CancelTimer, type Clock } from './clock.js';
import { TaskCancelledError, TaskTimeoutError, UnknownTaskTypeError, toError } from './errors.js';
import { TypedEmitter } from './events.js';
import { PriorityQueue } from './priority-queue.js';
import { Recurrence, RecurrenceError, type StartInput } from './recurrence.js';
import { backoffDelay, resolveRetry, type RetryPolicy } from './retry.js';
import { transition, type TaskState } from './state.js';
import { MemoryStorage } from './storage/memory.js';
import {
  copyStoredTask,
  type JsonValue,
  type StorageAdapter,
  type StoredTask,
} from './storage/schema.js';

/**
 * Constraint for a map from task type name to payload type: every payload must
 * be JSON so it can be stored. Written as a mapped type over `P`'s own keys so
 * both `type` aliases and `interface`s are accepted.
 */
export type PayloadMap<P> = { readonly [K in keyof P]: JsonValue };

export interface TaskContext<T> {
  readonly id: string;
  readonly name: string | undefined;
  readonly payload: T;
  /** 1 for the first attempt of an occurrence, 2 for the first retry, and so on. */
  readonly attempt: number;
  /** Nominal time of this occurrence (epoch ms); retries keep the same value. */
  readonly scheduledAt: number;
  /** Aborted on cancellation, timeout, or `stop({ abortRunning: true })`. */
  readonly signal: AbortSignal;
}

export type TaskHandler<T> = (context: TaskContext<T>) => Promise<void> | void;

export type Handlers<P extends PayloadMap<P>> = { readonly [K in keyof P]: TaskHandler<P[K]> };

/** When a task should run. */
export type ScheduleInput =
  /** Once, at an exact time. Strings need a `Z` or offset (e.g. `2026-06-01T09:00:00+03:00`). */
  | { readonly at: Date | number | string }
  /** Once, `delayMs` from now. */
  | { readonly delayMs: number }
  /** Repeatedly, by an RRULE (see `Recurrence`). `start` defaults to now. */
  | { readonly rrule: string; readonly timeZone?: string; readonly start?: StartInput };

export interface TaskOptions {
  readonly id?: string;
  readonly name?: string;
  /** Higher runs first when several tasks are due. Default 0. */
  readonly priority?: number;
  /**
   * The occurrence must start within this many ms of its scheduled time.
   * Among equal priorities, the earliest deadline runs first. If the deadline
   * has passed when a slot frees up, `onMissed` decides what happens.
   */
  readonly deadlineMs?: number;
  /** `'skip'` (default): mark the occurrence missed. `'run'`: run it late anyway. */
  readonly onMissed?: 'skip' | 'run';
  /** Abort the attempt and count it as failed after this many ms. */
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Aborting this signal cancels the task. Not persisted. */
  readonly signal?: AbortSignal;
}

/** A read-only copy of a task. `type` narrows `payload`. */
export type TaskSnapshot<P extends PayloadMap<P>> = {
  readonly [K in keyof P & string]: Readonly<Omit<StoredTask, 'type' | 'payload'>> & {
    readonly type: K;
    readonly payload: P[K];
  };
}[keyof P & string];

export interface SchedulerEvents<P extends PayloadMap<P>> {
  taskScheduled: { task: TaskSnapshot<P>; runAt: number };
  taskStarted: { task: TaskSnapshot<P>; attempt: number };
  taskCompleted: { task: TaskSnapshot<P>; durationMs: number };
  taskFailed: {
    task: TaskSnapshot<P>;
    error: Error;
    willRetry: boolean;
    /** When the retry is due (epoch ms), or `null` if the task gave up. */
    retryAt: number | null;
    /** The backoff delay that was chosen, or `null` if the task gave up. */
    retryDelayMs: number | null;
  };
  taskMissed: {
    task: TaskSnapshot<P>;
    scheduledAt: number;
    deadline: number;
    action: 'skip' | 'run';
  };
  taskCancelled: { task: TaskSnapshot<P> };
  /** Storage failures and exceptions thrown by event listeners. */
  error: { error: Error };
}

export interface SchedulerOptions<P extends PayloadMap<P>> {
  readonly handlers: Handlers<P>;
  readonly storage?: StorageAdapter;
  readonly clock?: Clock;
  /** Maximum tasks running at the same time. Default 1. */
  readonly concurrency?: number;
  /** Random source for retry jitter, in [0, 1). */
  readonly random?: () => number;
  readonly generateId?: () => string;
}

export interface StopOptions {
  /** Abort running tasks instead of waiting for them. They run again on the next start. */
  readonly abortRunning?: boolean;
}

interface QueueEntry {
  readonly id: string;
  /** Must match `Task.token`; older entries are stale and skipped (lazy deletion). */
  readonly token: number;
  readonly runAt: number;
  readonly priority: number;
  readonly deadline: number;
}

interface Task {
  readonly data: StoredTask;
  readonly recurrence: Recurrence | null;
  token: number;
  detachSignal?: () => void;
}

const compareNumbers = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Due order: earliest run time first, then higher priority. */
const byRunAt = (a: QueueEntry, b: QueueEntry): number =>
  compareNumbers(a.runAt, b.runAt) || compareNumbers(b.priority, a.priority);

/** Ready order: higher priority first, then earliest deadline (EDF), then FIFO (heap tie-break). */
const byPriorityThenDeadline = (a: QueueEntry, b: QueueEntry): number =>
  compareNumbers(b.priority, a.priority) || compareNumbers(a.deadline, b.deadline);

/** Reason used to abort running tasks on `stop({ abortRunning: true })`. */
const STOPPED = new TaskCancelledError('scheduler stopped');

function toEpochMs(at: Date | number | string): number {
  let ms: number;
  if (typeof at === 'number') ms = at;
  else if (at instanceof Date) ms = at.getTime();
  else {
    try {
      ms = Temporal.Instant.from(at).epochMilliseconds;
    } catch {
      throw new RangeError(`"${at}" is not an exact time; include Z or an offset`);
    }
  }
  if (!Number.isFinite(ms)) throw new RangeError('schedule time must be a finite date');
  return ms;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(toError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(error));
      },
    );
  });
}

/**
 * Runs typed tasks by priority, deadline and recurrence rule.
 *
 * ```ts
 * const scheduler = new Scheduler<{ email: { to: string } }>({
 *   handlers: { email: async ({ payload, signal }) => send(payload.to, { signal }) },
 * });
 * await scheduler.add('email', { to: 'a@example.com' }, { rrule: 'FREQ=DAILY;BYHOUR=9', timeZone: 'Europe/Helsinki' });
 * await scheduler.start();
 * ```
 *
 * Delivery is at-least-once: if the process stops while a task is running, that
 * attempt runs again on the next start. Handlers should be idempotent.
 */
export class Scheduler<P extends PayloadMap<P>> {
  private readonly handlers: Handlers<P>;
  private readonly storage: StorageAdapter;
  private readonly clock: Clock;
  private readonly concurrency: number;
  private readonly random: () => number;
  private readonly generateId: () => string;
  private readonly emitter = new TypedEmitter<SchedulerEvents<P>>();

  private readonly tasks = new Map<string, Task>();
  /** Tasks waiting for their run time. */
  private readonly delayed = new PriorityQueue<QueueEntry>(byRunAt);
  /** Tasks that are due and waiting for a free slot. */
  private readonly ready = new PriorityQueue<QueueEntry>(byPriorityThenDeadline);
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<void>>();

  private loading: Promise<void> | undefined;
  private started = false;
  private cancelTimer: CancelTimer | undefined;
  private timerAt: number | undefined;
  private saves: Promise<void> = Promise.resolve();
  private queuedWrite: Promise<void> | undefined;
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();

  constructor(options: SchedulerOptions<P>) {
    this.handlers = options.handlers;
    this.storage = options.storage ?? new MemoryStorage();
    this.clock = options.clock ?? systemClock;
    this.concurrency = options.concurrency ?? 1;
    this.random = options.random ?? Math.random;
    this.generateId = options.generateId ?? randomUUID;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError('concurrency must be an integer >= 1');
    }
  }

  get isRunning(): boolean {
    return this.started;
  }

  on<K extends keyof SchedulerEvents<P>>(
    event: K,
    listener: (payload: SchedulerEvents<P>[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  once<K extends keyof SchedulerEvents<P>>(
    event: K,
    listener: (payload: SchedulerEvents<P>[K]) => void,
  ): () => void {
    return this.emitter.once(event, listener);
  }

  /**
   * Reads tasks from storage. Called automatically by `start()` and `add()`.
   * Tasks that were running when the process stopped go back to pending.
   */
  load(): Promise<void> {
    this.loading ??= this.loadFromStorage();
    return this.loading;
  }

  /** Loads tasks and starts running them. */
  async start(): Promise<void> {
    await this.load();
    if (this.started) return;
    this.started = true;
    this.pump();
  }

  /**
   * Stops starting new tasks, waits for running ones (or aborts them), and
   * waits for pending storage writes. Safe to call more than once.
   */
  async stop({ abortRunning = false }: StopOptions = {}): Promise<void> {
    this.started = false;
    this.clearTimer();
    if (abortRunning) {
      for (const controller of this.running.values()) controller.abort(STOPPED);
    }
    await this.idle();
  }

  /** Resolves when no task is running and every storage write has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await this.saves;
  }

  async add<K extends keyof P & string>(
    type: K,
    payload: P[K],
    schedule: ScheduleInput,
    options: TaskOptions = {},
  ): Promise<TaskSnapshot<P>> {
    await this.load();
    if (!Object.hasOwn(this.handlers, type)) throw new UnknownTaskTypeError(type);
    const id = options.id ?? this.generateId();
    if (this.tasks.has(id)) throw new Error(`a task with id "${id}" already exists`);
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new RangeError('priority must be a finite number');
    if (options.deadlineMs !== undefined && !(options.deadlineMs >= 0)) {
      throw new RangeError('deadlineMs must be >= 0');
    }
    if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
      throw new RangeError('timeoutMs must be > 0');
    }

    const now = this.clock.now();
    let recurrence: Recurrence | null = null;
    let firstRun: number;
    let stored: StoredTask['schedule'];
    if ('rrule' in schedule) {
      recurrence = Recurrence.parse(schedule.rrule, schedule.start ?? now, schedule.timeZone);
      const next = recurrence.next(now - 1);
      if (next === null) throw new RecurrenceError('the rule has no occurrences after now');
      firstRun = next;
      stored = { kind: 'rrule', rule: recurrence.toString(), start: recurrence.start.toString() };
    } else {
      firstRun = 'delayMs' in schedule ? now + schedule.delayMs : toEpochMs(schedule.at);
      if (!Number.isFinite(firstRun)) throw new RangeError('delayMs must be a finite number');
      stored = { kind: 'once', at: firstRun };
    }

    const data: StoredTask = {
      id,
      type,
      ...(options.name !== undefined && { name: options.name }),
      payload,
      schedule: stored,
      priority,
      ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
      onMissed: options.onMissed ?? 'skip',
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      retry: resolveRetry(options.retry),
      state: 'pending',
      scheduledAt: firstRun,
      nextRunAt: firstRun,
      attempt: 0,
      runs: 0,
      failures: 0,
      misses: 0,
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = { data, recurrence, token: 0 };
    this.tasks.set(id, task);
    this.enqueue(task);
    this.emit('taskScheduled', () => ({ task: this.snapshot(task), runAt: firstRun }));
    if (options.signal) this.attachSignal(task, options.signal);
    const saved = this.save(id);
    this.pump();
    await saved;
    return this.snapshot(task);
  }

  /** Cancels a pending or running task. Returns false if it does not exist or already finished. */
  async cancel(id: string): Promise<boolean> {
    await this.load();
    const task = this.tasks.get(id);
    if (!task) return false;
    const { state } = task.data;
    if (state !== 'pending' && state !== 'running') return false;
    this.setState(task, 'cancelled');
    task.token++;
    task.data.nextRunAt = null;
    task.detachSignal?.();
    this.running.get(id)?.abort(new TaskCancelledError());
    this.emit('taskCancelled', () => ({ task: this.snapshot(task) }));
    await this.save(id);
    return true;
  }

  /** Cancels (if needed) and deletes a task. Returns false if it does not exist. */
  async remove(id: string): Promise<boolean> {
    await this.load();
    const task = this.tasks.get(id);
    if (!task) return false;
    task.token++;
    task.detachSignal?.();
    this.running.get(id)?.abort(new TaskCancelledError('task was removed'));
    this.tasks.delete(id);
    await this.save(id, true);
    return true;
  }

  get(id: string): TaskSnapshot<P> | undefined {
    const task = this.tasks.get(id);
    return task && this.snapshot(task);
  }

  /** All tasks, soonest next run first; finished tasks last. */
  list(): TaskSnapshot<P>[] {
    return [...this.tasks.values()]
      .sort(
        (a, b) =>
          compareNumbers(a.data.nextRunAt ?? Infinity, b.data.nextRunAt ?? Infinity) ||
          compareNumbers(a.data.createdAt, b.data.createdAt),
      )
      .map((task) => this.snapshot(task));
  }

  // -------------------------------------------------------------------------

  private async loadFromStorage(): Promise<void> {
    const stored = await this.storage.load();
    const now = this.clock.now();
    for (const data of stored) {
      if (!Object.hasOwn(this.handlers, data.type)) throw new UnknownTaskTypeError(data.type);
      if (data.state === 'running') {
        // The process stopped mid-attempt. Run that attempt again (at-least-once).
        data.state = 'pending';
        data.attempt = Math.max(0, data.attempt - 1);
        data.nextRunAt = now;
      }
      const recurrence =
        data.schedule.kind === 'rrule'
          ? Recurrence.parse(data.schedule.rule, data.schedule.start)
          : null;
      const task: Task = { data, recurrence, token: 0 };
      this.tasks.set(data.id, task);
      if (data.state === 'pending' && data.nextRunAt !== null) this.enqueue(task);
    }
  }

  /** Moves due tasks to the ready queue, starts as many as slots allow, then re-arms the timer. */
  private pump(): void {
    if (!this.started) return;
    const now = this.clock.now();
    for (let top = this.delayed.peek(); top && top.runAt <= now; top = this.delayed.peek()) {
      this.delayed.pop();
      if (this.isCurrent(top)) this.ready.push(top);
    }
    while (this.running.size < this.concurrency) {
      const entry = this.ready.pop();
      if (!entry) break;
      const task = this.tasks.get(entry.id);
      if (task?.token === entry.token) this.begin(task, now);
    }
    this.armTimer();
  }

  private armTimer(): void {
    let top = this.delayed.peek();
    while (top && !this.isCurrent(top)) {
      this.delayed.pop();
      top = this.delayed.peek();
    }
    if (!top) {
      this.clearTimer();
      return;
    }
    if (this.timerAt === top.runAt) return;
    this.clearTimer();
    this.timerAt = top.runAt;
    // The clock may fire early (long delays are capped); pump() re-checks and re-arms.
    this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = undefined;
      this.timerAt = undefined;
      this.pump();
    }, top.runAt - this.clock.now());
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.timerAt = undefined;
  }

  private begin(task: Task, now: number): void {
    const { data } = task;
    const scheduledAt = data.scheduledAt ?? now;
    if (data.attempt === 0 && data.deadlineMs !== undefined) {
      const deadline = scheduledAt + data.deadlineMs;
      if (now > deadline) {
        this.emit('taskMissed', () => ({
          task: this.snapshot(task),
          scheduledAt,
          deadline,
          action: data.onMissed,
        }));
        if (data.onMissed === 'skip') {
          this.setState(task, 'missed');
          data.misses++;
          data.nextRunAt = null;
          this.scheduleNextOccurrence(task, now);
          void this.save(data.id);
          return;
        }
      }
    }

    this.setState(task, 'running');
    data.attempt++;
    data.nextRunAt = null;
    const controller = new AbortController();
    this.running.set(data.id, controller);
    this.emit('taskStarted', () => ({ task: this.snapshot(task), attempt: data.attempt }));
    void this.save(data.id);
    const run = this.execute(task, controller, scheduledAt).finally(() => {
      this.inflight.delete(run);
    });
    this.inflight.add(run);
  }

  private async execute(
    task: Task,
    controller: AbortController,
    scheduledAt: number,
  ): Promise<void> {
    const { data } = task;
    const token = task.token;
    const startedAt = this.clock.now();
    const { timeoutMs } = data;
    const cancelTimeout =
      timeoutMs === undefined
        ? undefined
        : this.clock.setTimer(() => {
            controller.abort(new TaskTimeoutError(timeoutMs));
          }, timeoutMs);

    // The payload was type-checked against this handler when the task was added
    // (or validated as JSON when loaded), so widening the handler type is safe here.
    const handlers = this.handlers as Partial<Record<string, TaskHandler<JsonValue>>>;
    const handler = handlers[data.type];
    const context: TaskContext<JsonValue> = {
      id: data.id,
      name: data.name,
      payload: data.payload,
      attempt: data.attempt,
      scheduledAt,
      signal: controller.signal,
    };

    let error: Error | undefined;
    try {
      if (!handler) throw new UnknownTaskTypeError(data.type);
      await raceAbort(
        Promise.resolve().then(() => handler(context)),
        controller.signal,
      );
    } catch (caught) {
      error = toError(caught);
    } finally {
      cancelTimeout?.();
      this.running.delete(data.id);
    }

    // Cancelled or removed while running: cancel()/remove() already updated the state.
    if (task.token !== token || this.tasks.get(data.id) !== task) {
      this.pump();
      return;
    }

    const now = this.clock.now();
    if (!error) {
      this.setState(task, 'done');
      data.runs++;
      delete data.lastError;
      this.emit('taskCompleted', () => ({
        task: this.snapshot(task),
        durationMs: now - startedAt,
      }));
      this.scheduleNextOccurrence(task, now);
    } else if (controller.signal.reason === STOPPED) {
      // Scheduler stopped mid-attempt: put it back so it runs again on the next start.
      this.setState(task, 'pending');
      data.attempt--;
      data.nextRunAt = now;
      this.enqueue(task);
    } else {
      data.lastError = error.message;
      const retryDelayMs =
        data.attempt < data.retry.maxAttempts
          ? backoffDelay(data.retry, data.attempt, this.random)
          : null;
      const retryAt = retryDelayMs === null ? null : now + retryDelayMs;
      if (retryAt !== null) {
        this.setState(task, 'pending');
        data.nextRunAt = retryAt;
        this.enqueue(task);
      } else {
        this.setState(task, 'failed');
        data.failures++;
      }
      this.emit('taskFailed', () => ({
        task: this.snapshot(task),
        error,
        willRetry: retryAt !== null,
        retryAt,
        retryDelayMs,
      }));
      if (retryAt === null) this.scheduleNextOccurrence(task, now);
    }
    void this.save(data.id);
    this.pump();
  }

  /** After an occurrence ends (done, failed or missed), queue the next one if the rule has one. */
  private scheduleNextOccurrence(task: Task, now: number): void {
    const { data } = task;
    // Occurrences that passed while this one ran (or while the process was down)
    // are coalesced: the next run is the first occurrence after now.
    const next = task.recurrence?.next(now) ?? null;
    if (next === null) {
      data.nextRunAt = null;
      task.detachSignal?.();
      return;
    }
    this.setState(task, 'pending');
    data.attempt = 0;
    data.scheduledAt = next;
    data.nextRunAt = next;
    this.enqueue(task);
    this.emit('taskScheduled', () => ({ task: this.snapshot(task), runAt: next }));
  }

  private enqueue(task: Task): void {
    const { data } = task;
    if (data.nextRunAt === null) return;
    task.token++;
    this.delayed.push({
      id: data.id,
      token: task.token,
      runAt: data.nextRunAt,
      priority: data.priority,
      deadline: (data.scheduledAt ?? data.nextRunAt) + (data.deadlineMs ?? Infinity),
    });
  }

  private isCurrent(entry: QueueEntry): boolean {
    return this.tasks.get(entry.id)?.token === entry.token;
  }

  private setState(task: Task, to: TaskState): void {
    task.data.state = transition(task.data.state, to);
    task.data.updatedAt = this.clock.now();
  }

  private attachSignal(task: Task, signal: AbortSignal): void {
    const onAbort = () => void this.cancel(task.data.id);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    task.detachSignal = () => {
      signal.removeEventListener('abort', onAbort);
    };
  }

  /**
   * Records that a task changed (or was removed) and schedules a storage write.
   * Writes run one at a time; every change made before a write starts is
   * coalesced into it, and a write only carries the tasks that changed.
   */
  private save(id: string, removed = false): Promise<void> {
    if (removed) {
      this.dirty.delete(id);
      this.deleted.add(id);
    } else {
      this.deleted.delete(id);
      this.dirty.add(id);
    }
    this.queuedWrite ??= this.saves.then(() => this.flush());
    this.saves = this.queuedWrite;
    return this.queuedWrite;
  }

  private async flush(): Promise<void> {
    this.queuedWrite = undefined;
    const upserts = [...this.dirty].flatMap((id) => {
      const task = this.tasks.get(id);
      return task ? [copyStoredTask(task.data)] : [];
    });
    const deletes = [...this.deleted];
    this.dirty.clear();
    this.deleted.clear();
    try {
      await this.storage.write({ upserts, deletes });
    } catch (error) {
      this.emit('error', () => ({ error: toError(error) }));
    }
  }

  /** Emits `event`. The payload (with its task snapshot) is only built if someone listens. */
  private emit<K extends keyof SchedulerEvents<P>>(
    event: K,
    payload: () => SchedulerEvents<P>[K],
  ): void {
    if (this.emitter.listenerCount(event) === 0) return;
    this.emitter.emit(event, payload(), (error) => {
      if (event !== 'error') this.emit('error', () => ({ error: toError(error) }));
    });
  }

  private snapshot(task: Task): TaskSnapshot<P> {
    // `type` and `payload` were checked against P when the task was added.
    return copyStoredTask(task.data) as TaskSnapshot<P>;
  }
}
