import type { StorageAdapter, StorageChanges, StoredTask } from './schema.js';

/** Keeps tasks in memory (the default). Copies on every read and write, like a real store. */
export class MemoryStorage implements StorageAdapter {
  private readonly tasks = new Map<string, StoredTask>();
  /** Number of `write` calls, useful for checking that changes are batched. */
  writes = 0;

  constructor(initial: readonly StoredTask[] = []) {
    for (const task of initial) this.tasks.set(task.id, structuredClone(task));
  }

  load(): Promise<StoredTask[]> {
    return Promise.resolve(this.snapshot());
  }

  write({ upserts, deletes }: StorageChanges): Promise<void> {
    this.writes++;
    for (const task of upserts) this.tasks.set(task.id, structuredClone(task));
    for (const id of deletes) this.tasks.delete(id);
    return Promise.resolve();
  }

  /** The stored tasks, in insertion order. */
  snapshot(): StoredTask[] {
    return structuredClone([...this.tasks.values()]);
  }
}
