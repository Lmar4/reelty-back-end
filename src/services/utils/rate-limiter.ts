export class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private static instance: RateLimiter;

  private constructor(maxConcurrent: number = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  static getInstance(maxConcurrent: number = 2): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter(maxConcurrent);
    }
    return RateLimiter.instance;
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(() => {
          resolve();
          return Promise.resolve();
        });
      });
    }

    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }

  getCurrentLoad(): { running: number; queued: number } {
    return {
      running: this.running,
      queued: this.queue.length,
    };
  }

  clearQueue(): void {
    this.queue = [];
  }
}

export const rateLimiter = RateLimiter.getInstance();
