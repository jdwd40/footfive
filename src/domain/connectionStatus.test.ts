import { describe, expect, it, beforeEach } from "vitest";
import {
  getConnectionSnapshot,
  reportConnectionFail,
  reportConnectionOk,
} from "../hooks/useConnectionStatus";

describe("connection status thresholds", () => {
  beforeEach(() => {
    reportConnectionOk();
  });

  it("stays connected after one failure", () => {
    reportConnectionFail(new Error("timeout"));
    const s = getConnectionSnapshot();
    expect(s.failCount).toBe(1);
    expect(s.state).toBe("connected");
  });

  it("shows reconnecting after two failures", () => {
    reportConnectionFail(new Error("a"));
    reportConnectionFail(new Error("b"));
    expect(getConnectionSnapshot().state).toBe("reconnecting");
  });

  it("shows offline after three failures", () => {
    reportConnectionFail(new Error("a"));
    reportConnectionFail(new Error("b"));
    reportConnectionFail(new Error("c"));
    expect(getConnectionSnapshot().state).toBe("offline");
  });

  it("clears on success", () => {
    reportConnectionFail(new Error("a"));
    reportConnectionFail(new Error("b"));
    reportConnectionFail(new Error("c"));
    reportConnectionOk();
    expect(getConnectionSnapshot().state).toBe("connected");
    expect(getConnectionSnapshot().failCount).toBe(0);
  });

  it("ignores abort errors", () => {
    reportConnectionFail(new DOMException("Aborted", "AbortError"));
    expect(getConnectionSnapshot().failCount).toBe(0);
    expect(getConnectionSnapshot().state).toBe("connected");
  });
});

describe("connection status on 429", () => {
  beforeEach(() => {
    reportConnectionOk();
  });

  it("does not count rate-limit errors towards reconnecting/offline", () => {
    for (let i = 0; i < 5; i++) {
      const err = Object.assign(new Error("Too many requests — retry in a moment."), { status: 429, rateLimited: true });
      reportConnectionFail(err);
    }
    const s = getConnectionSnapshot();
    expect(s.state).toBe("connected");
    expect(s.failCount).toBe(0);
  });

  it("a 429 between real failures leaves the count untouched", () => {
    reportConnectionFail(new Error("a"));
    reportConnectionFail(Object.assign(new Error("busy"), { status: 429 }));
    expect(getConnectionSnapshot().failCount).toBe(1);
    expect(getConnectionSnapshot().state).toBe("connected");
  });
});
