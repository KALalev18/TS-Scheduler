/** Returns a negative number if `a` should come out before `b`, positive if after, 0 if equal. */
export type Comparator<T> = (a: T, b: T) => number;

interface HeapEntry<T> {
  readonly value: T;
  /** Insertion order, used to break ties so equal items come out first-in, first-out. */
  readonly seq: number;
}

/**
 * Binary min-heap priority queue.
 *
 * - `push` and `pop` are O(log n), `peek` is O(1).
 * - Stable: items the comparator considers equal come out in insertion order.
 *   A plain binary heap is not stable, so each entry carries an insertion
 *   sequence number used as the final tie-breaker.
 *
 * The heap is stored in a flat array: the children of index `i` are at
 * `2i + 1` and `2i + 2`, and its parent is at `(i - 1) >> 1`.
 */
export class PriorityQueue<T> {
  private readonly heap: HeapEntry<T>[] = [];
  private seq = 0;

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.heap.length;
  }

  push(value: T): void {
    this.heap.push({ value, seq: this.seq++ });
    this.siftUp(this.heap.length - 1);
  }

  /** The next item without removing it, or `undefined` if empty. */
  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  /** Removes and returns the next item, or `undefined` if empty. */
  pop(): T | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (top === undefined || last === undefined) return undefined;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top.value;
  }

  clear(): void {
    this.heap.length = 0;
  }

  /** Items in internal heap order (not sorted). */
  toArray(): T[] {
    return this.heap.map((entry) => entry.value);
  }

  private before(i: number, j: number): boolean {
    const a = this.at(i);
    const b = this.at(j);
    const order = this.compare(a.value, b.value);
    return order !== 0 ? order < 0 : a.seq < b.seq;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(index: number): void {
    const n = this.heap.length;
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.before(left, smallest)) smallest = left;
      if (right < n && this.before(right, smallest)) smallest = right;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    const a = this.at(i);
    this.heap[i] = this.at(j);
    this.heap[j] = a;
  }

  private at(i: number): HeapEntry<T> {
    const entry = this.heap[i];
    if (entry === undefined) throw new RangeError(`heap index ${i} out of bounds`);
    return entry;
  }
}
