import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  localSecrets,
  p,
  prepareBundleSigning,
  secret,
} from "@hot-updater/cli-tools";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportSigningRefusal } from "./signingRefusal";

/**
 * What a deploy prints when this machine lacks the signing key, which the
 * E2E harness's `refusedForMissingSigningSecret` reads from this file too:
 * a change here fails this spec, and the E2E spec once the file is updated.
 */
const FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../../../e2e/shared/control-server/__fixtures__/missing-signing-secret-refusal.txt",
);

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-refusal-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(cwd, "home"));
  vi.stubEnv("HOT_UPDATER_BUNDLE_SIGNING_KEY", "");
  vi.spyOn(p.log, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("reportSigningRefusal", () => {
  it("prints a missing signing key's command on a line of its own, then blocks", async () => {
    const error = await prepareBundleSigning(secret("bundle-signing-key"), {
      cwd,
      secrets: localSecrets(),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);

    reportSigningRefusal(error);

    const lines = renderClackLog(recordedClackCalls(p.log));
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(FIXTURE);
    expect(lines.slice(1, 4)).toEqual([
      "■  bundle-signing-key isn't on this machine.",
      "│  Check the name, set HOT_UPDATER_BUNDLE_SIGNING_KEY, or import your key:",
      "│  npx hot-updater secrets put bundle-signing-key <key.pem>",
    ]);
    expect(linesWiderThan(lines)).toEqual([]);
  });
});
