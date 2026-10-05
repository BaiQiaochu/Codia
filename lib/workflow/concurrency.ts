type QueueJob<T = unknown> = {
  thunk: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export function createLimiter({ maxConcurrent, maxTotal }: { maxConcurrent: number; maxTotal: number }) {
  let active = 0;
  let total = 0;
  const queue: QueueJob[] = [];

  function pump() {
    if (active >= maxConcurrent) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    Promise.resolve()
      .then(job.thunk)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }

  return {
    run<T>(thunk: () => Promise<T>): Promise<T> {
      total++;
      if (total > maxTotal) {
        return Promise.reject(new Error(`workflow exceeded agent total limit ${maxTotal} (agent 总数上限)`));
      }
      return new Promise<T>((resolve, reject) => {
        queue.push({ thunk, resolve, reject } as QueueJob);
        pump();
      });
    },
    get activeCount() {
      return active;
    },
    get totalSpawned() {
      return total;
    },
  };
}
