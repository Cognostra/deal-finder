import { afterEach, describe, expect, it, vi } from "vitest";
import { mapPool } from "./concurrency.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("mapPool", () => {
  it("limits in-flight work and preserves result ordering", async () => {
    vi.useFakeTimers();

    let active = 0;
    let maxActive = 0;
    const work = [30, 10, 20];
    const promise = mapPool(work, 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return `${index}:${delay}`;
    });

    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toEqual(["0:30", "1:10", "2:20"]);
    expect(maxActive).toBe(2);
  });

  it("handles empty input", async () => {
    await expect(mapPool([], 4, async () => "unused")).resolves.toEqual([]);
  });
});
