import {
  copyStoredTask,
  type StorageAdapter,
  type StorageChanges,
  type StoredTask,
} from './schema.js';

/** Keeps tasks in memory (the default). Reads return copies, so callers cannot change what is stored. */
export class MemoryStorage implements StorageAdapter {
  private readonly tasks = new Map<string, StoredTask>();

  constructor(initial: readonly StoredTask[] = []) {
    for (const task of initial) this.tasks.set(task.id, copyStoredTask(task));
  }

  load(): Promise<StoredTask[]> {
    return Promise.resolve(this.snapshot());
  }

  write({ upserts, deletes }: StorageChanges): Promise<void> {
    for (const task of upserts) this.tasks.set(task.id, task);
    for (const id of deletes) this.tasks.delete(id);
    return Promise.resolve();
  }

  /** The stored tasks, in insertion order. */
  snapshot(): StoredTask[] {
    return [...this.tasks.values()].map(copyStoredTask);
  }
}
