import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AndroidConfigParser } from "../../packages/hot-updater/src/utils/configParser/androidParser.ts";
import { IosConfigParser } from "../../packages/hot-updater/src/utils/configParser/iosParser.ts";

type IntegrityModule =
  typeof import("../../examples/lynx/scripts/native-public-key-integrity.mjs");

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const helperUrl = pathToFileURL(
  path.join(repoDir, "examples/lynx/scripts/native-public-key-integrity.mjs"),
).href;
const publicKey = crypto
  .generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  .publicKey.trim();
const otherPublicKey = crypto
  .generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  .publicKey.trim();
const weakPublicKey = crypto
  .generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  .publicKey.trim();
const ecPublicKey = crypto
  .generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  .publicKey.trim();
const pkcs1PublicKey = crypto
  .createPublicKey(publicKey)
  .export({ format: "pem", type: "pkcs1" })
  .toString()
  .trim();

let integrity: IntegrityModule;
const temporaryRepos: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeHeadFile(targetRepo: string, relativePath: string) {
  const bytes = execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repoDir,
  });
  const target = path.join(targetRepo, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function createFixture() {
  const targetRepo = fs.mkdtempSync(
    path.join(os.tmpdir(), "lynx-native-public-key-"),
  );
  temporaryRepos.push(targetRepo);
  for (const relativePath of Object.values(
    integrity.nativePublicKeyPaths,
  ).flat()) {
    writeHeadFile(targetRepo, relativePath);
  }
  fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "unchanged\n");
  git(targetRepo, ["init", "--quiet"]);
  git(targetRepo, ["config", "user.email", "lynx-e2e@example.invalid"]);
  git(targetRepo, ["config", "user.name", "Lynx E2E"]);
  git(targetRepo, ["add", "."]);
  git(targetRepo, ["commit", "--quiet", "-m", "fixture"]);
  return { checkedCommit: git(targetRepo, ["rev-parse", "HEAD"]), targetRepo };
}

function configureCrlfTextFilter(targetRepo: string) {
  fs.writeFileSync(
    path.join(targetRepo, ".gitattributes"),
    "tracked.txt text eol=crlf\n",
  );
  git(targetRepo, ["add", ".gitattributes"]);
  git(targetRepo, ["commit", "--quiet", "-m", "configure CRLF"]);
  fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "unchanged\r\n");
  git(targetRepo, ["add", "tracked.txt"]);
  return git(targetRepo, ["rev-parse", "HEAD"]);
}

async function applyWorkerPublicKeyTransform(
  targetRepo: string,
  value = publicKey,
) {
  await new AndroidConfigParser(
    integrity.nativePublicKeyPaths.android.map((relativePath) =>
      path.join(targetRepo, relativePath),
    ),
  ).set("hot_updater_public_key", value);
  await new IosConfigParser(
    integrity.nativePublicKeyPaths.ios.map((relativePath) =>
      path.join(targetRepo, relativePath),
    ),
  ).set("HOT_UPDATER_PUBLIC_KEY", value);
}

beforeAll(async () => {
  integrity = await import(helperUrl);
});

afterEach(() => {
  for (const targetRepo of temporaryRepos.splice(0)) {
    fs.rmSync(targetRepo, { force: true, recursive: true });
  }
});

describe("native public-key source integrity", () => {
  it("accepts all five files produced by the real CLI parsers and records their key identity", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);

    const result = integrity.assertNativePublicKeyOnlySourceChanges(
      targetRepo,
      checkedCommit,
    );
    const expectedSpkiSha256 = crypto
      .createHash("sha256")
      .update(
        crypto
          .createPublicKey(publicKey)
          .export({ format: "der", type: "spki" }),
      )
      .digest("hex");

    expect(result).toMatchObject({
      clean: true,
      trackedChanges: [],
      allowedTrackedChanges: [],
      nativePublicKeyInjection: {
        schemaVersion: 1,
        provenance: "post-fingerprint-trust-anchor-injection",
        runtimeFingerprintRecalculated: false,
        algorithm: "rsa-spki",
        modulusLength: 2048,
        spkiSha256: expectedSpkiSha256,
      },
    });
    expect(result.nativePublicKeyInjection?.files).toEqual(
      Object.fromEntries(
        Object.values(integrity.nativePublicKeyPaths)
          .flat()
          .map((relativePath) => [
            relativePath,
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(targetRepo, relativePath)))
              .digest("hex"),
          ]),
      ),
    );
  });

  it("accepts a source tree where none of the native key files changed", () => {
    const { checkedCommit, targetRepo } = createFixture();

    const result = integrity.assertNativePublicKeyOnlySourceChanges(
      targetRepo,
      checkedCommit,
    );
    expect(result).toMatchObject({
      clean: true,
      trackedChanges: [],
      allowedTrackedChanges: [],
    });
    expect(result.trackedTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("nativePublicKeyInjection");
  });

  it("accepts a clean path-aware CRLF smudge", () => {
    const { targetRepo } = createFixture();
    const checkedCommit = configureCrlfTextFilter(targetRepo);
    const headObject = git(targetRepo, [
      "rev-parse",
      `${checkedCommit}:tracked.txt`,
    ]);
    const rawObject = git(targetRepo, [
      "hash-object",
      "--no-filters",
      "tracked.txt",
    ]);
    const cleanObject = git(targetRepo, [
      "hash-object",
      "--path=tracked.txt",
      "tracked.txt",
    ]);

    expect(rawObject).not.toBe(headObject);
    expect(cleanObject).toBe(headObject);
    expect(
      git(targetRepo, ["status", "--porcelain", "--", "tracked.txt"]),
    ).toBe("");
    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).not.toThrow();
  });

  it("rejects a semantic edit hidden behind a CRLF filter and index flag", () => {
    const { targetRepo } = createFixture();
    const checkedCommit = configureCrlfTextFilter(targetRepo);
    git(targetRepo, ["update-index", "--assume-unchanged", "tracked.txt"]);
    fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "changed\r\n");

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("tracked.txt");
  });

  it("rejects an info-attributes clean filter that masks malicious bytes", () => {
    const { checkedCommit, targetRepo } = createFixture();
    fs.writeFileSync(
      path.join(targetRepo, ".git/info/attributes"),
      "tracked.txt filter=mask\n",
    );
    git(targetRepo, [
      "config",
      "filter.mask.clean",
      "sed s/malicious/unchanged/g",
    ]);
    fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "malicious\n");
    const headObject = git(targetRepo, [
      "rev-parse",
      `${checkedCommit}:tracked.txt`,
    ]);
    const maskedObject = git(targetRepo, [
      "hash-object",
      "--path=tracked.txt",
      "tracked.txt",
    ]);

    expect(maskedObject).toBe(headObject);
    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("uses a Git filter attribute: tracked.txt");
  });

  it("rejects a filter driver named unspecified before its masked hash is trusted", () => {
    const { checkedCommit, targetRepo } = createFixture();
    fs.writeFileSync(
      path.join(targetRepo, ".git/info/attributes"),
      "tracked.txt filter=unspecified\n",
    );
    git(targetRepo, [
      "config",
      "filter.unspecified.clean",
      "sed s/malicious/unchanged/g",
    ]);
    fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "malicious\n");
    const headObject = git(targetRepo, [
      "rev-parse",
      `${checkedCommit}:tracked.txt`,
    ]);
    const maskedObject = git(targetRepo, [
      "hash-object",
      "--path=tracked.txt",
      "tracked.txt",
    ]);

    expect(git(targetRepo, ["check-attr", "filter", "--", "tracked.txt"])).toBe(
      "tracked.txt: filter: unspecified",
    );
    expect(maskedObject).toBe(headObject);
    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("filter driver name 'unspecified' is reserved");
  });

  it("rejects an inherited filter.unspecified process driver", () => {
    const { checkedCommit, targetRepo } = createFixture();
    const inheritedConfig = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.unspecified.process",
      GIT_CONFIG_VALUE_0: "cat",
    };
    const previous = Object.fromEntries(
      Object.keys(inheritedConfig).map((key) => [key, process.env[key]]),
    );

    Object.assign(process.env, inheritedConfig);
    try {
      expect(() =>
        integrity.assertNativePublicKeyOnlySourceChanges(
          targetRepo,
          checkedCommit,
        ),
      ).toThrow("filter driver name 'unspecified' is reserved");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects tracked changes hidden by %s",
    (flag) => {
      const { checkedCommit, targetRepo } = createFixture();
      git(targetRepo, ["update-index", flag, "tracked.txt"]);
      fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "hidden change\n");

      expect(() =>
        integrity.assertNativePublicKeyOnlySourceChanges(
          targetRepo,
          checkedCommit,
        ),
      ).toThrow("tracked.txt");
    },
  );

  it("rejects a native mode change when core.fileMode is false", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    git(targetRepo, ["config", "core.fileMode", "false"]);
    fs.chmodSync(
      path.join(targetRepo, integrity.nativePublicKeyPaths.android[0]),
      0o755,
    );

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("changed outside the public-key export");
  });

  it("rejects a partial public key hidden by an index flag", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    const manifest = integrity.nativePublicKeyPaths.android[0];
    git(targetRepo, ["update-index", "--assume-unchanged", manifest]);
    await new AndroidConfigParser([path.join(targetRepo, manifest)]).set(
      "hot_updater_public_key",
      publicKey,
    );

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("must update every native configuration");
  });

  it("rejects a clean commit with a partial preexisting public key", async () => {
    const { targetRepo } = createFixture();
    const manifest = integrity.nativePublicKeyPaths.android[0];
    await new AndroidConfigParser([path.join(targetRepo, manifest)]).set(
      "hot_updater_public_key",
      publicKey,
    );
    git(targetRepo, ["add", manifest]);
    git(targetRepo, ["commit", "--quiet", "-m", "partial key"]);
    const checkedCommit = git(targetRepo, ["rev-parse", "HEAD"]);

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("must not contain a public key");
  });

  it("rejects source changes after the pre-build attestation", () => {
    const { checkedCommit, targetRepo } = createFixture();
    const allowedPaths = ["tracked.txt"];
    const before = integrity.assertNativePublicKeyOnlySourceChanges(
      targetRepo,
      checkedCommit,
      allowedPaths,
    );
    fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "changed later\n");

    expect(() =>
      integrity.assertNativePublicKeySourceUnchanged(
        targetRepo,
        checkedCommit,
        allowedPaths,
        before,
      ),
    ).toThrow("changed during the native build");
  });

  it("rejects a partial five-file export", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    const restored = integrity.nativePublicKeyPaths.ios[1];
    fs.writeFileSync(
      path.join(targetRepo, restored),
      execFileSync("git", ["show", `${checkedCommit}:${restored}`], {
        cwd: targetRepo,
      }),
    );

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("must update every native configuration");
  });

  it("rejects mismatched public keys", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    await new AndroidConfigParser([
      path.join(targetRepo, integrity.nativePublicKeyPaths.android[0]),
    ]).set("hot_updater_public_key", otherPublicKey);

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("public-key exports do not match");
  });

  it("rejects a change to another native field", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    await new AndroidConfigParser([
      path.join(targetRepo, integrity.nativePublicKeyPaths.android[0]),
    ]).set("hot_updater_channel", "tampered");

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("changed outside the public-key export");
  });

  it("rejects an extra tracked source edit", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    fs.writeFileSync(path.join(targetRepo, "tracked.txt"), "changed\n");

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("tracked.txt");
  });

  it("rejects a missing public key in a changed native file", async () => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo);
    const manifest = path.join(
      targetRepo,
      integrity.nativePublicKeyPaths.android[0],
    );
    await new AndroidConfigParser([manifest]).remove("hot_updater_public_key");
    await new AndroidConfigParser([manifest]).set(
      "hot_updater_channel",
      "changed",
    );

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow("public key in every native configuration");
  });

  it.each([
    ["malformed", "not-a-public-key", "public key is invalid"],
    ["non-RSA", ecPublicKey, "must be RSA 2048 or stronger"],
    ["weak RSA", weakPublicKey, "must be RSA 2048 or stronger"],
    ["non-SPKI RSA", pkcs1PublicKey, "must be canonical SPKI PEM"],
  ])("rejects a %s public key", async (_case, key, expectedError) => {
    const { checkedCommit, targetRepo } = createFixture();
    await applyWorkerPublicKeyTransform(targetRepo, key);

    expect(() =>
      integrity.assertNativePublicKeyOnlySourceChanges(
        targetRepo,
        checkedCommit,
      ),
    ).toThrow(expectedError);
  });
});
