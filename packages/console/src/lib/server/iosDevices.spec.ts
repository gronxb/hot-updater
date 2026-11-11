// @vitest-environment node

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  get default() {
    return guard.value;
  },
}));

import { createDeviceReceipt } from "./deviceProfileToken";
import {
  issueDeviceProfileLink,
  iosDeviceViewer,
  removeIosDevice,
  requestIosDeviceAccess,
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

describe("Request access", () => {
  const viewer = {
    email: "kim@team.dev",
    canApprove: false,
    approversConfigured: true,
  };

  it("requests the UDID in this person's receipt", async () => {
    const core = coreOf();
    const receipt = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: "kim@team.dev",
    });
    const { device, created } = await requestIosDeviceAccess(
      request,
      core,
      viewer,
      { receipt, name: "Kim's iPhone" },
    );
    expect(created).toBe(true);
    expect(device).toMatchObject({
      udid: PHONE,
      requested_by: "kim@team.dev",
      status: "pending",
    });
  });

  it("refuses another person's receipt, an expired one, and a forged one", async () => {
    const core = coreOf();
    const others = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: "mallory@team.dev",
    });
    const expired = await createDeviceReceipt(
      SECRET,
      { u: PHONE, e: "kim@team.dev" },
      Date.now() - 2 * 60 * 60 * 1000,
    );
    for (const receipt of [others, expired, `forged.${"a".repeat(43)}`]) {
      expect(
        await status(() =>
          requestIosDeviceAccess(request, core, viewer, {
            receipt,
            name: "Kim's iPhone",
          }),
        ),
      ).toBe(403);
    }
    expect(await core.listIosDevices({ limit: 10 })).toEqual([]);
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
