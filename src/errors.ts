/** Thrown into a task's `AbortSignal` (and reported as the failure) when it runs longer than `timeoutMs`. */
export class TaskTimeoutError extends Error {
  override readonly name = 'TaskTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`task timed out after ${timeoutMs} ms`);
  }
}

/** The reason a running task's `AbortSignal` is aborted when the task is cancelled. */
export class TaskCancelledError extends Error {
  override readonly name = 'TaskCancelledError';

  constructor(message = 'task was cancelled') {
    super(message);
  }
}

/** A task refers to a handler type that the scheduler was not given. */
export class UnknownTaskTypeError extends Error {
  override readonly name = 'UnknownTaskTypeError';

  constructor(readonly type: string) {
    super(`no handler registered for task type "${type}"`);
  }
}

/** Stored tasks could not be read or written. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
