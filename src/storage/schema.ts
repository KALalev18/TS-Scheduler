import { z } from 'zod';
import type { TaskState } from '../state.js';

/**
 * The persisted shape of a task. The TypeScript type is inferred from this
 * schema, so what the file adapter validates and what the scheduler writes
 * cannot drift apart.
 */
export const taskStateSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'missed',
  'cancelled',
]) satisfies z.ZodType<TaskState>;

export const retryPolicySchema = z.object({
  maxAttempts: z.int().min(1),
  baseDelayMs: z.number().min(0),
  maxDelayMs: z.number().min(0),
  jitter: z.enum(['full', 'none']),
});

export const storedScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number() }),
  z.object({
    kind: z.literal('rrule'),
    rule: z.string().min(1),
    /** Zoned ISO string, e.g. `2026-06-01T09:00:00+03:00[Europe/Helsinki]`. */
    start: z.string().min(1),
  }),
]);

export const storedTaskSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  payload: z.json(),
  schedule: storedScheduleSchema,
  priority: z.number(),
  deadlineMs: z.number().min(0).optional(),
  onMissed: z.enum(['skip', 'run']),
  timeoutMs: z.number().positive().optional(),
  retry: retryPolicySchema,
  state: taskStateSchema,
  /** Nominal time of the current occurrence (retries keep it). */
  scheduledAt: z.number().nullable(),
  /** When the next attempt is due, or `null` if nothing is scheduled. */
  nextRunAt: z.number().nullable(),
  /** Attempts made for the current occurrence. */
  attempt: z.int().min(0),
  runs: z.int().min(0),
  failures: z.int().min(0),
  misses: z.int().min(0),
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const storageFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(storedTaskSchema),
});

export type StoredSchedule = z.infer<typeof storedScheduleSchema>;
export type StoredTask = z.infer<typeof storedTaskSchema>;
export type JsonValue = StoredTask['payload'];

/** A batch of changes: tasks to insert or replace, and ids to delete. */
export interface StorageChanges {
  readonly upserts: readonly StoredTask[];
  readonly deletes: readonly string[];
}

/** Where the scheduler keeps its tasks. Implement this to add a database backend. */
export interface StorageAdapter {
  /** Returns every stored task. Called once, when the scheduler loads. */
  load(): Promise<StoredTask[]>;
  /**
   * Applies one batch of changes. The scheduler waits for each call to finish
   * before the next, so a database adapter can run each batch in a transaction.
   */
  write(changes: StorageChanges): Promise<void>;
}
