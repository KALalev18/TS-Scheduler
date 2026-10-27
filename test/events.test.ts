import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../src/events.js';

interface Events {
  tick: { n: number };
  done: undefined;
}

describe('TypedEmitter', () => {
  it('delivers payloads to listeners and stops after off()', () => {
    const emitter = new TypedEmitter<Events>();
    const listener = vi.fn();
    const off = emitter.on('tick', listener);
    emitter.emit('tick', { n: 1 });
    off();
    emitter.emit('tick', { n: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ n: 1 });
    expect(emitter.listenerCount('tick')).toBe(0);
  });

  it('once() listeners fire a single time', () => {
    const emitter = new TypedEmitter<Events>();
    const listener = vi.fn();
    emitter.once('done', listener);
    emitter.emit('done', undefined);
    emitter.emit('done', undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('emitting with no listeners is a no-op', () => {
    expect(() => {
      new TypedEmitter<Events>().emit('tick', { n: 1 });
    }).not.toThrow();
  });

  it('a throwing listener does not stop the others', () => {
    const emitter = new TypedEmitter<Events>();
    const after = vi.fn();
    const errors: unknown[] = [];
    emitter.on('tick', () => {
      throw new Error('bad');
    });
    emitter.on('tick', after);
    emitter.emit('tick', { n: 1 }, (error) => errors.push(error));
    expect(after).toHaveBeenCalled();
    expect(errors).toEqual([new Error('bad')]);
  });

  it('rethrows listener errors by default', () => {
    const emitter = new TypedEmitter<Events>();
    emitter.on('tick', () => {
      throw new Error('bad');
    });
    expect(() => {
      emitter.emit('tick', { n: 1 });
    }).toThrow('bad');
  });
});
