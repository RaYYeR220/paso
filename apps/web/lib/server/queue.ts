export interface QueueOptions {
  /** How many tasks may be waiting or running at once. One more is refused instead of queued. */
  maxPending: number;
  /** How long a task may run before the queue stops waiting for it and moves on. */
  timeoutMs: number;
}

/**
 * Runs one task at a time, in the order the tasks were added. A task gets a
 * signal that is aborted when the queue has given up on it: it must not
 * start anything new after that.
 */
export type Queue = (<T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>) & {
  /** How many tasks are waiting or running. */
  pending(): number;
};

/** The queue already holds as many tasks as it takes. */
export class QueueFullError extends Error {
  constructor() {
    super("The queue is full");
    this.name = "QueueFullError";
  }
}

/** A task ran longer than the queue waits for one. */
export class QueueTimeoutError extends Error {
  constructor() {
    super("The task took too long");
    this.name = "QueueTimeoutError";
  }
}

/**
 * A queue for everything one account sends.
 *
 * Each transaction uses the account's next sequence number, and the network
 * holds one pending transaction per account. Sending through a queue keeps
 * the numbers in order however many requests arrive together. The queue
 * lives in this process: several server instances sharing one account still
 * collide now and then, which is why senders also retry on a bad sequence.
 *
 * It is bounded both ways, so no request can hold it up or fill it without
 * end: a task that outlasts `timeoutMs` is abandoned and the next one
 * starts, and once `maxPending` tasks are waiting further ones are refused.
 */
export function createQueue({ maxPending, timeoutMs }: QueueOptions): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const run = <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (pending >= maxPending) return Promise.reject(new QueueFullError());
    pending += 1;

    const result = tail.then(() => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new QueueTimeoutError());
        }, timeoutMs);
      });
      return Promise.race([task(controller.signal), timedOut]).finally(() => clearTimeout(timer));
    });
    const settled = () => {
      pending -= 1;
    };
    tail = result.then(settled, settled);
    return result;
  };
  return Object.assign(run, { pending: () => pending });
}
