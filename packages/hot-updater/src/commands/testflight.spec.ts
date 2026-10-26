import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, select, isCancel, buildIosNative } = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn() },
  select: vi.fn(),
  isCancel: vi.fn((_answer: unknown) => false),
  buildIosNative: vi.fn(async () => ({})),
}));

// The config, the prompt, and build:ios's handler are stood in for; which
// scheme TestFlight takes is apple-helper's own check, unmocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { log, select, isCancel },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("./buildNative", () => ({ buildIosNative }));

import { loadConfig } from "@hot-updater/cli-tools";

import { handleTestFlight } from "./testflight";

const DEVICE = {
  bundleIdentifier: "com.example.app",
  scheme: "App",
  signing: { ascApiKey: "secret:asc-api-key" },
};
const SIMULATOR = { ...DEVICE, simulator: true };
const DEBUG = { ...DEVICE, configuration: "Debug" };

const configure = (ios: Record<string, unknown>) => {
  vi.mocked(loadConfig).mockResolvedValue({
    nativeBuild: { ios, android: {} },
  } as never);
};

const withTTY = async <T>(isTTY: boolean, run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

/** What build:ios's handler is called with: the build:ios options. */
const built = () => buildIosNative.mock.calls.map(([options]) => options);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe("hot-updater testflight", () => {
  it("runs build:ios's handler with --upload testflight --register for the scheme given, without reading the config", async () => {
    await withTTY(false, () => handleTestFlight({ scheme: "release" }));

    expect(loadConfig).not.toHaveBeenCalled();
    expect(built()).toEqual([
      {
        scheme: "release",
        interactive: false,
        upload: "testflight",
        register: true,
      },
    ]);
  });

  it("--no-register uploads without registering, and passes --json and --output-path on", async () => {
    await handleTestFlight({
      scheme: "release",
      register: false,
      json: true,
      outputPath: "out",
    });

    expect(built()).toEqual([
      {
        scheme: "release",
        interactive: false,
        upload: "testflight",
        register: false,
        json: true,
        outputPath: "out",
      },
    ]);
  });

  it("uses the only scheme TestFlight takes, skipping simulator and Debug ones, and says which", async () => {
    configure({ release: DEVICE, simulator: SIMULATOR, debug: DEBUG });

    await withTTY(false, () => handleTestFlight({}));

    expect(process.exitCode).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "Scheme release: the only nativeBuild.ios scheme that uploads to TestFlight.",
    );
    expect(built()).toEqual([
      expect.objectContaining({
        scheme: "release",
        upload: "testflight",
        register: true,
      }),
    ]);
  });

  it("asks which scheme at a terminal when several upload to TestFlight", async () => {
    configure({ staging: DEVICE, release: DEVICE, simulator: SIMULATOR });
    select.mockResolvedValueOnce("staging");

    await withTTY(true, () => handleTestFlight({}));

    expect(select).toHaveBeenCalledWith({
      message: "Which scheme do you upload to TestFlight?",
      options: [
        { value: "release", label: "release" },
        { value: "staging", label: "staging" },
      ],
    });
    expect(built()).toEqual([
      expect.objectContaining({ scheme: "staging", upload: "testflight" }),
    ]);
  });

  it.each([
    ["without a terminal", false, "", "never without a terminal"],
    ["in CI, even at a terminal", true, "true", "never in CI (CI is set)"],
  ])(
    "refuses several schemes %s, listing them and the --scheme form",
    async (_case, isTTY, ci, reason) => {
      vi.stubEnv("CI", ci);
      configure({ staging: DEVICE, release: DEVICE });

      await withTTY(isTTY, () => handleTestFlight({}));

      expect(process.exitCode).toBe(1);
      expect(select).not.toHaveBeenCalled();
      expect(buildIosNative).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        `Several nativeBuild.ios schemes upload to TestFlight: release, staging. Hot Updater asks which one only at a terminal, ${reason}: run npx hot-updater testflight --scheme <release | staging>.`,
      );
    },
  );

  it("refuses when no scheme uploads to TestFlight, saying why each does not and how to add one", async () => {
    configure({ simulator: SIMULATOR, debug: DEBUG });

    await withTTY(true, () => handleTestFlight({}));

    expect(process.exitCode).toBe(1);
    expect(buildIosNative).not.toHaveBeenCalled();
    const [message] = log.error.mock.calls[0]!;
    expect(message).toContain(
      "No nativeBuild.ios scheme in hot-updater.config.ts uploads to TestFlight.",
    );
    expect(message).toContain(
      "TestFlight takes an .ipa, and the scheme simulator builds a simulator .app.",
    );
    expect(message).toContain(
      "the scheme debug builds the Debug configuration",
    );
    expect(message).toContain(
      "https://hot-updater.dev/docs/guides/native-build#upload-to-testflight",
    );
  });

  it("refuses a config without iOS schemes", async () => {
    configure({});

    await withTTY(true, () => handleTestFlight({}));

    expect(process.exitCode).toBe(1);
    expect(buildIosNative).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Add a device scheme with signing.ascApiKey"),
    );
  });

  it("builds nothing when the scheme prompt is cancelled", async () => {
    configure({ staging: DEVICE, release: DEVICE });
    const cancel = Symbol("cancel");
    select.mockResolvedValueOnce(cancel);
    isCancel.mockImplementationOnce((answer) => answer === cancel);

    await withTTY(true, () => handleTestFlight({}));

    expect(process.exitCode).toBe(1);
    expect(buildIosNative).not.toHaveBeenCalled();
  });
});
