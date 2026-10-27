type Listener<T> = (payload: T) => void;

/**
 * Minimal typed event emitter: event names and payload types come from `Events`,
 * so `on('taskFailed', ...)` gets a typed payload and unknown names do not compile.
 */
export class TypedEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Adds a listener and returns a function that removes it. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      this.off(event, listener);
    };
  }

  /** Like {@link on}, but the listener is removed after the first call. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Calls every listener for `event`. A listener that throws does not stop the
   * others; its error is passed to `onListenerError`.
   */
  emit<K extends keyof Events>(
    event: K,
    payload: Events[K],
    onListenerError: (error: unknown) => void = (error) => {
      throw error;
    },
  ): void {
    const set = this.listeners.get(event) as Set<Listener<Events[K]>> | undefined;
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        onListenerError(error);
      }
    }
  }
}
