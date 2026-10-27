import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A lock file (`<file>.lock`, holding the owner's process id) that `run` holds
 * while it is active. The JSON store is single-process: a second `run` would
 * execute every task twice, and an `add` from another terminal would be
 * overwritten by the running scheduler's next save. The lock turns both into
 * a clear error instead.
 */
export const lockPath = (file: string): string => `${file}.lock`;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Whether a process with this id exists. `EPERM` means it exists but belongs to another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

/** The id of the live process holding the lock on `file`, or `null` if none does. */
export async function lockHolder(file: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(lockPath(file), 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}

/**
 * Takes the lock on `file` and returns a function that releases it. A lock
 * left behind by a process that crashed is replaced.
 */
export async function acquireLock(file: string): Promise<() => Promise<void>> {
  const path = lockPath(file);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      // 'wx' fails if the file exists, so two processes cannot both create it.
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    const holder = await lockHolder(file);
    if (holder !== null) throw new Error(runningMessage(file, holder));
    // Left behind by a process that no longer exists.
    await rm(path, { force: true });
  }
}

export function runningMessage(file: string, pid: number): string {
  return `"ts-scheduler run" (process ${pid}) is using ${file}. Stop it with Ctrl+C first, or use another --file.`;
}
