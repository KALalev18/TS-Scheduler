import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { StorageError } from '../errors.js';
import {
  storageFileSchema,
  type StorageAdapter,
  type StorageChanges,
  type StoredTask,
} from './schema.js';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Stores tasks in one JSON file.
 *
 * - Writes are atomic: data goes to a temporary file that is then renamed over
 *   the real one, so a crash mid-write never leaves a half-written file.
 * - Writes are serialised: each `write` waits for the previous one.
 * - Loading validates the file against the task schema and fails with a clear
 *   `StorageError` instead of running with corrupt data.
 *
 * The scheduler batches changes, but each batch still rewrites the whole
 * file. That is fine for thousands of tasks; for more, a database adapter
 * would write only the changed rows.
 */
export class JsonFileStorage implements StorageAdapter {
  private writes: Promise<void> = Promise.resolve();
  /** Tasks as currently stored, so a write only has to apply the changes. */
  private tasks: Map<string, StoredTask> | undefined;

  constructor(readonly path: string) {}

  async load(): Promise<StoredTask[]> {
    const tasks = await this.read();
    this.tasks = new Map(tasks.map((task) => [task.id, task]));
    return structuredClone(tasks);
  }

  write({ upserts, deletes }: StorageChanges): Promise<void> {
    const apply = async () => {
      this.tasks ??= new Map((await this.read()).map((task) => [task.id, task]));
      for (const task of upserts) this.tasks.set(task.id, structuredClone(task));
      for (const id of deletes) this.tasks.delete(id);
      await this.writeFile([...this.tasks.values()]);
    };
    // Run after the previous write whether it succeeded or not.
    const next = this.writes.then(apply, apply);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoredTask[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw new StorageError(`cannot read ${this.path}`, { cause: error });
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new StorageError(`${this.path} is not valid JSON`, { cause: error });
    }
    const result = storageFileSchema.safeParse(data);
    if (!result.success) {
      throw new StorageError(
        `${this.path} has an invalid format:
${z.prettifyError(result.error)}`,
      );
    }
    return result.data.tasks;
  }

  private async writeFile(tasks: readonly StoredTask[]): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(
        temp,
        `${JSON.stringify({ version: 1, tasks }, null, 2)}
`,
        'utf8',
      );
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw new StorageError(`cannot write ${this.path}`, { cause: error });
    }
  }
}
