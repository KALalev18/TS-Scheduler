import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  JsonFileStorage,
  MemoryStorage,
  Scheduler,
  StorageError,
  type StoredTask,
} from '../../src/index.js';

const task: StoredTask = {
  id: 't1',
  type: 'job',
  name: 'nightly',
  payload: { label: 'x', nested: [1, true, null] },
  schedule: {
    kind: 'rrule',
    rule: 'FREQ=DAILY',
    start: '2026-06-01T09:00:00+03:00[Europe/Helsinki]',
  },
  priority: 1,
  onMissed: 'skip',
  retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 'full' },
  state: 'pending',
  scheduledAt: 1,
  nextRunAt: 1,
  attempt: 0,
  runs: 0,
  failures: 0,
  misses: 0,
  createdAt: 0,
  updatedAt: 0,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-scheduler-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonFileStorage', () => {
  it('returns no tasks when the file does not exist', async () => {
    expect(await new JsonFileStorage(join(dir, 'missing.json')).load()).toEqual([]);
  });

  it('round-trips tasks and creates missing folders', async () => {
    const path = join(dir, 'nested', 'deeper', 'schedule.json');
    const storage = new JsonFileStorage(path);
    await storage.write({ upserts: [task], deletes: [] });
    expect(await storage.load()).toEqual([task]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('leaves no temporary files behind', async () => {
    const storage = new JsonFileStorage(join(dir, 'schedule.json'));
    await Promise.all([
      storage.write({ upserts: [task], deletes: [] }),
      storage.write({ upserts: [], deletes: [task.id] }),
      storage.write({ upserts: [task], deletes: [] }),
    ]);
    expect(await readdir(dir)).toEqual(['schedule.json']);
  });

  it('applies deletes and keeps tasks written by earlier calls', async () => {
    const path = join(dir, 'schedule.json');
    const storage = new JsonFileStorage(path);
    await storage.write({ upserts: [task, { ...task, id: 't2' }], deletes: [] });
    // A fresh adapter that never called load() reads the file before applying changes.
    await new JsonFileStorage(path).write({ upserts: [], deletes: ['t1'] });
    expect((await storage.load()).map((t) => t.id)).toEqual(['t2']);
  });

  it('applies concurrent saves in call order', async () => {
    const storage = new JsonFileStorage(join(dir, 'schedule.json'));
    const saves = Array.from({ length: 20 }, (_, i) =>
      storage.write({ upserts: [{ ...task, runs: i }], deletes: [] }),
    );
    await Promise.all(saves);
    expect((await storage.load())[0]?.runs).toBe(19);
  });

  it('rejects invalid JSON with a StorageError', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ not json');
    await expect(new JsonFileStorage(path).load()).rejects.toThrow(StorageError);
    await expect(new JsonFileStorage(path).load()).rejects.toThrow('not valid JSON');
  });

  it('rejects files that do not match the schema, naming the field', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ version: 1, tasks: [{ ...task, state: 'exploded' }] }));
    await expect(new JsonFileStorage(path).load()).rejects.toThrow(/invalid format[\s\S]*state/);
  });

  it('reports read errors other than a missing file', async () => {
    // Reading a directory as a file fails with EISDIR.
    await expect(new JsonFileStorage(dir).load()).rejects.toThrow(`cannot read ${dir}`);
  });

  it('reports write errors and keeps working afterwards', async () => {
    const blocked = join(dir, 'file.txt');
    await writeFile(blocked, '');
    // A path *inside* a regular file cannot be created.
    const storage = new JsonFileStorage(join(blocked, 'schedule.json'));
    const changes = { upserts: [task], deletes: [] };
    await expect(storage.write(changes)).rejects.toThrow(StorageError);
    await expect(storage.write(changes)).rejects.toThrow('cannot write');
  });

  it('persists a scheduler across restarts', async () => {
    const path = join(dir, 'schedule.json');
    const clock = new FakeClock(Date.parse('2026-06-01T00:00:00Z'));
    const handlers = { job: () => undefined };
    const first = new Scheduler<{ job: null }>({
      clock,
      handlers,
      storage: new JsonFileStorage(path),
    });
    const added = await first.add('job', null, { delayMs: 1000 });
    await first.stop();

    const second = new Scheduler<{ job: null }>({
      clock,
      handlers,
      storage: new JsonFileStorage(path),
    });
    await second.start();
    await clock.advance(1000);
    await second.stop();
    expect(second.get(added.id)).toMatchObject({ state: 'done', runs: 1 });
    expect((await new JsonFileStorage(path).load())[0]).toMatchObject({ state: 'done' });
  });
});

describe('MemoryStorage', () => {
  it('copies data so callers cannot mutate what is stored', async () => {
    const storage = new MemoryStorage([task]);
    const loaded = await storage.load();
    if (loaded[0]) loaded[0].runs = 99;
    expect(storage.snapshot()[0]?.runs).toBe(0);
  });
});
