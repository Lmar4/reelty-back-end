import { promisify } from "util";

export class RateLimiter {
  private queue: Array<() => Promise<void>> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly minDelay: number;

  constructor(requestsPerSecond: number = 10) {
    this.minDelay = 1000 / requestsPerSecond;
  }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minDelay) {
          const delay = this.minDelay - timeSinceLastRequest;
          await promisify(setTimeout)(delay);
        }

        try {
          const result = await operation();
          this.lastRequestTime = Date.now();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      this.queue.push(task);
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
      }
    }
    this.isProcessing = false;
  }
}

// Export singleton instance with 10 requests per second limit
export const rateLimiter = new RateLimiter(10);
