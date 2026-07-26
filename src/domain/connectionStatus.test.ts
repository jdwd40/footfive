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
