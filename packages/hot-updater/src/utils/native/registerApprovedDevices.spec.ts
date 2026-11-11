import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { secret } from "@hot-updater/cli-tools";
import type { IosDeviceRow } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseHarness } from "../../commands/database.testFixtures";

const { addAscDevices, listAscDevices, log } = vi.hoisted(() => ({
  addAscDevices: vi.fn(),
  listAscDevices: vi.fn(),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn() },
}));

vi.mock("@hot-updater/apple-helper", () => ({ addAscDevices, listAscDevices }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log },
}));

import {
  missingIpaDevices,
  registerApprovedDevices,
  registryIssuer,
} from "./registerApprovedDevices";

const PHONE = "00008030-001c2d3e4f5a6b7c";
const IPAD = "a".repeat(40);
const LATER = "00008110-000a1b2c3d4e5f60";
const API_KEY = { keyId: "K", issuerId: "issuer-a", keyPath: "/k.p8" };

const harness = createDatabaseHarness();
const core = harness.core;
let directory: string;

const atApple = (udid: string, status = "ENABLED", name = "Device") => ({
  id: `D-${udid}`,
  udid: udid.toUpperCase(),
  name,
  status,
  deviceClass: "IPHONE",
});

const requested = async (udid: string, name: string) =>
  (await core.requestIosDevice({ udid, name, requestedBy: "kim@team.dev" }))
    .device;

const approved = async (udid: string, name: string) =>
  (await core.approveIosDevice((await requested(udid, name)).id, {
    approvedBy: "lead@team.dev",
  }))!;

const registered = async (udid: string, name: string, issuerId: string) => {
  const row = await approved(udid, name);
  return (await core.recordIosDeviceOutcome({
    id: row.id,
    seen: { status: "approved", approvedAtMs: row.approved_at_ms },
    issuerId,
    outcome: "registered",
  }))!;
};

const statusOf = async (udid: string) =>
  (await core.findIosDevice(udid)) as IosDeviceRow | null;

const run = (
  overrides: Partial<Parameters<typeof registerApprovedDevices>[0]> = {},
) =>
  registerApprovedDevices({
    core,
    scheme: "testers",
    ascApiKey: secret("team-key"),
    exportOptionsPlist: undefined,
    resolveApiKey: async () => API_KEY,
    dryRun: false,
    ...overrides,
  });

/** Apple adds what it's sent, as `addAscDevices` reports it. */
const appleAdds = () =>
  addAscDevices.mockImplementation(async ({ devices }) =>
    devices.map(({ udid, name }: { udid: string; name: string }) => ({
      udid,
      outcome: "registered",
      device: atApple(udid, "ENABLED", name),
    })),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  harness.reset();
  listAscDevices.mockResolvedValue([]);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hu-registry-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("registerApprovedDevices", () => {
  it("does nothing, and asks Apple nothing, with an empty registry", async () => {
    expect(await run()).toEqual({
      expected: [],
      report: { registered: [], waiting: 0, problems: [], missing: [] },
    });
    expect(listAscDevices).not.toHaveBeenCalled();
  });

  it("registers approved devices one at a time, never a pending one, and expects them", async () => {
    await requested(LATER, "Pending iPhone");
    const kim = await approved(PHONE, "Kim's iPhone");
    appleAdds();

    const { expected, report } = await run();

    expect(addAscDevices).toHaveBeenCalledOnce();
    expect(addAscDevices).toHaveBeenCalledWith({
      devices: [{ udid: PHONE, name: "Kim's iPhone" }],
      apiKey: API_KEY,
    });
    expect(expected).toEqual([
      { id: kim.id, udid: PHONE, name: "Kim's iPhone" },
    ]);
    expect(report.registered).toEqual(["Kim's iPhone"]);
    expect(await statusOf(PHONE)).toMatchObject({
      status: "registered",
      apple_issuer_id: "issuer-a",
    });
    expect((await statusOf(LATER))?.status).toBe("pending");
  });

  it("marks a device Apple already has as registered, with no POST and no slot", async () => {
    await approved(PHONE, "Kim's iPhone");
    listAscDevices.mockResolvedValue([atApple(PHONE)]);

    const { expected, report } = await run();

    expect(addAscDevices).not.toHaveBeenCalled();
    expect(expected).toHaveLength(1);
    expect(report.registered).toEqual([]);
    expect((await statusOf(PHONE))?.status).toBe("registered");
  });

  it("records the first device before a failure on the second, and spends no second slot on a rerun", async () => {
    await approved(PHONE, "Kim's iPhone");
    await approved(IPAD, "Lee's iPad");
    let calls = 0;
    addAscDevices.mockImplementation(async ({ devices }) => {
      calls += 1;
      if (calls === 2) throw new Error("App Store Connect answered 503.");
      return [
        {
          udid: devices[0].udid,
          outcome: "registered",
          device: atApple(devices[0].udid),
        },
      ];
    });

    await expect(run()).rejects.toThrow("503");
    const [first, second] = addAscDevices.mock.calls.map(
      ([{ devices }]) => devices[0].udid as string,
    );
    expect((await statusOf(first!))?.status).toBe("registered");
    expect((await statusOf(second!))?.status).toBe("approved");

    // The rerun finds the first at Apple, and sends only the second.
    addAscDevices.mockReset();
    appleAdds();
    listAscDevices.mockResolvedValue([atApple(first!)]);
    const { expected } = await run();
    expect(addAscDevices).toHaveBeenCalledOnce();
    expect(addAscDevices.mock.calls[0]![0].devices[0].udid).toBe(second);
    expect(expected).toHaveLength(2);
  });

  it("sends nothing for a row removed after the list was read", async () => {
    const row = await approved(PHONE, "Kim's iPhone");
    listAscDevices.mockImplementation(async () => {
      await core.deleteIosDevice(row.id);
      return [];
    });

    const { expected } = await run();

    expect(addAscDevices).not.toHaveBeenCalled();
    expect(expected).toEqual([]);
    expect(await statusOf(PHONE)).toBeNull();
  });

  it("spends no slot when a write after Apple's answer fails, and the rerun records it without a POST", async () => {
    await approved(PHONE, "Kim's iPhone");
    appleAdds();
    const record = vi
      .spyOn(core, "recordIosDeviceOutcome")
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(run()).rejects.toThrow("database unavailable");
    expect(addAscDevices).toHaveBeenCalledOnce();
    record.mockRestore();

    addAscDevices.mockClear();
    listAscDevices.mockResolvedValue([atApple(PHONE)]);
    await run();
    expect(addAscDevices).not.toHaveBeenCalled();
    expect((await statusOf(PHONE))?.status).toBe("registered");
  });

  it("sends approved devices only from the registry's account: the issuer of its earliest registration", async () => {
    await registered(IPAD, "Lee's iPad", "issuer-b");
    await approved(PHONE, "Kim's iPhone");

    const { expected, report } = await run();

    expect(addAscDevices).not.toHaveBeenCalled();
    expect(listAscDevices).not.toHaveBeenCalled();
    expect(expected).toEqual([]);
    expect(report.waiting).toBe(1);
    expect(log.warn.mock.calls[0]![0]).toBe(
      "testers signs with another Apple account than the registry's, so 1 approved device waits.\nBuild with a scheme whose signing.ascApiKey is in the registry's account.",
    );
    // Another account's registered row, which this account doesn't list,
    // keeps its record.
    expect(await statusOf(IPAD)).toMatchObject({
      status: "registered",
      apple_issuer_id: "issuer-b",
    });
  });

  it("names the account by the earliest registration, whatever two accounts left", () => {
    const row = (id: string, issuer: string, at: number) =>
      ({
        id,
        apple_issuer_id: issuer,
        registered_at_ms: at,
      }) as IosDeviceRow;
    expect(
      registryIssuer([
        row("b", "issuer-b", 20),
        row("a", "issuer-a", 10),
        row("c", "issuer-c", 10),
      ]),
    ).toBe("issuer-a");
    expect(registryIssuer([])).toBeNull();
  });

  it("sends a registered device Apple no longer lists back to pending, without a POST", async () => {
    await registered(PHONE, "Kim's iPhone", "issuer-a");

    const { expected, report } = await run();

    expect(addAscDevices).not.toHaveBeenCalled();
    expect(expected).toEqual([]);
    expect(report.missing).toEqual(["Kim's iPhone"]);
    expect(await statusOf(PHONE)).toMatchObject({
      status: "pending",
      approved_at_ms: null,
    });
    expect(log.warn.mock.calls[0]![0]).toBe(
      "Kim's iPhone is gone from the Apple account. Approve it again in the Console to register it.",
    );
  });

  it("warns, and expects nothing, for a device Apple refuses or has disabled", async () => {
    await approved(PHONE, "Kim's iPhone");
    await registered(IPAD, "Lee's iPad", "issuer-a");
    listAscDevices.mockResolvedValue([atApple(IPAD, "DISABLED")]);
    addAscDevices.mockResolvedValue([
      {
        udid: PHONE,
        outcome: "refused",
        reason: "The maximum number of devices was reached.",
        limitReached: true,
      },
    ]);

    const { expected, report } = await run();

    expect(expected).toEqual([]);
    expect(report.problems).toEqual([
      { name: "Lee's iPad", reason: "disabled" },
      {
        name: "Kim's iPhone",
        reason: "The maximum number of devices was reached.",
      },
    ]);
    expect((await statusOf(PHONE))?.apple_error).toBe(
      "The maximum number of devices was reached.",
    );
    expect((await statusOf(IPAD))?.apple_error).toBe(
      "Disabled in the Apple account.",
    );
  });

  it("sends nothing to Apple without the scheme's key, or with a pinned profile", async () => {
    await approved(PHONE, "Kim's iPhone");

    expect((await run({ ascApiKey: undefined })).report.waiting).toBe(1);
    expect(log.warn.mock.calls[0]![0]).toBe(
      "testers signs without signing.ascApiKey, so 1 approved device waits.\nSet signing.ascApiKey on the scheme to register them.",
    );

    const exportOptionsPlist = path.join(directory, "ExportOptions.plist");
    await fs.writeFile(
      exportOptionsPlist,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>release-testing</string><key>signingStyle</key><string>manual</string></dict></plist>`,
    );
    expect((await run({ exportOptionsPlist })).report.waiting).toBe(1);
    expect(log.warn.mock.calls[1]![0]).toContain("pins a provisioning profile");
    expect(listAscDevices).not.toHaveBeenCalled();
    expect(addAscDevices).not.toHaveBeenCalled();
    expect((await statusOf(PHONE))?.status).toBe("approved");
  });

  it("on a dry run, says what it would register and writes nothing", async () => {
    await approved(PHONE, "Kim's iPhone");
    const resolveApiKey = vi.fn(async () => API_KEY);

    const { expected } = await run({ dryRun: true, resolveApiKey });

    expect(expected).toEqual([]);
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(listAscDevices).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "iOS devices · would register 1 approved device",
    );
    expect((await statusOf(PHONE))?.status).toBe("approved");
  });
});

describe("missingIpaDevices", () => {
  it("names the expected devices an .ipa doesn't list", () => {
    const expected = [
      { id: "1", udid: PHONE, name: "Kim's iPhone" },
      { id: "2", udid: IPAD, name: "Lee's iPad" },
    ];
    expect(missingIpaDevices(expected, [IPAD])).toEqual([expected[0]]);
    expect(missingIpaDevices(expected, [PHONE, IPAD])).toEqual([]);
  });
});
