// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { requireConsoleSessionMock } = vi.hoisted(() => ({
  requireConsoleSessionMock: vi.fn(),
}));

vi.mock("../server/auth-guard.server.ts", () => ({
  requireConsoleSession: requireConsoleSessionMock,
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  requireConsoleSessionMock.mockReset();
});

describe("withConsoleAuth", () => {
  it("runs protected operations after session verification", async () => {
    const calls: string[] = [];
    const operation = vi.fn(async () => {
      calls.push("operation");
      return "result";
    });
    requireConsoleSessionMock.mockImplementation(async () => {
      calls.push("auth");
      return { user: { id: "user-1" } };
    });

    const { withConsoleAuth } = await import("./auth");

    await expect(withConsoleAuth(operation)).resolves.toBe("result");
    expect(calls).toEqual(["auth", "operation"]);
  });

  it("does not run protected operations without a valid session", async () => {
    const operation = vi.fn();
    requireConsoleSessionMock.mockRejectedValue(new Error("Unauthorized"));

    const { withConsoleAuth } = await import("./auth");

    await expect(withConsoleAuth(operation)).rejects.toThrow("Unauthorized");
    expect(operation).not.toHaveBeenCalled();
  });
});
