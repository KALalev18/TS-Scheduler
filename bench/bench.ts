/**
 * Benchmarks behind the numbers in the README. Run with `npm run bench`.
 *
 * Every case runs RUNS times after one warm-up run; the table shows the median.
 */
import { cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { FakeClock, PriorityQueue, Scheduler } from '../src/index.js';

const RUNS = 5;

/** Naive baseline: an array kept sorted with binary-search insert + splice. O(n) insert, O(1) pop. */
class SortedArrayQueue {
  private readonly items: number[] = [];

  push(value: number): void {
    // Kept in descending order so the smallest item is popped from the end.
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.items[mid] ?? 0) > value) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, value);
  }

  pop(): number | undefined {
    return this.items.pop();
  }
}

interface Queue {
  push(value: number): void;
  pop(): number | undefined;
}

/** Deterministic pseudo-random numbers (mulberry32), so every run uses the same input. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function measure(fn: () => unknown): Promise<number> {
  await fn(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

/** Push n items, then pop them all. */
function fillThenDrain(make: () => Queue, n: number): () => void {
  return () => {
    const next = random(1);
    const queue = make();
    for (let i = 0; i < n; i++) queue.push(next());
    for (let i = 0; i < n; i++) queue.pop();
  };
}

/** Scheduler-like steady state: keep `size` items queued, then do n pop+push pairs. */
function steadyState(make: () => Queue, size: number, n: number): () => void {
  return () => {
    const next = random(2);
    const queue = make();
    for (let i = 0; i < size; i++) queue.push(next());
    for (let i = 0; i < n; i++) {
      queue.pop();
      queue.push(next());
    }
  };
}

/** Add n one-off tasks that are all due now, run them with a fake clock, and wait until done. */
function dispatch(n: number): () => Promise<void> {
  return async () => {
    const clock = new FakeClock(0);
    const scheduler = new Scheduler<{ noop: null }>({ clock, handlers: { noop: () => undefined } });
    const adds: Promise<unknown>[] = [];
    for (let i = 0; i < n; i++)
      adds.push(scheduler.add('noop', null, { delayMs: 0 }, { priority: i % 10 }));
    await Promise.all(adds);
    await scheduler.start();
    await clock.advance(0);
    await scheduler.stop();
  };
}

const heap = () => new PriorityQueue<number>((a, b) => a - b);
const sorted = () => new SortedArrayQueue();

const rows: string[][] = [];
async function row(name: string, ops: number, fn: () => unknown): Promise<number> {
  const ms = await measure(fn);
  rows.push([name, ms.toFixed(1), Math.round(ops / (ms / 1000)).toLocaleString('en-US')]);
  return ms;
}

const N = 100_000;
const heapFill = await row(
  `heap: push ${N / 1000}k, pop ${N / 1000}k`,
  2 * N,
  fillThenDrain(heap, N),
);
const sortedFill = await row(
  `sorted array: push ${N / 1000}k, pop ${N / 1000}k`,
  2 * N,
  fillThenDrain(sorted, N),
);
const heapSteady = await row(
  `heap: ${N / 1000}k pop+push at size 10k`,
  2 * N,
  steadyState(heap, 10_000, N),
);
const sortedSteady = await row(
  `sorted array: ${N / 1000}k pop+push at size 10k`,
  2 * N,
  steadyState(sorted, 10_000, N),
);
await row('scheduler: dispatch 10k due tasks', 10_000, dispatch(10_000));
await row('scheduler: dispatch 100k due tasks', 100_000, dispatch(100_000));

console.log(`Node ${process.version}, ${platform()}, ${cpus()[0]?.model ?? 'unknown CPU'}`);
console.log(`median of ${RUNS} runs after 1 warm-up\n`);
console.log('| Case | Median (ms) | Ops/s |');
console.log('| --- | ---: | ---: |');
for (const [name, ms, ops] of rows) console.log(`| ${name} | ${ms} | ${ops} |`);
console.log(
  `\nheap speed-up: ${(sortedFill / heapFill).toFixed(1)}x (fill+drain), ${(sortedSteady / heapSteady).toFixed(1)}x (steady state)`,
);
