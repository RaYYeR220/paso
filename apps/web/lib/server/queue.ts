/** Runs one task at a time, in the order the tasks were added. */
export type Queue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A queue for everything one account sends.
 *
 * Each transaction uses the account's next sequence number, and the network
 * holds one pending transaction per account. Sending through a queue keeps
 * the numbers in order however many requests arrive together. The queue
 * lives in this process: several server instances sharing one account still
 * collide now and then, which is why senders also retry on a bad sequence.
 */
export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
