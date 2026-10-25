import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, ensurePlayServiceAccount } = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn(), message: vi.fn(), warn: vi.fn() },
  ensurePlayServiceAccount: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { isCancel: vi.fn(() => false), log },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/native/playServiceAccount", () => ({
  ensurePlayServiceAccount,
}));

import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { handleSecretsPut } from "./secrets";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("hot-updater secrets put --kind play-service-account without a key file", () => {
  it("signs in with Google and stores the issued key in the vault, whatever the environment overrides", async () => {
    ensurePlayServiceAccount.mockResolvedValueOnce({
      status: "issued",
      email: "hot-updater-play@my-app.iam.gserviceaccount.com",
      version: 1,
    });

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
      variables: [],
    });

    expect(ensurePlayServiceAccount).toHaveBeenCalledWith({
      name: "play-service-account",
      environment: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("says the vault has the key already", async () => {
    ensurePlayServiceAccount.mockResolvedValueOnce({
      status: "stored",
      version: 2,
    });

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
    });

    const [message] = log.message.mock.calls.map(([text]) =>
      stripVTControlCharacters(String(text)),
    );
    expect(message).toContain("Play service account already stored");
    expect(message).toContain("v2");
  });

  it("leaves a refusal canSignIn reported as it is", async () => {
    ensurePlayServiceAccount.mockRejectedValueOnce(
      new CredentialSetupRefusedError("no terminal"),
    );

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
    });

    expect(log.error).not.toHaveBeenCalled();
  });

  it("reports why the key could not be issued", async () => {
    ensurePlayServiceAccount.mockRejectedValueOnce(
      new Error("Google Play has no app com.example.app."),
    );

    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
    });

    expect(log.error).toHaveBeenCalledWith(
      "Google Play has no app com.example.app.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("does not sign in when another kind's options are given", async () => {
    await handleSecretsPut("play-service-account", {
      kind: "play-service-account",
      p8: "AuthKey.p8",
    });

    expect(ensurePlayServiceAccount).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
