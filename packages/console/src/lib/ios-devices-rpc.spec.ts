// @vitest-environment node

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  principal: { email: "kim@team.dev" } as { email: string },
}));

vi.mock("@tanstack/react-start", () => ({
  // The access middleware runs in the server; these specs call handlers directly.
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    validator(validate: (input: unknown) => unknown) {
      (this as { validate?: unknown }).validate = validate;
      return this;
    },
    handler(handler: (input: { data: unknown }) => unknown) {
      const { validate } = this as { validate?: (input: unknown) => unknown };
      return ({ data }: { data: unknown }) =>
        handler({ data: validate ? validate(data) : data });
    },
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://console.example.com/_serverFn"),
}));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  default: undefined,
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));
vi.mock("./server/auth.server", () => ({
  requireConsoleAccess: async () => mocks.principal,
}));

import {
  approveIosDevice,
  getIosDevices,
  removeIosDevice,
  renameIosDevice,
} from "./ios-devices-rpc";

const PHONE = "00008030-001c2d3e4f5a6b7c";

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
};

let core: ReturnType<typeof createHotUpdater>["core"];
let deviceId: string;

beforeEach(async () => {
  core = createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: { name: "none", protocol: "none" },
    plugins: [],
    clientAccess: "public",
  }).core;
  deviceId = (
    await core.requestIosDevice({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: "kim@team.dev",
    })
  ).device.id;
  mocks.prepare.mockResolvedValue({
    core,
    config: { deviceApprovers: ["lead@team.dev"] },
  });
});
afterEach(() => vi.clearAllMocks());

describe("iOS device server functions", () => {
  it("refuse approving and renaming to anyone not in deviceApprovers, whatever the request says", async () => {
    mocks.principal = { email: "kim@team.dev" };
    expect(
      await status(() =>
        approveIosDevice({ data: { id: deviceId, name: "Kim's iPhone" } }),
      ),
    ).toBe(403);
    expect(
      await status(() =>
        renameIosDevice({ data: { id: deviceId, name: "Renamed" } }),
      ),
    ).toBe(403);
    expect(await core.findIosDevice(PHONE)).toMatchObject({
      status: "pending",
      name: "Kim's iPhone",
    });
  });

  it("let a listed approver approve, recording who did", async () => {
    mocks.principal = { email: "Lead@Team.dev" };
    expect(
      await approveIosDevice({ data: { id: deviceId, name: "Kim's iPhone" } }),
    ).toMatchObject({ status: "approved", approved_by: "lead@team.dev" });
  });

  it("tell the viewer what they may do, and let a requester withdraw only their own request", async () => {
    mocks.principal = { email: "mallory@team.dev" };
    expect((await getIosDevices({ data: undefined })).viewer).toEqual({
      email: "mallory@team.dev",
      canApprove: false,
      approversConfigured: true,
    });
    expect(await status(() => removeIosDevice({ data: { udid: PHONE } }))).toBe(
      403,
    );
    mocks.principal = { email: "kim@team.dev" };
    expect(await removeIosDevice({ data: { udid: PHONE } })).toMatchObject({
      udid: PHONE,
    });
  });
});
