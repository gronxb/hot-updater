import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "./inProcess.testFixtures";
import {
  IOS_DEVICE_DISABLED_ERROR,
  IOS_DEVICE_MISSING_ERROR,
  IosDeviceInputError,
} from "./iosDevices";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const IPAD = "a".repeat(40);
const ISSUER = "69a6de70-0000-47e3-e053-5b8c7c11a4d1";
const OTHER_ISSUER = "69a6de70-1111-47e3-e053-5b8c7c11a4d1";

const setup = () => {
  let clock = 1_000;
  return createInProcessCoreApi(createMemoryAdapter(), {
    now: () => (clock += 1),
  });
};

const requested = async (
  core: ReturnType<typeof setup>,
  udid = PHONE,
  requestedBy: string | null = "kim@team.dev",
) =>
  (await core.requestIosDevice({ udid, name: "Kim's iPhone", requestedBy }))
    .device;

const approved = async (core: ReturnType<typeof setup>, udid = PHONE) => {
  const device = await requested(core, udid);
  return (await core.approveIosDevice(device.id, {
    approvedBy: "lead@team.dev",
  }))!;
};

const seenOf = (device: {
  status: "pending" | "approved" | "registered";
  approved_at_ms: number | null;
}) => ({ status: device.status, approvedAtMs: device.approved_at_ms });

describe("the iOS device registry", () => {
  it("keeps one pending row per UDID, whoever asks again, in either case", async () => {
    const core = setup();
    const first = await core.requestIosDevice({
      udid: PHONE,
      name: "  Kim's iPhone ",
      requestedBy: "Kim@Team.dev",
    });
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({
      udid: PHONE.toLowerCase(),
      name: "Kim's iPhone",
      status: "pending",
      requested_by: "kim@team.dev",
      approved_at_ms: null,
    });
    const again = await core.requestIosDevice({
      udid: PHONE.toLowerCase(),
      name: "Mallory's iPhone",
      requestedBy: "mallory@team.dev",
    });
    expect(again).toEqual({ device: first.device, created: false });
    expect(await core.listIosDevices({ limit: 10 })).toEqual([first.device]);
    expect(await core.findIosDevice(PHONE.toUpperCase())).toEqual(first.device);
    expect(await core.findIosDevice("not a udid")).toBeNull();
  });

  it("refuses a UDID or name it can't store", async () => {
    const core = setup();
    await expect(
      core.requestIosDevice({ udid: "1234", name: "x", requestedBy: null }),
    ).rejects.toBeInstanceOf(IosDeviceInputError);
    await expect(
      core.requestIosDevice({ udid: PHONE, name: " ", requestedBy: null }),
    ).rejects.toBeInstanceOf(IosDeviceInputError);
    await expect(
      core.requestIosDevice({
        udid: PHONE,
        name: "x".repeat(101),
        requestedBy: null,
      }),
    ).rejects.toBeInstanceOf(IosDeviceInputError);
    expect(await core.listIosDevices({ limit: 10 })).toEqual([]);
  });

  it("approves a pending row once, and renames without approving", async () => {
    const core = setup();
    const device = await requested(core);
    const renamed = await core.renameIosDevice(device.id, "Kim's work iPhone");
    expect(renamed).toMatchObject({
      name: "Kim's work iPhone",
      status: "pending",
    });
    const approval = await core.approveIosDevice(device.id, {
      approvedBy: "Lead@Team.dev",
    });
    expect(approval).toMatchObject({
      status: "approved",
      approved_by: "lead@team.dev",
    });
    const approvedAt = approval!.approved_at_ms;
    expect(approvedAt).not.toBeNull();
    // Approving again only renames.
    expect(
      await core.approveIosDevice(device.id, {
        name: "Kim's iPhone 17",
        approvedBy: null,
      }),
    ).toMatchObject({
      name: "Kim's iPhone 17",
      approved_by: "lead@team.dev",
      approved_at_ms: approvedAt,
    });
    expect(
      await core.approveIosDevice("unknown", { approvedBy: null }),
    ).toBeNull();
    expect(await core.renameIosDevice("unknown", "x")).toBeNull();
  });

  it("lists by status, a page at a time", async () => {
    const core = setup();
    const pending = await requested(core, PHONE);
    const ipad = await approved(core, IPAD);
    expect(await core.listIosDevices({ status: "pending", limit: 10 })).toEqual(
      [pending],
    );
    expect(
      await core.listIosDevices({ status: "approved", limit: 10 }),
    ).toEqual([ipad]);
    const [first] = await core.listIosDevices({ limit: 1 });
    expect(
      await core.listIosDevices({ limit: 10, after: first!.id }),
    ).toHaveLength(1);
    await expect(
      core.listIosDevices({ status: "gone" as "pending", limit: 1 }),
    ).rejects.toBeInstanceOf(IosDeviceInputError);
  });

  it("registers an approved row, keeping the first time and clearing the error", async () => {
    const core = setup();
    const device = await approved(core);
    const refused = await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(device),
      issuerId: ISSUER,
      outcome: "refused",
      reason: "  The device\nlimit was reached.  ",
    });
    expect(refused).toMatchObject({
      status: "approved",
      apple_error: "The device limit was reached.",
    });
    const registered = await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(refused!),
      issuerId: ISSUER,
      outcome: "registered",
    });
    expect(registered).toMatchObject({
      status: "registered",
      apple_issuer_id: ISSUER,
      apple_error: null,
    });
    const firstTime = registered!.registered_at_ms;
    const again = await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(registered!),
      issuerId: ISSUER,
      outcome: "registered",
    });
    expect(again?.registered_at_ms).toBe(firstTime);
    expect(await core.findIosDevice(PHONE)).toEqual(again);
  });

  it("writes nothing over a row that changed or is gone since it was read", async () => {
    const core = setup();
    const device = await approved(core);
    const seen = seenOf(device);
    await core.deleteIosDevice(device.id);
    expect(
      await core.recordIosDeviceOutcome({
        id: device.id,
        seen,
        issuerId: ISSUER,
        outcome: "registered",
      }),
    ).toBeNull();
    expect(await core.listIosDevices({ limit: 10 })).toEqual([]);

    // Removed and requested again: a new row, whose approval is newer.
    const anew = await approved(core);
    expect(
      await core.recordIosDeviceOutcome({
        id: anew.id,
        seen: { status: "approved", approvedAtMs: 1 },
        issuerId: ISSUER,
        outcome: "registered",
      }),
    ).toBeNull();
    expect(await core.findIosDevice(PHONE)).toEqual(anew);
  });

  it("never changes a row another account registered", async () => {
    const core = setup();
    const device = await approved(core);
    const registered = (await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(device),
      issuerId: ISSUER,
      outcome: "registered",
    }))!;
    for (const outcome of ["missing", "disabled", "registered"] as const) {
      expect(
        await core.recordIosDeviceOutcome({
          id: device.id,
          seen: seenOf(registered),
          issuerId: OTHER_ISSUER,
          outcome,
        }),
      ).toBeNull();
    }
    expect(await core.findIosDevice(PHONE)).toEqual(registered);
  });

  it("sends a registered row Apple no longer lists back to pending, with its approval cleared", async () => {
    const core = setup();
    const device = await approved(core);
    const registered = (await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(device),
      issuerId: ISSUER,
      outcome: "registered",
    }))!;
    expect(
      await core.recordIosDeviceOutcome({
        id: device.id,
        seen: seenOf(registered),
        issuerId: ISSUER,
        outcome: "disabled",
      }),
    ).toMatchObject({
      status: "registered",
      apple_error: IOS_DEVICE_DISABLED_ERROR,
    });
    const missing = await core.recordIosDeviceOutcome({
      id: device.id,
      seen: seenOf(registered),
      issuerId: ISSUER,
      outcome: "missing",
    });
    expect(missing).toMatchObject({
      status: "pending",
      approved_by: null,
      approved_at_ms: null,
      apple_error: IOS_DEVICE_MISSING_ERROR,
    });
    // Pending rows take no outcome: nothing is sent for them.
    expect(
      await core.recordIosDeviceOutcome({
        id: device.id,
        seen: seenOf(missing!),
        issuerId: ISSUER,
        outcome: "registered",
      }),
    ).toBeNull();
  });

  it("marks the newest build that lists a row, and skips one removed meanwhile", async () => {
    const core = setup();
    const kept = await approved(core, PHONE);
    const removed = await approved(core, IPAD);
    await core.deleteIosDevice(removed.id);
    const newer = "01900000-0000-7000-8000-000000000002";
    const older = "01900000-0000-7000-8000-000000000001";
    await core.markIosDevicesInBuild({
      buildId: newer,
      ids: [kept.id, removed.id],
    });
    await core.markIosDevicesInBuild({ buildId: older, ids: [kept.id] });
    expect((await core.findIosDevice(PHONE))?.build_id).toBe(newer);
    expect(await core.findIosDevice(IPAD)).toBeNull();
  });

  it("deletes a row and answers null for an unknown one", async () => {
    const core = setup();
    const device = await requested(core);
    expect(await core.deleteIosDevice(device.id)).toEqual(device);
    expect(await core.deleteIosDevice(device.id)).toBeNull();
  });
});
