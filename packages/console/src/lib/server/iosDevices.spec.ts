// @vitest-environment node

import { createMemoryAdapter, meterReads } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  get default() {
    return guard.value;
  },
}));

import {
  IOS_DEVICE_PAGE_SIZE,
  issueDeviceProfileLink,
  iosDeviceViewer,
  listIosDevicePage,
  listIosDevices,
  removeIosDevice,
  requireDeviceApprover,
} from "./iosDevices";

const SECRET = "s".repeat(40);
const PHONE = "00008030-001c2d3e4f5a6b7c";
const request = new Request("https://console.example.com/_serverFn");

const coreOf = () =>
  createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: { name: "none", protocol: "none" },
    plugins: [],
    clientAccess: "public",
  }).core;

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
};

beforeEach(() => {
  guard.value = undefined;
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("who approves iOS devices", () => {
  it("is nobody on a hosted Console without deviceApprovers", async () => {
    const viewer = await iosDeviceViewer({ email: "lead@team.dev" }, []);
    expect(viewer).toEqual({
      email: "lead@team.dev",
      canApprove: false,
      approversConfigured: false,
    });
    expect(() => requireDeviceApprover(viewer)).toThrow(Response);
  });

  it("is a listed email, in any case, on a hosted Console", async () => {
    const approvers = ["lead@team.dev"];
    expect(
      (await iosDeviceViewer({ email: " Lead@Team.dev " }, approvers))
        .canApprove,
    ).toBe(true);
    expect(
      (await iosDeviceViewer({ email: "kim@team.dev" }, approvers)).canApprove,
    ).toBe(false);
  });

  it("is anyone on the local Console, known by its mode, and never a hosted user named like it", async () => {
    expect(
      (await iosDeviceViewer({ email: "local@hot-updater.dev" }, []))
        .canApprove,
    ).toBe(false);
    guard.value = () => undefined;
    expect(
      (await iosDeviceViewer({ email: "anyone@team.dev" }, [])).canApprove,
    ).toBe(true);
  });
});

describe("removing a device", () => {
  it("lets the person who asked withdraw their own requested iPhone, and nobody else's", async () => {
    const core = coreOf();
    await core.requestIosDevice({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: "kim@team.dev",
    });
    const mallory = {
      email: "mallory@team.dev",
      canApprove: false,
      approversConfigured: true,
    };
    expect(await status(() => removeIosDevice(core, mallory, PHONE))).toBe(403);
    const kim = { ...mallory, email: "kim@team.dev" };
    expect((await removeIosDevice(core, kim, PHONE))?.udid).toBe(PHONE);
    expect(await core.findIosDevice(PHONE)).toBeNull();
  });

  it("refuses a withdrawal when an approval lands between the read and the delete", async () => {
    const core = coreOf();
    const { device } = await core.requestIosDevice({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: "kim@team.dev",
    });
    let reads = 0;
    const racing = {
      ...core,
      findIosDevice: async (udid: string) => {
        const row = await core.findIosDevice(udid);
        // An approver approves right after the requester's read.
        if ((reads += 1) === 1) {
          await core.approveIosDevice(device.id, {
            approvedBy: "lead@team.dev",
          });
        }
        return row;
      },
    };
    const kim = {
      email: "kim@team.dev",
      canApprove: false,
      approversConfigured: true,
    };
    expect(await status(() => removeIosDevice(racing, kim, PHONE))).toBe(403);
    expect((await core.findIosDevice(PHONE))?.status).toBe("approved");
  });

  it("refuses a requester once the iPhone is approved: an approver removes it", async () => {
    const core = coreOf();
    const { device } = await core.requestIosDevice({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: "kim@team.dev",
    });
    await core.approveIosDevice(device.id, { approvedBy: "lead@team.dev" });
    const kim = {
      email: "kim@team.dev",
      canApprove: false,
      approversConfigured: true,
    };
    expect(await status(() => removeIosDevice(core, kim, PHONE))).toBe(403);
    const lead = { ...kim, email: "lead@team.dev", canApprove: true };
    expect((await removeIosDevice(core, lead, PHONE))?.status).toBe("approved");
  });
});

describe("profile links", () => {
  const viewer = {
    email: "kim@team.dev",
    canApprove: false,
    approversConfigured: true,
  };

  it("sign nothing on the local Console, which an iPhone can't reach, or without the secret", async () => {
    guard.value = () => undefined;
    expect(
      await issueDeviceProfileLink(request, viewer, {
        mode: "register",
        name: "Kim's iPhone",
      }),
    ).toEqual({ status: "local-console" });
    guard.value = undefined;
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(
      await issueDeviceProfileLink(request, viewer, {
        mode: "register",
        name: "Kim's iPhone",
      }),
    ).toEqual({ status: "no-secret", secretName: "BETTER_AUTH_SECRET" });
  });
});

describe("the iOS devices page", () => {
  const udidOf = (n: number) => `00008110-${String(n).padStart(16, "0")}`;
  const registryOf = async (devices: number) => {
    const database = meterReads({
      name: "memory",
      adapter: createMemoryAdapter(),
    });
    const { core } = createHotUpdater({
      database,
      storage: { name: "none", protocol: "none" },
      plugins: [],
      clientAccess: "public",
    });
    for (let n = 1; n <= devices; n += 1) {
      await core.requestIosDevice({
        udid: udidOf(n),
        name: `iPhone ${n}`,
        requestedBy: null,
      });
    }
    return { core, database };
  };

  it("reads one page, however many requests the registry holds", async () => {
    const reads = [];
    for (const devices of [10, 1_000]) {
      const { core, database } = await registryOf(devices);
      const page = await database.measureReads(() =>
        listIosDevicePage(core, {}),
      );
      reads.push({
        devices,
        rows: page.adapter.rows + page.adapter.keys,
        queries: page.adapter.queries,
      });
    }
    expect(reads).toEqual([
      { devices: 10, rows: 10, queries: 1 },
      { devices: 1_000, rows: IOS_DEVICE_PAGE_SIZE, queries: 1 },
    ]);
  }, 120_000);

  it("pages the registry newest first, back and forth, within a status", async () => {
    const { core } = await registryOf(IOS_DEVICE_PAGE_SIZE + 20);
    const names = (page: { data: readonly { name: string }[] }) =>
      page.data.map(({ name }) => name);
    // The whole registry, newest first, as the ad hoc build's device list reads it.
    const newest = names({ data: await listIosDevices(core) });
    expect(newest).toHaveLength(IOS_DEVICE_PAGE_SIZE + 20);

    const first = await listIosDevicePage(core, {});
    expect(names(first)).toEqual(newest.slice(0, IOS_DEVICE_PAGE_SIZE));
    expect(first.previous).toBeUndefined();
    const second = await listIosDevicePage(core, { before: first.next });
    expect(names(second)).toEqual(newest.slice(IOS_DEVICE_PAGE_SIZE));
    expect(second.next).toBeUndefined();
    const back = await listIosDevicePage(core, { after: second.previous });
    expect(names(back)).toEqual(names(first));

    const device = await core.findIosDevice(udidOf(3));
    await core.approveIosDevice(device!.id, {
      name: "Approved iPhone",
      approvedBy: "lead@team.dev",
    });
    const approved = await listIosDevicePage(core, { status: "approved" });
    expect(names(approved)).toEqual(["Approved iPhone"]);
    expect(approved.next).toBeUndefined();
  });
});
