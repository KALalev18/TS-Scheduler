/**
 * Lifecycle of one task occurrence.
 *
 * ```text
 * pending ──► running ──► done
 *    │           │  └───► failed
 *    │           │  └───► pending    (attempt failed, retry scheduled)
 *    │           └──────► cancelled
 *    ├──► missed                     (start deadline passed)
 *    └──► cancelled
 *
 * done / failed / missed ──► pending (recurring task: next occurrence)
 * ```
 */
export type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'missed' | 'cancelled';

/** Allowed transitions. The type of {@link transition} is derived from this table. */
export const TRANSITIONS = {
  pending: ['running', 'missed', 'cancelled'],
  running: ['done', 'failed', 'pending', 'cancelled'],
  done: ['pending'],
  failed: ['pending'],
  missed: ['pending'],
  cancelled: [],
} as const satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

/** States reachable from `S` in one step. `NextState<'cancelled'>` is `never`. */
export type NextState<S extends TaskState> = (typeof TRANSITIONS)[S][number];

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';

  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`invalid task state transition: ${from} -> ${to}`);
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (TRANSITIONS[from] as readonly TaskState[]).includes(to);
}

/**
 * Validates a transition and returns the new state.
 *
 * When `from` is a literal type, an invalid `to` is a compile error
 * (`transition('cancelled', 'running')` does not type-check). The runtime
 * check covers values whose state is only known as `TaskState`.
 */
export function transition<S extends TaskState>(from: S, to: NoInfer<NextState<S>>): NextState<S> {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}
