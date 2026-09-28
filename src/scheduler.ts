import { Park4nightError, cancelled, throwIfCancelled } from './errors.ts';

export type RateLimitOptions = { minIntervalMs?: number; maxRetries?: number; maxWaitMs?: number; maxQueueSize?: number };
type Task = { execute: () => Promise<void>; cancel: () => void; signal?: AbortSignal };

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class RequestScheduler {
  #options: Required<RateLimitOptions>;
  #queue: Task[] = [];
  #running = false;
  #nextRequestAt = 0;
  #blockedUntil = 0;

  constructor(options: RateLimitOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Park4nightError('INVALID_INPUT', 'Invalid rate-limit configuration.');
    this.#options = { minIntervalMs: options.minIntervalMs ?? 1000, maxRetries: options.maxRetries ?? 2, maxWaitMs: options.maxWaitMs ?? 30000, maxQueueSize: options.maxQueueSize ?? 100 };
    for (const [key, maximum] of [['minIntervalMs', 60000], ['maxRetries', 5], ['maxWaitMs', 60000], ['maxQueueSize', 10000]] as const) {
      const minimum = key === 'maxQueueSize' ? 1 : 0;
      if (!Number.isSafeInteger(this.#options[key]) || this.#options[key] < minimum || this.#options[key] > maximum) throw new Park4nightError('INVALID_INPUT', `${key} must be an integer between ${minimum} and ${maximum}.`);
    }
  }

  run<T>(operation: (attempt: number) => Promise<T>, options: { retryable: boolean; signal?: AbortSignal }): Promise<T> {
    try { throwIfCancelled(options.signal); } catch (error) { return Promise.reject(error); }
    if (this.#queue.length >= this.#options.maxQueueSize) return Promise.reject(new Park4nightError('QUEUE_FULL', 'The request queue is full. Wait for pending requests to finish.'));
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        signal: options.signal,
        cancel: () => {
          const index = this.#queue.indexOf(task);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(cancelled());
        },
        execute: async () => {
          try {
            for (let attempt = 0; ; attempt++) {
              await this.#waitForSlot(options.signal);
              try {
                const result = await operation(attempt);
                throwIfCancelled(options.signal);
                resolve(result);
                return;
              } catch (error) {
                if (error instanceof Park4nightError && error.code === 'RATE_LIMITED' && error.retryAfterMs !== undefined) {
                  this.#blockedUntil = Math.max(this.#blockedUntil, Math.min(Number.MAX_SAFE_INTEGER, Date.now() + error.retryAfterMs));
                }
                throwIfCancelled(options.signal);
                if (!(error instanceof Park4nightError) || error.code !== 'RATE_LIMITED' || !options.retryable || attempt >= this.#options.maxRetries || error.retryAfterMs === undefined || error.retryAfterMs > this.#options.maxWaitMs) throw error;
              }
            }
          } catch (error) { reject(error); }
        }
      };
      options.signal?.addEventListener('abort', task.cancel, { once: true });
      this.#queue.push(task);
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    const task = this.#queue.shift();
    if (!task) return;
    this.#running = true;
    task.signal?.removeEventListener('abort', task.cancel);
    try { await task.execute(); } finally {
      this.#running = false;
      void this.#drain();
    }
  }

  async #waitForSlot(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const cooldown = this.#blockedUntil - Date.now();
    if (cooldown > this.#options.maxWaitMs) throw new Park4nightError('RATE_LIMITED', 'Park4night requests are paused. Try after retryAfterMs.', 429, cooldown);
    let remaining = Math.max(this.#nextRequestAt, this.#blockedUntil) - Date.now();
    while (remaining > 0) {
      await delay(remaining, signal);
      remaining = Math.max(this.#nextRequestAt, this.#blockedUntil) - Date.now();
    }
    throwIfCancelled(signal);
    this.#nextRequestAt = Date.now() + this.#options.minIntervalMs;
  }
}
