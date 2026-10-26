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
const UNAVAILABLE =
  "asc-api-key is not in the default secrets adapter (HOT_UPDATER_ASC_API_KEY in the environment, or /home/dev/.hot-updater/keys/app-0123456789ab/asc-api-key.json on this machine).";
const describeUnavailable = vi.fn(async () => UNAVAILABLE);
const SIGN_IN = {
  account: "Apple Account",
  kind: "asc-api-key",
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
      "Continue? Re-run with -y in a non-interactive shell.",
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
      `${UNAVAILABLE} Hot Updater signs in to your Apple Account to issue it only at a terminal, never in CI (CI is set). Or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key from the environment.`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("never signs in without a terminal", async () => {
    setTTY(false);
    vi.stubEnv("CI", "");

    await expect(
      canSignIn({
        account: "Google Account",
        kind: "play-service-account",
        describeUnavailable: async () => "widget-play is missing.",
      }),
    ).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "widget-play is missing. Hot Updater signs in to your Google Account to issue it only at a terminal, never without a terminal. Or set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide play-service-account from the environment.",
    );
  });
});
