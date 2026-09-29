// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleAuthAdapter } from "../../index";

const { getConsoleAuthAdapterMock } = vi.hoisted(() => ({
  getConsoleAuthAdapterMock: vi.fn(),
}));

vi.mock("./console-runtime.server", () => ({
  getConsoleAuthAdapter: getConsoleAuthAdapterMock,
}));

import {
  getConsoleAuthProviders,
  handleConsoleAuth,
  requireConsoleAccess,
} from "./auth.server";

let request: Request;

const createAdapter = (
  getAccess: ConsoleAuthAdapter["getAccess"],
): ConsoleAuthAdapter => ({
  getAccess,
  getProviders: vi.fn(async () => ["google", "github"] as const),
  handle: vi.fn(async () => new Response("auth-handler")),
});

beforeEach(() => {
  getConsoleAuthAdapterMock.mockReset();
  request = new Request("https://console.example.com/");
});

describe("console auth boundary", () => {
  it("returns the authorized principal", async () => {
    const principal = { email: "admin@example.com", name: "Admin" };
    const adapter = createAdapter(
      vi.fn(async () => ({ status: "authorized" as const, principal })),
    );
    getConsoleAuthAdapterMock.mockResolvedValue(adapter);

    await expect(requireConsoleAccess(request)).resolves.toEqual(principal);
    expect(adapter.getAccess).toHaveBeenCalledWith(request);
  });

  it.each([
    {
      access: { status: "unauthenticated" } as const,
      expectedStatus: 401,
    },
    {
      access: {
        status: "forbidden",
        principal: { email: "viewer@example.com" },
      } as const,
      expectedStatus: 403,
    },
  ])("rejects $access.status access", async ({ access, expectedStatus }) => {
    getConsoleAuthAdapterMock.mockResolvedValue(
      createAdapter(vi.fn(async () => access)),
    );

    await expect(requireConsoleAccess(request)).rejects.toMatchObject({
      status: expectedStatus,
    });
  });

  it("asks the adapter once per request", async () => {
    const principal = { email: "admin@example.com" };
    const adapter = createAdapter(
      vi.fn(async () => ({ status: "authorized" as const, principal })),
    );
    getConsoleAuthAdapterMock.mockResolvedValue(adapter);

    await requireConsoleAccess(request);
    await requireConsoleAccess(request);
    expect(adapter.getAccess).toHaveBeenCalledOnce();

    await requireConsoleAccess(new Request("https://console.example.com/"));
    expect(adapter.getAccess).toHaveBeenCalledTimes(2);
  });

  it("delegates provider discovery and auth protocol requests", async () => {
    const adapter = createAdapter(
      vi.fn(async () => ({ status: "unauthenticated" as const })),
    );
    getConsoleAuthAdapterMock.mockResolvedValue(adapter);

    await expect(getConsoleAuthProviders(request)).resolves.toEqual([
      "google",
      "github",
    ]);
    const response = await handleConsoleAuth(request);

    await expect(response.text()).resolves.toBe("auth-handler");
    expect(adapter.getProviders).toHaveBeenCalledWith(request);
    expect(adapter.handle).toHaveBeenCalledWith(request);
  });
});
