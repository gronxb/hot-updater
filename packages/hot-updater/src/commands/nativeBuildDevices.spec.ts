import { beforeEach, describe, expect, it, vi } from "vitest";

const { addAscDevices, listAscDevices, loadConfig, log, resolve } = vi.hoisted(
  () => ({
    addAscDevices: vi.fn(),
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
    resolve: vi.fn(),
  }),
);

vi.mock("@hot-updater/apple-helper", () => ({ addAscDevices, listAscDevices }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  loadConfig,
  p: { log },
  readLoadedHotUpdaterEnv: async () => ({}),
  withCredentialResolver: (run: (credentials: unknown) => unknown) =>
    run({ resolve }),
}));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

import { secret } from "@hot-updater/cli-tools";

import {
  handleNativeBuildDevicesAdd,
  handleNativeBuildDevicesList,
} from "./nativeBuildDevices";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const OTHER_PHONE = "00008110-000A1B2C3D4E5F60";
const API_KEY = { keyId: "K", issuerId: "I", keyPath: "/k.p8" };

const device = (udid: string, name = "iPhone") => ({
  id: "D",
  udid,
  name,
  status: "ENABLED",
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

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  resolve.mockResolvedValue(API_KEY);
  loadConfig.mockResolvedValue({
    secrets: undefined,
    nativeBuild: {
      ios: {
        sandbox: {
          bundleIdentifier: "com.example.app",
          signing: { ascApiKey: secret("team-key") },
        },
        sim: { bundleIdentifier: "com.example.app", simulator: true },
      },
    },
  });
});

describe("native-build devices add", () => {
  it("registers a UDID with the scheme's key, and prints the one next step: rebuild", async () => {
    addAscDevices.mockResolvedValue([
      { udid: PHONE, outcome: "registered", device: device(PHONE, "Kim") },
    ]);

    await handleNativeBuildDevicesAdd({
      scheme: "sandbox",
      udid: [PHONE],
      name: ["Kim"],
    });

    expect(resolve).toHaveBeenCalledWith({
      kind: "asc-api-key",
      name: "team-key",
    });
    expect(addAscDevices).toHaveBeenCalledWith({
      devices: [{ udid: PHONE, name: "Kim" }],
      apiKey: API_KEY,
    });
    expect(allLogged("success")).toContain(`Registered ${PHONE} as Kim.`);
    expect(allLogged("info")).toContain(
      `npx hot-updater native-build ios --scheme sandbox --udid ${PHONE}`,
    );
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it("says a device already there is, succeeds, and still says to rebuild", async () => {
    addAscDevices.mockResolvedValue([
      { udid: PHONE, outcome: "already-registered", device: device(PHONE) },
    ]);

    await handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["Kim"] });

    expect(allLogged("step")).toContain("already registered");
    expect(allLogged("info")).toContain("--udid");
    expect(process.exitCode).toBe(0);
  });

  it("takes --udid repeated, pairing --name, and drops a repeat of the same phone", async () => {
    addAscDevices.mockResolvedValue([
      { udid: PHONE, outcome: "registered", device: device(PHONE, "A") },
      {
        udid: OTHER_PHONE,
        outcome: "registered",
        device: device(OTHER_PHONE, "B"),
      },
    ]);

    await handleNativeBuildDevicesAdd({
      udid: [PHONE, OTHER_PHONE],
      name: ["A", "B"],
    });
    expect(addAscDevices.mock.calls[0]![0].devices).toEqual([
      { udid: PHONE, name: "A" },
      { udid: OTHER_PHONE, name: "B" },
    ]);
    expect(allLogged("info")).toContain(
      `--udid ${PHONE} --udid ${OTHER_PHONE}`,
    );

    addAscDevices.mockClear();
    addAscDevices.mockResolvedValue([]);
    await handleNativeBuildDevicesAdd({
      udid: [PHONE, PHONE.toLowerCase(), OTHER_PHONE],
      name: ["Same"],
    });
    expect(addAscDevices.mock.calls[0]![0].devices).toEqual([
      { udid: PHONE, name: "Same" },
      { udid: OTHER_PHONE, name: "Same" },
    ]);
  });

  it("refuses a malformed UDID before reaching Apple, and before spending a slot", async () => {
    await expectExit(() =>
      handleNativeBuildDevicesAdd({ udid: ["not-a-udid"], name: ["Kim"] }),
    );

    expect(allLogged("error")).toBe(
      "not-a-udid isn't an iPhone's UDID.\nCopy it from the page \"Check this iPhone\" opens on the build's Console page.",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(addAscDevices).not.toHaveBeenCalled();
  });

  it("refuses --name that doesn't pair up with --udid", async () => {
    await expectExit(() =>
      handleNativeBuildDevicesAdd({
        udid: [PHONE, OTHER_PHONE],
        name: ["A", "B", "C"],
      }),
    );
    expect(allLogged("error")).toContain("don't pair up");
    expect(addAscDevices).not.toHaveBeenCalled();
  });

  it("fails on a permission refusal, with its one next step, and no rebuild step", async () => {
    addAscDevices.mockRejectedValue(
      new Error(
        "App Store Connect doesn't let this API key register devices.\nUse a key with the Admin role: npx hot-updater apple login",
      ),
    );

    await expectExit(() =>
      handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["Kim"] }),
    );

    expect(allLogged("error")).toContain("Admin role");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("fails on the yearly limit, sends people to TestFlight, and offers no rebuild", async () => {
    addAscDevices.mockResolvedValue([
      {
        udid: PHONE,
        outcome: "refused",
        reason:
          "You have reached the maximum number of registered iPhone devices.",
        limitReached: true,
      },
    ]);

    await handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["Kim"] });

    expect(allLogged("error")).toBe(
      `Apple refused ${PHONE}: You have reached the maximum number of registered iPhone devices.\nTestFlight has no such limit: npx hot-updater testflight`,
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("fails when any device didn't make it, and rebuilds only for those that did", async () => {
    addAscDevices.mockResolvedValue([
      { udid: PHONE, outcome: "registered", device: device(PHONE) },
      { udid: OTHER_PHONE, outcome: "disabled", device: device(OTHER_PHONE) },
    ]);

    await handleNativeBuildDevicesAdd({
      udid: [PHONE, OTHER_PHONE],
      name: ["A"],
    });

    expect(allLogged("error")).toContain("disabled");
    expect(allLogged("info")).toContain(`--udid ${PHONE}`);
    expect(allLogged("info")).not.toContain(OTHER_PHONE);
    expect(process.exitCode).toBe(1);
  });

  it("uses the only device scheme without --scheme, and asks when there are several", async () => {
    addAscDevices.mockResolvedValue([
      { udid: PHONE, outcome: "registered", device: device(PHONE) },
    ]);
    await handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["A"] });
    expect(allLogged("info")).toContain("--scheme sandbox");

    loadConfig.mockResolvedValue({
      nativeBuild: {
        ios: {
          a: { bundleIdentifier: "com.example.app" },
          b: { bundleIdentifier: "com.example.app" },
        },
      },
    });
    log.error.mockClear();
    await expectExit(() =>
      handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["A"] }),
    );
    expect(allLogged("error")).toBe(
      "Several nativeBuild.ios schemes build for a device: a, b.\nPick one with --scheme.",
    );
  });

  it("refuses a scheme the config doesn't have", async () => {
    await expectExit(() =>
      handleNativeBuildDevicesAdd({
        scheme: "nope",
        udid: [PHONE],
        name: ["A"],
      }),
    );
    expect(allLogged("error")).toBe(
      "hot-updater.config.ts has no nativeBuild.ios scheme nope.\nPick one: sandbox, sim",
    );
  });

  it("never issues a key: a missing one fails with the resolver's own message", async () => {
    resolve.mockRejectedValue(
      new Error("No asc-api-key secret. Run apple login."),
    );

    await expectExit(() =>
      handleNativeBuildDevicesAdd({ udid: [PHONE], name: ["A"] }),
    );

    expect(allLogged("error")).toContain("apple login");
    expect(addAscDevices).not.toHaveBeenCalled();
  });
});

describe("native-build devices list", () => {
  it("shows what App Store Connect has, read through the scheme's key", async () => {
    listAscDevices.mockResolvedValue([device(PHONE, "Kim's iPhone")]);

    await handleNativeBuildDevicesList({ scheme: "sandbox" });

    expect(listAscDevices).toHaveBeenCalledWith({ apiKey: API_KEY });
    const table = allLogged("message");
    expect(table).toContain("Kim's iPhone");
    expect(table).toContain(PHONE);
    expect(table).toContain("ENABLED");
  });

  it("gives an empty account its next step", async () => {
    listAscDevices.mockResolvedValue([]);

    await handleNativeBuildDevicesList({ scheme: "sandbox" });

    expect(allLogged("info")).toContain(
      "native-build devices add --scheme sandbox",
    );
    expect(log.message).not.toHaveBeenCalled();
  });

  it("fails with the API's message", async () => {
    listAscDevices.mockRejectedValue(
      new Error("App Store Connect refused the API key."),
    );

    await expectExit(() => handleNativeBuildDevicesList({}));

    expect(allLogged("error")).toContain("refused the API key");
  });
});
