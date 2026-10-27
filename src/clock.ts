/** Cancels a timer created by {@link Clock.setTimer}. Calling it twice is a no-op. */
export type CancelTimer = () => void;

/**
 * Source of time for the scheduler. Everything time-based goes through this
 * interface, so tests can swap in {@link FakeClock} and run a week of
 * schedules in milliseconds.
 */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
  /** Calls `callback` after `delayMs`. Implementations may fire early; callers must re-check `now()`. */
  setTimer(callback: () => void, delayMs: number): CancelTimer;
}

/**
 * Node's `setTimeout` overflows above 2^31 - 1 ms (~24.8 days) and fires
 * immediately. Long delays are capped; the scheduler wakes up, sees nothing
 * is due yet, and re-arms the timer.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Real clock backed by `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS));
    return () => {
      clearTimeout(handle);
    };
  },
};

interface FakeTimer {
  readonly at: number;
  readonly seq: number;
  readonly callback: () => void;
}

/** Lets pending promise callbacks (microtasks and one macrotask turn) run. */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Deterministic clock for tests. Time only moves when you call
 * {@link FakeClock.advance}; due timers fire in time order, and pending
 * promises are flushed after each one so async task handlers can finish.
 */
export class FakeClock implements Clock {
  private current: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(start: number | Date = 0) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): CancelTimer {
    const timer: FakeTimer = { at: this.current + Math.max(0, delayMs), seq: this.seq++, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Number of timers that have not fired or been cancelled. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.current + ms);
  }

  /** Moves time forward to `target` (epoch ms), firing due timers in order. */
  async advanceTo(target: number): Promise<void> {
    await flushAsync();
    for (;;) {
      const next = this.earliestDue(target);
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.current = Math.max(this.current, next.at);
      next.callback();
      await flushAsync();
    }
    this.current = Math.max(this.current, target);
    await flushAsync();
  }

  private earliestDue(target: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.timers) {
      if (t.at > target) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }
}
