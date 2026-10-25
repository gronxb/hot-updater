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

const SIGN_IN = {
  account: "Apple Account",
  kind: "asc-api-key",
  name: "asc-api-key",
  vaultUrl: "https://console.example.com",
  setupCommand: "npx hot-updater secrets put asc-api-key --kind asc-api-key",
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
      "Continue? Re-run with -y in a non-interactive shell.",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("canSignIn", () => {
  it("lets a developer at a terminal sign in", () => {
    setTTY(true);
    vi.stubEnv("CI", "");

    expect(canSignIn(SIGN_IN)).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("never signs in in CI, even on a terminal the runner allocates", () => {
    setTTY(true);
    vi.stubEnv("CI", "true");

    expect(canSignIn(SIGN_IN)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "asc-api-key is not in the vault at https://console.example.com, and Hot Updater signs in to your Apple Account only at a terminal, never in CI (CI is set). Run `npx hot-updater secrets put asc-api-key --kind asc-api-key` once on a machine where you can sign in, and builds here read the stored asc-api-key, or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide it without the vault.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("never signs in without a terminal, naming the item and its kind", () => {
    setTTY(false);
    vi.stubEnv("CI", "");

    expect(
      canSignIn({
        account: "Google Account",
        kind: "play-service-account",
        name: "widget-play",
        vaultUrl: "https://console.example.com",
        setupCommand:
          "npx hot-updater secrets put widget-play --kind play-service-account",
      }),
    ).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "widget-play (play-service-account) is not in the vault at https://console.example.com, and Hot Updater signs in to your Google Account only at a terminal, never without a terminal. Run `npx hot-updater secrets put widget-play --kind play-service-account` once on a machine where you can sign in, and builds here read the stored play-service-account, or set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide it without the vault.",
    );
  });
});
