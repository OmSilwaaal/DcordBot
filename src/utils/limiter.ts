/**
 * Token-bucket rate limiter. `take()` resolves when a request may proceed.
 * `pause(ms)` is used after a 429 so every caller backs off together.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ratePerSec: number, private readonly burst = Math.max(1, Math.ceil(ratePerSec))) {
    this.tokens = burst;
  }

  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  pause(ms: number): void {
    this.refill();
    this.tokens = Math.min(this.tokens, -(ms / 1000) * this.ratePerSec);
  }

  get pending(): number {
    return this.queue.length;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && !this.timer) {
      const wait = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.max(wait, 10));
    }
  }
}
