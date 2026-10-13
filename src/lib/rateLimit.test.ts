import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footfiveApi, isRateLimited, rateLimitDelayMs, rateLimitRemainingMs, resetRateLimitForTests } from "./pocketbase";
import { nextPollDelay } from "./polling";

const noJitter = () => 0;

describe("rateLimitDelayMs", () => {
  it("honours Retry-After seconds", () => {
    expect(rateLimitDelayMs("7", 0, 0, noJitter)).toBe(7000);
  });
  it("honours Retry-After as an HTTP date", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(rateLimitDelayMs("Tue, 13 Oct 2026 12:00:04 GMT", 0, now, noJitter)).toBe(4000);
  });
  it("caps a huge Retry-After", () => {
    expect(rateLimitDelayMs("3600", 0, 0, noJitter)).toBe(60000);
  });
  it("defaults to a few seconds, doubling per attempt, capped, with jitter", () => {
    expect(rateLimitDelayMs(null, 0, 0, noJitter)).toBe(3000);
    expect(rateLimitDelayMs(null, 1, 0, noJitter)).toBe(6000);
    expect(rateLimitDelayMs(null, 9, 0, noJitter)).toBe(20000);
    expect(rateLimitDelayMs("garbage", 0, 0, () => 0.5)).toBe(3500);
  });
});

describe("api() on 429", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimitForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetRateLimitForTests();
  });

  const tooMany = (retryAfter?: string) =>
    new Response(JSON.stringify({ message: "x" }), { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });

  it("waits Retry-After before the single retry, then flags the error as rate limited", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany("5")).mockResolvedValueOnce(tooMany("5"));
    vi.stubGlobal("fetch", fetchMock);
    const p = footfiveApi.serverTime().catch((e) => e);
    await vi.advanceTimersByTimeAsync(4900);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry inside the Retry-After window
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const err = await p;
    expect(isRateLimited(err)).toBe(true);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeGreaterThan(4000);
    expect(rateLimitRemainingMs()).toBeGreaterThan(4000);
    // Pollers stay out of the shared cooldown.
    expect(nextPollDelay(1000, 0)).toBeGreaterThan(4000);
  });

  it("recovers when the retry succeeds", async () => {
    const ok = new Response(JSON.stringify({ serverTime: "t", serverTimeMs: 1 }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok));
    const p = footfiveApi.serverTime();
    await vi.advanceTimersByTimeAsync(4100);
    await expect(p).resolves.toEqual({ serverTime: "t", serverTimeMs: 1 });
  });
});

describe("nextPollDelay", () => {
  beforeEach(() => resetRateLimitForTests());
  it("backs off after failures and caps", () => {
    expect(nextPollDelay(3000, 0)).toBe(3000);
    expect(nextPollDelay(3000, 1)).toBe(6000);
    expect(nextPollDelay(3000, 2)).toBe(12000);
    expect(nextPollDelay(3000, 10)).toBe(30000);
  });
});
