/**
 * Quota gate and upstream concurrency control.
 *
 * When the backend reports an exhausted quota, every request is parked on one
 * shared timer instead of hammering the API with retries. The timer wakes at
 * the reset timestamp (plus jitter) and all waiters continue in the order in
 * which they arrived.
 */

export interface QuotaState {
  /** Epoch ms until which requests are parked, 0 when open. */
  blockedUntil: number;
  /** Number of requests currently waiting for the gate. */
  waiting: number;
  /** Last classification that caused a block. */
  lastReason?: string;
  /** Epoch ms of the last block event. */
  lastBlockedAt?: number;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class QuotaGate {
  #until = 0;
  #waiting = 0;
  #lastReason: string | undefined;
  #lastBlockedAt: number | undefined;

  /** Park all requests until `epochMs`. Never shortens an active block. */
  block(epochMs: number, reason?: string): void {
    if (epochMs <= this.#until) return;
    this.#until = epochMs;
    this.#lastReason = reason;
    this.#lastBlockedAt = Date.now();
  }

  /** Remaining block time in ms. */
  remaining(now = Date.now()): number {
    return Math.max(0, this.#until - now);
  }

  /** Wait until the gate opens. Re-checks after waking so later blocks apply. */
  async wait(signal?: AbortSignal): Promise<void> {
    this.#waiting += 1;
    try {
      while (this.remaining() > 0) {
        await delay(Math.min(this.remaining(), 30_000), signal);
      }
    } finally {
      this.#waiting -= 1;
    }
  }

  state(): QuotaState {
    return {
      blockedUntil: this.#until,
      waiting: this.#waiting,
      lastReason: this.#lastReason,
      lastBlockedAt: this.#lastBlockedAt,
    };
  }

  reset(): void {
    this.#until = 0;
    this.#lastReason = undefined;
    this.#lastBlockedAt = undefined;
  }
}

/** Simple FIFO semaphore, used to keep parallel subagents from stampeding. */
export class Semaphore {
  #available: number;
  #queue: (() => void)[] = [];

  constructor(limit: number) {
    this.#available = Math.max(1, limit);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
    });
    return () => this.#release();
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#available += 1;
  }
}
