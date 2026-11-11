import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseHarness } from "./database.testFixtures";

const {
  addAscDevices,
  confirm,
  findAscDevice,
  interactive,
  listAscDevices,
  loadConfig,
  log,
  multiselect,
  resolve,
  updateAscDevice,
} = vi.hoisted(() => ({
  addAscDevices: vi.fn(),
  confirm: vi.fn(),
  findAscDevice: vi.fn(),
  interactive: { value: true },
  listAscDevices: vi.fn(),
  loadConfig: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  multiselect: vi.fn(),
  resolve: vi.fn(),
  updateAscDevice: vi.fn(),
}));

const databaseHarness = createDatabaseHarness();

vi.mock("@hot-updater/apple-helper", () => ({
  addAscDevices,
  findAscDevice,
  listAscDevices,
  updateAscDevice,
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  loadConfig,
  nonInteractiveReason: () =>
    interactive.value ? undefined : "stdin is not a terminal",
  p: {
    log,
    confirm,
    multiselect,
    isCancel: (value: unknown) => typeof value === "symbol",
  },
  readLoadedHotUpdaterEnv: async () => ({}),
  withCredentialResolver: (run: (credentials: unknown) => unknown) =>
    run({ resolve }),
}));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));
// The registry is the test's core, as `loadServer` gives it the config's.
vi.mock("../utils/loadServer", async (importOriginal) => {
  const { testServer } = await import("../utils/testServer");
  return {
    ...(await importOriginal<typeof import("../utils/loadServer")>()),
    loadServer: vi.fn(async () =>
      testServer({ database: databaseHarness.database }),
    ),
  };
});

import { secret } from "@hot-updater/cli-tools";

import {
  handleNativeBuildDevicesAdd,
  handleNativeBuildDevicesList,
  handleNativeBuildDevicesRemove,
  handleNativeBuildDevicesRename,
} from "./nativeBuildDevices";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const OTHER_PHONE = "00008110-000A1B2C3D4E5F60";
const API_KEY = { keyId: "K", issuerId: "issuer-a", keyPath: "/k.p8" };

const device = (udid: string, name = "iPhone", status = "ENABLED") => ({
  id: `D-${udid}`,
  udid,
  name,
  status,
  deviceClass: "IPHONE",
});

const expectExit = async (run: () => Promise<unknown>) => {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await expect(run()).rejects.toThrow("exit 1");
  exit.mockRestore();
};

const allLogged = (method: keyof typeof log) =>
  log[method].mock.calls.map(([line]) => String(line)).join("\n");

const registry = () => databaseHarness.core.listIosDevices({ limit: 100 });

const request = async (udid: string, name: string) =>
  (
    await databaseHarness.core.requestIosDevice({
      udid,
      name,
      requestedBy: "kim@team.dev",
    })
  ).device;

beforeEach(() => {
  vi.clearAllMocks();
  databaseHarness.reset();
  interactive.value = true;
  process.exitCode = 0;
  resolve.mockResolvedValue(API_KEY);
  findAscDevice.mockResolvedValue(null);
  listAscDevices.mockResolvedValue([]);
  loadConfig.mockResolvedValue({
    secrets: undefined,
    database: databaseHarness.database,
    storage: undefined,
    plugins: [],
    nativeBuild: {
      ios: {
        testers: {
          bundleIdentifier: "com.example.app",
          signing: { ascApiKey: secret("team-key") },
        },
        sim: { bundleIdentifier: "com.example.app", simulator: true },
      },
    },
  });
});

describe("native-build devices add", () => {
  it("records a passed UDID as approved, registers it with the scheme's key, and says to build again", async () => {
    addAscDevices.mockImplementation(async ({ devices }) =>
      devices.map(({ udid, name }: { udid: string; name: string }) => ({
        udid,
        outcome: "registered",
        device: device(udid, name),
      })),
    );

    await handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["Kim"] });

    expect(resolve).toHaveBeenCalledWith({
      kind: "asc-api-key",
      name: "team-key",
    });
    expect(addAscDevices).toHaveBeenCalledWith({
      devices: [{ udid: PHONE.toLowerCase(), name: "Kim" }],
      apiKey: API_KEY,
    });
    expect(await registry()).toEqual([
      expect.objectContaining({
        udid: PHONE.toLowerCase(),
        name: "Kim",
        status: "registered",
        requested_by: null,
        approved_by: null,
        apple_issuer_id: "issuer-a",
      }),
    ]);
    expect(allLogged("success")).toBe("Registered Kim with Apple.");
    expect(allLogged("info")).toContain(
      "npx hot-updater native-build ios --scheme testers",
    );
    expect(allLogged("info")).not.toContain("grep");
    expect(process.exitCode).toBe(0);
  });

  it("refuses a malformed UDID before the registry or Apple", async () => {
    await expectExit(() =>
      handleNativeBuildDevicesAdd({ udid: ["1234"], name: ["Kim"] }),
    );
    expect(allLogged("error")).toContain(
      "1234 isn't an iPhone's or iPad's UDID.",
    );
    expect(addAscDevices).not.toHaveBeenCalled();
    expect(await registry()).toEqual([]);
  });

  it("at a terminal, picks from the requested devices and approves only those", async () => {
    const kim = await request(PHONE, "Kim's iPhone");
    await request(OTHER_PHONE, "Lee's iPhone");
    multiselect.mockResolvedValue([kim.id]);
    addAscDevices.mockImplementation(async ({ devices }) =>
      devices.map(({ udid, name }: { udid: string; name: string }) => ({
        udid,
        outcome: "registered",
        device: device(udid, name),
      })),
    );

    await handleNativeBuildDevicesAdd({});

    expect(multiselect.mock.calls[0]![0]).toMatchObject({
      message:
        "Register which devices with Apple now? Each new one uses one of the account's 100 a year.",
      options: expect.arrayContaining([
        {
          value: kim.id,
          label: "Kim's iPhone",
          hint: "requested · kim@team.dev",
        },
        expect.objectContaining({ label: "Lee's iPhone" }),
      ]),
    });
    expect(addAscDevices).toHaveBeenCalledOnce();
    const rows = await registry();
    expect(
      Object.fromEntries(rows.map(({ name, status }) => [name, status])),
    ).toEqual({ "Kim's iPhone": "registered", "Lee's iPhone": "pending" });
  });

  it("outside a terminal without --udid, refuses with the one next step", async () => {
    interactive.value = false;
    await request(PHONE, "Kim's iPhone");
    await expectExit(() => handleNativeBuildDevicesAdd({}));
    expect(allLogged("error")).toBe(
      "Pass --udid and --name, or run this at a terminal to pick from the requested devices.",
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("with nothing requested, points to the Console", async () => {
    await handleNativeBuildDevicesAdd({});
    expect(allLogged("info")).toBe(
      "No iOS devices are waiting. Testers register on the Console's iOS devices page.",
    );
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("keeps Apple's refusal on the row and fails, with no rebuild step", async () => {
    addAscDevices.mockResolvedValue([
      {
        udid: PHONE,
        outcome: "refused",
        reason: "The maximum number of devices was reached.",
        limitReached: true,
      },
    ]);
    await handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["Kim"] });
    expect(allLogged("error")).toContain(
      "TestFlight has no such limit: npx hot-updater testflight",
    );
    expect(await registry()).toEqual([
      expect.objectContaining({
        status: "approved",
        apple_error: "The maximum number of devices was reached.",
      }),
    ]);
    expect(log.info).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("native-build devices list", () => {
  it("shows the registry and the Apple account side by side, by UDID", async () => {
    await request(PHONE, "Kim's iPhone");
    listAscDevices.mockResolvedValue([
      device(OTHER_PHONE, "Old iPad", "DISABLED"),
    ]);

    await handleNativeBuildDevicesList({});

    const table = allLogged("message");
    expect(table).toMatch(/Kim's iPhone.*kim@team\.dev.*Requested/u);
    expect(table).toMatch(/Old iPad.*Disabled/u);
  });

  it("gives an empty registry and account the next step", async () => {
    await handleNativeBuildDevicesList({});
    expect(allLogged("info")).toBe(
      "No iOS devices yet. Testers register on the Console's iOS devices page.",
    );
  });
});

describe("native-build devices rename", () => {
  it("renames the registry row and the Apple device together", async () => {
    await request(PHONE, "Kim's iPhone");
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));

    await handleNativeBuildDevicesRename({
      udid: PHONE.toLowerCase(),
      name: "Kim's work iPhone",
    });

    expect((await registry())[0]?.name).toBe("Kim's work iPhone");
    expect(updateAscDevice).toHaveBeenCalledWith({
      device: device(PHONE, "Kim's iPhone"),
      change: { name: "Kim's work iPhone" },
      apiKey: API_KEY,
    });
    expect(allLogged("success")).toBe(
      "Renamed to Kim's work iPhone in the registry and at Apple.",
    );
  });

  it("fails for a UDID neither knows", async () => {
    await expectExit(() =>
      handleNativeBuildDevicesRename({ udid: PHONE, name: "x" }),
    );
    expect(allLogged("error")).toContain(
      "isn't in the registry or the Apple account.",
    );
    expect(updateAscDevice).not.toHaveBeenCalled();
  });
});

describe("native-build devices remove", () => {
  it("deletes the row and, once confirmed, disables the device at Apple, saying what that costs", async () => {
    await request(PHONE, "Kim's iPhone");
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));
    confirm.mockResolvedValue(true);

    await handleNativeBuildDevicesRemove({ udid: PHONE });

    expect(await registry()).toEqual([]);
    expect(confirm.mock.calls[0]![0].message).toBe(
      "Disable Kim's iPhone at Apple too? Its slot isn't returned until the membership year renews, and it leaves new builds of every app on the team.",
    );
    expect(updateAscDevice).toHaveBeenCalledWith({
      device: device(PHONE, "Kim's iPhone"),
      change: { status: "DISABLED" },
      apiKey: API_KEY,
    });
  });

  it("keeps the device enabled at Apple when the answer is no", async () => {
    await request(PHONE, "Kim's iPhone");
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));
    confirm.mockResolvedValue(false);

    await handleNativeBuildDevicesRemove({ udid: PHONE });

    expect(await registry()).toEqual([]);
    expect(updateAscDevice).not.toHaveBeenCalled();
    expect(allLogged("info")).toBe(
      "Kim's iPhone stays enabled at Apple, so new ad hoc builds keep it.",
    );
  });

  it("disables without asking with --yes, and outside a terminal without it, deletes only the row and says how", async () => {
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));
    await handleNativeBuildDevicesRemove({ udid: PHONE, yes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(updateAscDevice).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    interactive.value = false;
    await request(PHONE, "Kim's iPhone");
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));
    await handleNativeBuildDevicesRemove({ udid: PHONE });
    expect(await registry()).toEqual([]);
    expect(updateAscDevice).not.toHaveBeenCalled();
    expect(allLogged("info")).toContain(
      `npx hot-updater native-build devices remove --udid ${PHONE} --yes`,
    );
  });

  it("changes nothing at Apple for a device another account registered", async () => {
    const row = await request(PHONE, "Kim's iPhone");
    const approved = await databaseHarness.core.approveIosDevice(row.id, {
      approvedBy: null,
    });
    await databaseHarness.core.recordIosDeviceOutcome({
      id: row.id,
      seen: { status: "approved", approvedAtMs: approved!.approved_at_ms },
      issuerId: "issuer-b",
      outcome: "registered",
    });
    findAscDevice.mockResolvedValue(device(PHONE, "Kim's iPhone"));

    await handleNativeBuildDevicesRemove({ udid: PHONE, yes: true });

    expect(updateAscDevice).not.toHaveBeenCalled();
    expect(allLogged("warn")).toContain("another Apple account");
  });
});
