import { describe, expect, it, vi } from 'vitest';
import { FakeClock, MAX_TIMER_DELAY_MS, systemClock } from '../src/clock.js';

describe('FakeClock', () => {
  it('starts at the given time and only moves when advanced', async () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const start = clock.now();
    expect(start).toBe(Date.parse('2026-01-01T00:00:00Z'));
    await clock.advance(1500);
    expect(clock.now()).toBe(start + 1500);
  });

  it('fires due timers in time order, with now() set to each timer', async () => {
    const clock = new FakeClock(0);
    const fired: [string, number][] = [];
    clock.setTimer(() => fired.push(['b', clock.now()]), 200);
    clock.setTimer(() => fired.push(['a', clock.now()]), 100);
    clock.setTimer(() => fired.push(['c', clock.now()]), 300);
    await clock.advance(250);
    expect(fired).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
    expect(clock.pendingTimers).toBe(1);
  });

  it('fires timers scheduled by other timers inside the same advance', async () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    clock.setTimer(() => {
      fired.push(clock.now());
      clock.setTimer(() => fired.push(clock.now()), 50);
    }, 100);
    await clock.advance(1000);
    expect(fired).toEqual([100, 150]);
  });

  it('does not fire cancelled timers', async () => {
    const clock = new FakeClock(0);
    const callback = vi.fn();
    const cancel = clock.setTimer(callback, 10);
    cancel();
    await clock.advance(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it('lets awaited promises inside a timer callback settle', async () => {
    const clock = new FakeClock(0);
    let done = false;
    clock.setTimer(() => {
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => (done = true));
    }, 10);
    await clock.advance(10);
    expect(done).toBe(true);
  });
});

describe('systemClock', () => {
  it('fires real timers and can cancel them', async () => {
    const callback = vi.fn();
    const cancel = systemClock.setTimer(callback, 60_000);
    cancel();
    await new Promise<void>((resolve) => systemClock.setTimer(resolve, 1));
    expect(callback).not.toHaveBeenCalled();
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(50);
  });

  it('caps delays that would overflow setTimeout', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const cancel = systemClock.setTimer(() => undefined, Number.MAX_SAFE_INTEGER);
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS);
    cancel();
    spy.mockRestore();
  });
});
