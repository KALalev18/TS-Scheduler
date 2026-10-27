import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PriorityQueue } from '../src/priority-queue.js';

const ascending = (a: number, b: number) => a - b;

function drain<T>(queue: PriorityQueue<T>): T[] {
  const out: T[] = [];
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) out.push(item);
  return out;
}

describe('PriorityQueue', () => {
  it('is empty when created', () => {
    const queue = new PriorityQueue(ascending);
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
  });

  it('pops items in comparator order', () => {
    const queue = new PriorityQueue(ascending);
    for (const n of [5, 1, 4, 2, 3]) queue.push(n);
    expect(queue.peek()).toBe(1);
    expect(drain(queue)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps insertion order for equal items (stable)', () => {
    const queue = new PriorityQueue<{ p: number; name: string }>((a, b) => a.p - b.p);
    queue.push({ p: 1, name: 'a' });
    queue.push({ p: 0, name: 'b' });
    queue.push({ p: 1, name: 'c' });
    queue.push({ p: 0, name: 'd' });
    expect(drain(queue).map((x) => x.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('clear() empties the queue and toArray() returns every item', () => {
    const queue = new PriorityQueue(ascending);
    [3, 1, 2].forEach((n) => {
      queue.push(n);
    });
    expect(queue.toArray().sort(ascending)).toEqual([1, 2, 3]);
    queue.clear();
    expect(queue.size).toBe(0);
  });

  it('property: draining always yields a stable sort of the input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 300 }), (priorities) => {
        const items = priorities.map((p, index) => ({ p, index }));
        const queue = new PriorityQueue<(typeof items)[number]>((a, b) => a.p - b.p);
        items.forEach((item) => {
          queue.push(item);
        });
        // Array.prototype.sort is stable, so it is the reference answer.
        const expected = [...items].sort((a, b) => a.p - b.p);
        expect(drain(queue)).toEqual(expected);
      }),
    );
  });

  it('property: interleaved push/pop always returns the current minimum', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('push' as const), value: fc.integer() }),
      fc.record({ kind: fc.constant('pop' as const) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 300 }), (ops) => {
        const queue = new PriorityQueue(ascending);
        const model: number[] = [];
        for (const o of ops) {
          if (o.kind === 'push') {
            queue.push(o.value);
            model.push(o.value);
          } else {
            model.sort(ascending);
            expect(queue.pop()).toBe(model.shift());
          }
          expect(queue.size).toBe(model.length);
        }
      }),
    );
  });
});
