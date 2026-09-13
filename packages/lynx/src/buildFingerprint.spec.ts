import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLynxNativeFingerprint } from "./buildFingerprint";

describe("Lynx native fingerprint", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-fingerprint-"));
    await fs.mkdir(path.join(cwd, "ios"));
    await fs.mkdir(path.join(cwd, "android"));
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 1.0");
    await fs.writeFile(
      path.join(cwd, "android", "build.gradle.kts"),
      "lynx=1.0",
    );
    await fs.writeFile(
      path.join(cwd, "package.json"),
      '{"dependencies":{"@lynx-js/react":"1.0.0"}}',
    );
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("changes when the selected platform native inputs change", async () => {
    const before = await createLynxNativeFingerprint(cwd, { platform: "ios" });
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 2.0");
    const after = await createLynxNativeFingerprint(cwd, { platform: "ios" });
    expect(after.hash).not.toBe(before.hash);
  });

  it("does not include the other platform or generated dependency trees", async () => {
    const before = await createLynxNativeFingerprint(cwd, {
      platform: "android",
    });
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 2.0");
    await fs.mkdir(path.join(cwd, "android", "build"));
    await fs.writeFile(path.join(cwd, "android", "build", "output"), "new");
    const after = await createLynxNativeFingerprint(cwd, {
      platform: "android",
    });
    expect(after.hash).toBe(before.hash);
  });

  it("includes integration-configured native sources", async () => {
    const source = path.join(cwd, "native-profile.txt");
    await fs.writeFile(source, "profile-a");
    const before = await createLynxNativeFingerprint(cwd, {
      platform: "ios",
      extraSources: ["native-profile.txt"],
    });
    await fs.writeFile(source, "profile-b");
    const after = await createLynxNativeFingerprint(cwd, {
      platform: "ios",
      extraSources: ["native-profile.txt"],
    });
    expect(after.hash).not.toBe(before.hash);
  });

  it("uses locale-independent Unicode source ordering", async () => {
    await Promise.all([
      fs.writeFile(path.join(cwd, "ios/Z.swift"), "upper"),
      fs.writeFile(path.join(cwd, "ios/ä.swift"), "non-ascii"),
    ]);

    const fingerprint = await createLynxNativeFingerprint(cwd, {
      platform: "ios",
    });

    expect(
      fingerprint.sources.map((source) =>
        "filePath" in source ? source.filePath : source.id,
      ),
    ).toEqual([
      "ios/Podfile.lock",
      "ios/Z.swift",
      "ios/ä.swift",
      "package.json",
    ]);
  });
});
