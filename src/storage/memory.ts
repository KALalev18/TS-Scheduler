import type { StorageAdapter, StoredTask } from './schema.js';

/** Keeps tasks in memory (the default). Copies on every read and write, like a real store. */
export class MemoryStorage implements StorageAdapter {
  private tasks: StoredTask[];

  constructor(initial: readonly StoredTask[] = []) {
    this.tasks = structuredClone([...initial]);
  }

  load(): Promise<StoredTask[]> {
    return Promise.resolve(structuredClone(this.tasks));
  }

  save(tasks: readonly StoredTask[]): Promise<void> {
    this.tasks = structuredClone([...tasks]);
    return Promise.resolve();
  }

  /** The tasks as last saved. */
  snapshot(): StoredTask[] {
    return structuredClone(this.tasks);
  }
}
