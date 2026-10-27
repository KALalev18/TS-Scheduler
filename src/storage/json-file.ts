import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { StorageError } from '../errors.js';
import { storageFileSchema, type StorageAdapter, type StoredTask } from './schema.js';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Stores tasks in one JSON file.
 *
 * - Writes are atomic: data goes to a temporary file that is then renamed over
 *   the real one, so a crash mid-write never leaves a half-written file.
 * - Writes are serialised: each `save` waits for the previous one.
 * - Loading validates the file against the task schema and fails with a clear
 *   `StorageError` instead of running with corrupt data.
 *
 * The whole file is rewritten on every save, which is fine for hundreds of
 * tasks but not for millions; a database adapter would write single rows.
 */
export class JsonFileStorage implements StorageAdapter {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<StoredTask[]> {
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
        `${this.path} has an invalid format:\n${z.prettifyError(result.error)}`,
      );
    }
    return result.data.tasks;
  }

  save(tasks: readonly StoredTask[]): Promise<void> {
    const body = `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`;
    const write = async () => {
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temp, body, 'utf8');
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true });
        throw new StorageError(`cannot write ${this.path}`, { cause: error });
      }
    };
    // Run after the previous write whether it succeeded or not.
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
