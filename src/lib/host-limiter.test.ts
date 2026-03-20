import { afterEach, describe, expect, it, vi } from "vitest";
import { PerHostRateLimiter } from "./host-limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PerHostRateLimiter", () => {
  it("spaces repeated requests to the same host", async () => {
    vi.useFakeTimers();

    const limiter = new PerHostRateLimiter(100);
    await limiter.schedule("shop.test");

    let done = false;
    const pending = limiter.schedule("shop.test").then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("does not block different hosts behind each other", async () => {
    vi.useFakeTimers();

    const limiter = new PerHostRateLimiter(100);
    await limiter.schedule("shop-a.test");

    let done = false;
    const pending = limiter.schedule("shop-b.test").then(() => {
      done = true;
    });

    await Promise.resolve();
    await pending;
    expect(done).toBe(true);
  });
});
