import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  TRANSITIONS,
  canTransition,
  transition,
  type TaskState,
} from '../src/state.js';

const ALL_STATES = Object.keys(TRANSITIONS) as TaskState[];

describe('task state machine', () => {
  it('allows every transition listed in the table', () => {
    for (const from of ALL_STATES) {
      for (const to of TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it('rejects every transition not in the table', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if ((TRANSITIONS[from] as readonly TaskState[]).includes(to)) continue;
        expect(canTransition(from, to)).toBe(false);
        expect(() => transition(from, to as never)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('cancelled is terminal', () => {
    expect(TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('returns the new state and names both states in errors', () => {
    expect(transition('pending', 'running')).toBe('running');
    const state: TaskState = 'done';
    expect(() => transition(state, 'running' as never)).toThrow(
      'invalid task state transition: done -> running',
    );
  });

  it('rejects invalid transitions at compile time', () => {
    // Checked by `npm run typecheck`: if either call below became legal, the
    // expect-error directive would be unused and the build would fail.
    // @ts-expect-error cancelled is terminal
    expect(() => transition('cancelled', 'pending')).toThrow();
    // @ts-expect-error a pending task cannot finish without running
    expect(() => transition('pending', 'done')).toThrow();
  });
});
