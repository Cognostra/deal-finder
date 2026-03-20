/** Simple per-host spacing (min interval between starts) to respect RPS caps. */
export class PerHostRateLimiter {
  private nextSlot = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async schedule(host: string): Promise<void> {
    const now = Date.now();
    const next = this.nextSlot.get(host) ?? now;
    const wait = Math.max(0, next - now);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.nextSlot.set(host, Date.now() + this.minIntervalMs);
  }
}
