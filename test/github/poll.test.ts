import { describe, it, expect } from "vitest";
import { mapGitHubStatus } from "../../src/github/poll.js";

describe("mapGitHubStatus", () => {
  it("maps queued run to queued", () => {
    const result = mapGitHubStatus("queued", null);
    expect(result.status).toBe("queued");
    expect(result.progress).toBe(5);
  });

  it("maps in_progress to running", () => {
    const result = mapGitHubStatus("in_progress", null);
    expect(result.status).toBe("running");
    expect(result.progress).toBe(50);
  });

  it("maps completed+success to success", () => {
    const result = mapGitHubStatus("completed", "success");
    expect(result.status).toBe("success");
    expect(result.progress).toBe(100);
  });

  it("maps completed+failure to failed", () => {
    const result = mapGitHubStatus("completed", "failure");
    expect(result.status).toBe("failed");
    expect(result.progress).toBe(100);
  });

  it("maps completed+cancelled to failed", () => {
    const result = mapGitHubStatus("completed", "cancelled");
    expect(result.status).toBe("failed");
    expect(result.progress).toBe(100);
  });

  it("maps completed+timed_out to timeout", () => {
    const result = mapGitHubStatus("completed", "timed_out");
    expect(result.status).toBe("timeout");
    expect(result.progress).toBe(100);
  });

  it("maps waiting to queued", () => {
    const result = mapGitHubStatus("waiting", null);
    expect(result.status).toBe("queued");
  });

  it("maps unknown status to queued", () => {
    const result = mapGitHubStatus("unknown_state", null);
    expect(result.status).toBe("queued");
  });

  it("maps unknown conclusion to failed", () => {
    const result = mapGitHubStatus("completed", "unknown_conclusion");
    expect(result.status).toBe("failed");
  });
});
