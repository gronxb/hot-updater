import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canPrompt, canSignIn } from "./prompt";

const { log } = vi.hoisted(() => ({ log: { error: vi.fn() } }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log },
}));

const isTTY = process.stdin.isTTY;
const setTTY = (value: boolean) => {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
};

/** What the preflight says of a missing key, as the caller passes it. */
const UNAVAILABLE = {
  missing: "asc-api-key is not in the localSecrets secrets adapter.",
  fix: "Run once in a terminal: npx hot-updater apple login",
};
const describeUnavailable = vi.fn(async () => UNAVAILABLE);
const SIGN_IN = {
  account: "Apple Account",
  describeUnavailable,
} as const;

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  setTTY(isTTY);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("canPrompt", () => {
  it("asks on a terminal outside CI", () => {
    setTTY(true);
    vi.stubEnv("CI", "");

    expect(canPrompt("Continue?")).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("refuses in CI even on a terminal, naming the option to pass", () => {
    setTTY(true);
    vi.stubEnv("CI", "true");

    expect(canPrompt("Continue?")).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "Continue?\nRe-run with -y in a non-interactive shell.",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("canSignIn", () => {
  it("lets a developer at a terminal sign in, describing nothing", async () => {
    setTTY(true);
    vi.stubEnv("CI", "");

    await expect(canSignIn(SIGN_IN)).resolves.toBe(true);
    expect(describeUnavailable).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("never signs in in CI, even on a terminal the runner allocates", async () => {
    setTTY(true);
    vi.stubEnv("CI", "true");

    await expect(canSignIn(SIGN_IN)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      [
        "asc-api-key is not in the localSecrets secrets adapter.",
        "Can't sign in to your Apple Account in CI (CI is set).",
        "Run once in a terminal: npx hot-updater apple login",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("never signs in without a terminal", async () => {
    setTTY(false);
    vi.stubEnv("CI", "");

    await expect(
      canSignIn({
        account: "Apple Account",
        describeUnavailable: async () => ({
          missing: "widget-asc is missing.",
          fix: "Run once in a terminal: npx hot-updater apple login",
        }),
      }),
    ).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      [
        "widget-asc is missing.",
        "Can't sign in to your Apple Account without a terminal.",
        "Run once in a terminal: npx hot-updater apple login",
      ].join("\n"),
    );
  });
});
