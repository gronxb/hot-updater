// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { getRequestHeadersMock, getSessionMock, setResponseStatusMock } =
  vi.hoisted(() => ({
    getRequestHeadersMock: vi.fn(),
    getSessionMock: vi.fn(),
    setResponseStatusMock: vi.fn(),
  }));

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: getRequestHeadersMock,
  setResponseStatus: setResponseStatusMock,
}));

vi.mock("./auth-factory.server.ts", () => ({
  getAuth: () => ({
    api: {
      getSession: getSessionMock,
    },
  }),
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  getRequestHeadersMock.mockReset();
  getSessionMock.mockReset();
  setResponseStatusMock.mockReset();
});

describe("auth guard", () => {
  it("returns the current Better Auth session from request headers", async () => {
    const headers = new Headers({ cookie: "better-auth.session_token=token" });
    const session = {
      session: { id: "session-1", userId: "user-1" },
      user: { email: "admin@example.com", id: "user-1" },
    };
    getRequestHeadersMock.mockReturnValue(headers);
    getSessionMock.mockResolvedValue(session);

    const { requireConsoleSession } = await import("./auth-guard.server");

    await expect(requireConsoleSession()).resolves.toBe(session);
    expect(getSessionMock).toHaveBeenCalledWith({ headers });
    expect(setResponseStatusMock).not.toHaveBeenCalled();
  });

  it("sets 401 and rejects before protected work when no session exists", async () => {
    getRequestHeadersMock.mockReturnValue(new Headers());
    getSessionMock.mockResolvedValue(null);

    const { requireConsoleSession } = await import("./auth-guard.server");

    await expect(requireConsoleSession()).rejects.toThrow("Unauthorized");
    expect(setResponseStatusMock).toHaveBeenCalledWith(401);
  });
});
