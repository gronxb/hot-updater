import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  loadConfig,
  p,
  readLocalKey,
  resolveSecretsAdapter,
  secret,
  writeLocalKey,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter, SigningConfig } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateBundleSigningKey } from "../utils/signing/bundleSigningKey";
import { handleSigningKeyIssue } from "./signingKey";

const { log } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

// Only the config, the prompts, and the key's size are stood in for.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { isCancel: vi.fn(() => false), log },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/native/githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));
vi.mock("../utils/signing/bundleSigningKey", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/signing/bundleSigningKey")>();
  return {
    ...original,
    generateBundleSigningKey: vi.fn(original.generateBundleSigningKey),
  };
});

const NAME = "bundle-signing-key";

/** A 2048-bit key, faster to make than the 4096 bits the command makes. */
const createPem = () =>
  crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

/** `sha256:<hex>` of the key's SPKI DER, computed here, not by the CLI. */
const fingerprintOf = (pem: string) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(crypto.createPublicKey(pem).export({ type: "spki", format: "der" }))
    .digest("hex")}`;

let directory: string;

const configure = ({
  secrets,
  signing,
}: { secrets?: SecretsAdapter; signing?: SigningConfig } = {}) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: resolveSecretsAdapter(secrets),
    signing,
  } as never);
};

const writeConfig = (signing?: string) =>
  fs.writeFile(
    path.join(directory, "hot-updater.config.ts"),
    [
      'import { defineConfig } from "hot-updater";',
      "",
      "export default defineConfig({",
      '  updateStrategy: "appVersion",',
      ...(signing ? [`  signing: ${signing},`] : []),
      "});",
      "",
    ].join("\n"),
  );

const readConfig = () =>
  fs.readFile(path.join(directory, "hot-updater.config.ts"), "utf8");

/** A writable team store, recording each call. */
const teamStore = (values: Record<string, string> = {}) => {
  const held = new Map(Object.entries(values));
  const store = {
    name: "spec-store",
    describe: (name: string) => `spec://${name}`,
    get: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, held.get(name)])),
    ),
    set: vi.fn(async (name: string, value: string) => {
      held.set(name, value);
    }),
  } satisfies SecretsAdapter;
  return { store, held };
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

/** Everything the log printed, without colors, as one text. */
const printed = () =>
  stripVTControlCharacters(
    Object.values(log)
      .flatMap((fn) => fn.mock.calls.flat())
      .map(String)
      .join("\n"),
  );

const logged = (level: keyof typeof log) =>
  stripVTControlCharacters(log[level].mock.calls.flat().map(String).join("\n"));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  vi.stubEnv("HOT_UPDATER_BUNDLE_SIGNING_KEY", "");
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-signing-key-"),
  );
  vi.stubEnv("HOT_UPDATER_HOME", path.join(directory, "home"));
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.mocked(generateBundleSigningKey).mockImplementation(async () =>
    createPem(),
  );
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets issue bundle-signing-key", () => {
  it("creates an RSA key of 4096 bits as PKCS#8", async () => {
    vi.mocked(generateBundleSigningKey).mockRestore();
    const pem = await generateBundleSigningKey();
    const key = crypto.createPrivateKey(pem);

    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(4096);
  });

  it("stores the key in localSecrets()' store, prints its fingerprint, and sets signing in the config", async () => {
    configure();
    await writeConfig();

    await withTTY(true, () => handleSigningKeyIssue());

    expect(process.exitCode).toBeUndefined();
    const stored = (await readLocalKey(NAME, directory))!;
    expect(stored).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
    const lines = logged("success").split("\n");
    expect(lines[0]).toBe("Bundle signing key created");
    // A fingerprint too long for its label's line takes the next one.
    expect(lines.slice(1, 3)).toEqual(["Public key", fingerprintOf(stored)]);
    expect(lines.at(-1)).toBe(
      'Config      signing: secret("bundle-signing-key")',
    );
    expect(await readConfig()).toBe(
      [
        'import { defineConfig, secret } from "hot-updater";',
        "",
        "export default defineConfig({",
        '  updateStrategy: "appVersion",',
        '  signing: secret("bundle-signing-key"),',
        "});",
        "",
      ].join("\n"),
    );
    expect(logged("info")).toBe(
      "Embed its public key, then rebuild: npx hot-updater keys export-public",
    );
    expect(printed()).not.toContain(stored.split("\n")[1]!);
  });

  it("leaves a config that signs with a file as it is, naming the line to set", async () => {
    configure({
      signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" },
    });
    await writeConfig(
      '{ enabled: true, privateKeyPath: "./keys/private-key.pem" }',
    );
    const before = await readConfig();

    await withTTY(true, () => handleSigningKeyIssue());

    expect(await readConfig()).toBe(before);
    expect(logged("success").split("\n").at(-1)).toBe(
      'Config      set signing: secret("bundle-signing-key")',
    );
  });

  it("keeps a stored key without --replace, saying why in one line", async () => {
    const existing = createPem();
    const { store } = teamStore({ [NAME]: existing });
    configure({ secrets: store });

    await withTTY(true, () => handleSigningKeyIssue());

    expect(process.exitCode).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
    expect(generateBundleSigningKey).not.toHaveBeenCalled();
    expect(logged("step").split("\n")).toEqual([
      "Bundle signing key already stored",
      "Public key",
      fingerprintOf(existing),
      "Source      spec://bundle-signing-key",
      "Kept: apps already shipped reject bundles signed with a new key.",
    ]);
    expect(printed()).not.toContain(existing.split("\n")[1]!);
  });

  it("--replace overwrites it, naming the old key, which shipped apps embed", async () => {
    const existing = createPem();
    const { store, held } = teamStore({ [NAME]: existing });
    configure({ secrets: store, signing: secret(NAME) });

    await withTTY(true, () => handleSigningKeyIssue(NAME, { replace: true }));

    expect(process.exitCode).toBeUndefined();
    const replaced = held.get(NAME)!;
    expect(replaced).not.toBe(existing);
    expect(logged("success")).toContain(
      `Public key\n${fingerprintOf(replaced)}`,
    );
    expect(logged("warn").split("\n")).toEqual([
      "The old bundle signing key was replaced",
      "Public key",
      fingerprintOf(existing),
      "Apps that embed it reject bundles signed with the new key.",
    ]);
  });

  it("keeps a key the environment sets, and --replace refuses until it is unset", async () => {
    vi.stubEnv("HOT_UPDATER_BUNDLE_SIGNING_KEY", createPem());
    configure();

    await withTTY(true, () => handleSigningKeyIssue());
    expect(logged("step").split("\n")).toEqual([
      "Bundle signing key set by the environment",
      "Source  HOT_UPDATER_BUNDLE_SIGNING_KEY",
    ]);

    await withTTY(true, () => handleSigningKeyIssue(NAME, { replace: true }));
    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      "The environment or .env.hotupdater overrides bundle-signing-key.\nUnset HOT_UPDATER_BUNDLE_SIGNING_KEY.",
    );
    expect(generateBundleSigningKey).not.toHaveBeenCalled();
  });

  it("creates nothing without a terminal when only this machine would keep it", async () => {
    configure();

    await withTTY(false, () => handleSigningKeyIssue());

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      "Can't create a bundle signing key without a terminal.\nRun in a terminal: npx hot-updater secrets issue bundle-signing-key",
    );
    expect(await readLocalKey(NAME, directory)).toBeUndefined();
  });

  it("creates one without a terminal in a team store, which keeps it", async () => {
    const { store, held } = teamStore();
    configure({ secrets: store });

    await withTTY(false, () => handleSigningKeyIssue());

    expect(process.exitCode).toBeUndefined();
    expect(held.get(NAME)).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
  });

  it("reads a key stored as another name, issued under it", async () => {
    await writeLocalKey("release-signing-key", createPem(), directory);
    configure({ signing: secret("release-signing-key") });

    await withTTY(true, () => handleSigningKeyIssue("release-signing-key"));

    expect(logged("step").split("\n")[0]).toBe(
      "Bundle signing key already stored",
    );
    expect(logged("step")).toContain("Name        release-signing-key");
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
