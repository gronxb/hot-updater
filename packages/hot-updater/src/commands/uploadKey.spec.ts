import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  createCredentialResolver,
  loadConfig,
  p,
  readLocalKey,
  resolveSecretsAdapter,
  writeLocalKey,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  androidKeystoreValue,
  createUploadKeystore,
  findKeytool,
  KeytoolMissingError,
  type RunKeytool,
  verifyKeystore,
} from "../utils/native/androidKeystore";
import { handleSecretsPut } from "./secrets";
import { handleUploadKeyIssue } from "./uploadKey";

const { log, text, select, password } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
}));

// Only the config, the prompts, and keytool are stood in for.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { isCancel: vi.fn(() => false), log, text, select, password },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/native/githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));
vi.mock("../utils/native/androidKeystore", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/native/androidKeystore")>();
  return { ...original, findKeytool: vi.fn(original.findKeytool) };
});

/** A keystore the stand-in keytool knows: its passwords and alias. */
interface FakeKeystore {
  readonly storePassword: string;
  readonly keyPassword: string;
  readonly alias: string;
  readonly certificate: Buffer;
}

/** The keystores the stand-in keytool created or was given, by contents. */
const keystores = new Map<string, FakeKeystore>();
const keytoolCalls: {
  args: string[];
  env: Record<string, string>;
}[] = [];

const passwordFrom = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  flag: string,
) => {
  const index = args.indexOf(`${flag}:env`);
  return index < 0 ? undefined : env[args[index + 1]!];
};

const failed = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });

/**
 * keytool as these specs see it: it creates a keystore of random bytes it
 * remembers, and checks the passwords and alias it is given against it,
 * failing with keytool's own messages.
 */
const fakeKeytool: RunKeytool = async (args, env = {}) => {
  keytoolCalls.push({ args: [...args], env: { ...env } });
  const [command] = args;
  const file = args[args.indexOf("-keystore") + 1]!;
  if (command === "-genkeypair") {
    const contents = crypto.randomBytes(64);
    await fs.writeFile(file, contents);
    keystores.set(contents.toString("base64"), {
      storePassword: passwordFrom(args, env, "-storepass")!,
      keyPassword: passwordFrom(args, env, "-keypass")!,
      alias: args[args.indexOf("-alias") + 1]!,
      certificate: crypto.randomBytes(32),
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const known = keystores.get((await fs.readFile(file)).toString("base64"));
  if (!known)
    return failed(
      "keytool error: java.io.IOException: Invalid keystore format",
    );
  if (command === "-list") {
    return {
      exitCode: 0,
      stdout: `Alias name: ${known.alias}\nEntry type: PrivateKeyEntry\n`,
      stderr: "",
    };
  }
  if (passwordFrom(args, env, "-storepass") !== known.storePassword) {
    return failed(
      "keytool error: java.io.IOException: keystore password was incorrect",
    );
  }
  const alias = args[args.indexOf("-alias") + 1];
  if (alias !== known.alias) {
    return failed(
      `keytool error: java.lang.Exception: Alias <${alias}> does not exist`,
    );
  }
  if (command === "-exportcert") {
    return {
      exitCode: 0,
      stdout: `-----BEGIN CERTIFICATE-----\n${known.certificate.toString("base64")}\n-----END CERTIFICATE-----\n`,
      stderr: "",
    };
  }
  if (command === "-certreq") {
    return passwordFrom(args, env, "-keypass") === known.keyPassword
      ? { exitCode: 0, stdout: "", stderr: "" }
      : failed(
          "keytool error: java.security.UnrecoverableKeyException: Cannot recover key",
        );
  }
  return failed(`keytool error: unknown command ${command}`);
};

/** A keystore you have, as the stand-in keytool knows it. */
const existingKeystore = async ({
  storePassword = "store-secret-1",
  keyPassword = "key-secret-22",
} = {}) => {
  const contents = crypto.randomBytes(64);
  keystores.set(contents.toString("base64"), {
    storePassword,
    keyPassword,
    alias: "eas-upload",
    certificate: crypto.randomBytes(32),
  });
  const file = path.join(directory, "eas.jks");
  await fs.writeFile(file, contents);
  return { file, contents };
};

const ENV_NAMES = [
  "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
  "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
  "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
  "HOT_UPDATER_ANDROID_KEY_ALIAS",
  "HOT_UPDATER_ANDROID_KEY_PASSWORD",
  "HOT_UPDATER_ANDROID_KEYSTORE",
  "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
  "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
  "HOT_UPDATER_PLAY_SERVICE_ACCOUNT",
];

/** Everything the log printed, without colors, as one text. */
const printed = () =>
  stripVTControlCharacters(
    Object.values(log)
      .flatMap((fn) => fn.mock.calls.flat())
      .map(String)
      .join("\n"),
  );

const logged = (level: keyof typeof log) =>
  stripVTControlCharacters(
    level === "error"
      ? String(log.error.mock.calls[0]?.[0])
      : log[level].mock.calls.flat().map(String).join("\n"),
  );

let directory: string;

/** Makes `secrets` and `nativeBuild` the config's, as loadConfig hands them over. */
const configure = (
  secrets?: SecretsAdapter,
  nativeBuild: unknown = {
    android: {
      release: {
        packageName: "com.example.app",
        signing: { keystore: "secret:android-keystore" },
      },
    },
  },
) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: resolveSecretsAdapter(secrets),
    nativeBuild,
  } as never);
};

/** A writable secrets adapter, as AWS's or Google Cloud's is, recording each call. */
const writableStore = (values: Record<string, string> = {}) => {
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
  configure(store);
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

beforeEach(async () => {
  vi.clearAllMocks();
  keystores.clear();
  keytoolCalls.length = 0;
  vi.stubEnv("CI", "");
  for (const name of ENV_NAMES) vi.stubEnv(name, "");
  vi.mocked(findKeytool).mockResolvedValue(fakeKeytool);
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-upload-key-"),
  );
  vi.stubEnv("HOT_UPDATER_HOME", path.join(directory, "home"));
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets issue android-keystore", () => {
  it("creates an RSA 4096 upload key valid 10000 days, passing its random password only through the environment", async () => {
    configure();

    await withTTY(true, () => handleUploadKeyIssue());

    expect(process.exitCode).toBeUndefined();
    const generate = keytoolCalls.find(
      ({ args }) => args[0] === "-genkeypair",
    )!;
    expect(generate.args).toEqual([
      "-genkeypair",
      "-noprompt",
      "-keystore",
      expect.stringMatching(/upload\.keystore$/u),
      "-storetype",
      "PKCS12",
      "-alias",
      "upload",
      "-keyalg",
      "RSA",
      "-keysize",
      "4096",
      "-validity",
      "10000",
      "-dname",
      "CN=com.example.app",
      "-storepass:env",
      "HOT_UPDATER_KEYTOOL_STOREPASS",
      "-keypass:env",
      "HOT_UPDATER_KEYTOOL_STOREPASS",
    ]);
    const secret = generate.env["HOT_UPDATER_KEYTOOL_STOREPASS"]!;
    expect(secret).toMatch(/^[\w-]{32}$/u);
    expect(keytoolCalls.flatMap(({ args }) => args)).not.toContain(secret);
    // The keystore's private directory is gone.
    await expect(fs.stat(path.dirname(generate.args[3]!))).rejects.toThrow();
  });

  it("stores the JSON value builds resolve, in localSecrets()' store, and never prints the password", async () => {
    configure();

    await withTTY(true, () => handleUploadKeyIssue());

    const stored = JSON.parse(
      (await readLocalKey("android-keystore", directory))!,
    );
    expect(Object.keys(stored)).toEqual([
      "keystore",
      "storePassword",
      "keyAlias",
      "keyPassword",
    ]);
    expect(stored.keyAlias).toBe("upload");
    // PKCS12 has one password for the store and its key.
    expect(stored.keyPassword).toBe(stored.storePassword);
    expect(keystores.has(stored.keystore)).toBe(true);
    expect(printed()).not.toContain(stored.storePassword);
    expect(printed()).not.toContain(stored.keystore);

    const { certificate } = keystores.get(stored.keystore)!;
    const sha256 = crypto
      .createHash("sha256")
      .update(certificate)
      .digest("hex")
      .toUpperCase()
      .match(/../gu)!;
    const sha1 = crypto
      .createHash("sha1")
      .update(certificate)
      .digest("hex")
      .toUpperCase()
      .match(/../gu)!
      .join(":");
    const lines = logged("success").split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Upload key created",
      "Alias    upload",
      `SHA-256  ${sha256.slice(0, 16).join(":")}`,
      `         ${sha256.slice(16).join(":")}`,
      `SHA-1    ${sha1}`,
    ]);
    expect(lines[5]).toMatch(/^Source {3}home\/.*android-keystore\.json$/u);
    expect(lines.slice(6)).toEqual([
      "Fits only an app with no .aab on Play yet: Play keeps the first key.",
      "Back up this file: it is your Play upload key.",
      "Play has another upload key? Request a key reset with:",
      "npx hot-updater secrets issue android-keystore --pem upload.pem",
    ]);
  });

  it("stores through a writable adapter, as AWS's or Google Cloud's, and native-build resolves it from there", async () => {
    const { held, store } = writableStore();

    await withTTY(true, () => handleUploadKeyIssue("release-keystore"));

    expect(process.exitCode).toBeUndefined();
    expect(store.set).toHaveBeenCalledTimes(1);
    const value = held.get("release-keystore")!;
    // Nothing is left on this machine: the adapter holds the only copy.
    expect(await readLocalKey("release-keystore", directory)).toBeUndefined();
    expect(logged("success")).toContain(
      "Back it up: spec-store holds your only Play upload key.",
    );

    // native-build resolves signing.keystore "secret:release-keystore" so.
    const resolver = createCredentialResolver({
      secrets: resolveSecretsAdapter(store),
    });
    try {
      const keystore = await resolver.resolve({
        kind: "android-keystore",
        name: "release-keystore",
      });
      const stored = JSON.parse(value);
      expect(keystore.keyAlias).toBe("upload");
      expect(keystore.storePassword).toBe(stored.storePassword);
      expect(keystore.keyPassword).toBe(stored.keyPassword);
      expect((await fs.readFile(keystore.storeFile)).toString("base64")).toBe(
        stored.keystore,
      );
    } finally {
      await resolver.dispose();
    }
  });

  it("with a team's adapter, reads and writes only there: a copy on this machine is no stored key", async () => {
    const { store, held } = writableStore();
    await writeLocalKey("android-keystore", '{"stale":"copy"}', directory);

    await withTTY(true, () => handleUploadKeyIssue());

    expect(process.exitCode).toBeUndefined();
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(held.get("android-keystore")!).keyAlias).toBe("upload");
    // The file on this machine is neither read as the key nor written.
    expect(await readLocalKey("android-keystore", directory)).toBe(
      '{"stale":"copy"}',
    );
    expect(logged("success")).toContain("Source   spec://android-keystore");
  });

  it("fails when the adapter doesn't read the key back as stored, keeping nothing on this machine", async () => {
    const writeOnly = {
      name: "write-only",
      describe: (name: string) => `wo://${name}`,
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    } satisfies SecretsAdapter;
    configure(writeOnly);

    await withTTY(true, () => handleUploadKeyIssue());

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      [
        "write-only doesn't read android-keystore back as stored.",
        "It reads back nothing.",
        "Nothing is kept on this machine: check wo://android-keystore.",
      ].join("\n"),
    );
    expect(log.success).not.toHaveBeenCalled();
    expect(await readLocalKey("android-keystore", directory)).toBeUndefined();
  });

  it("keeps a stored keystore without --replace, saying why in one line", async () => {
    const { contents } = await existingKeystore({
      storePassword: "same-secret",
      keyPassword: "same-secret",
    });
    const value = androidKeystoreValue({
      keystore: contents,
      storePassword: "same-secret",
      keyAlias: "eas-upload",
      keyPassword: "same-secret",
    });
    const { store } = writableStore({ "android-keystore": value });

    await withTTY(true, () => handleUploadKeyIssue());

    expect(process.exitCode).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
    expect(keytoolCalls.map(({ args }) => args[0])).not.toContain(
      "-genkeypair",
    );
    const lines = logged("step").split("\n");
    expect(lines[0]).toBe("Upload key already stored");
    expect(lines[1]).toBe("Alias    eas-upload");
    expect(lines.at(-2)).toBe("Source   spec://android-keystore");
    expect(lines.at(-1)).toBe(
      "Kept: once Play has it, a new key breaks uploads.",
    );
    expect(printed()).not.toContain("same-secret");
  });

  it("--replace overwrites it, naming the old key's fingerprint, which a key reset needs", async () => {
    const { contents } = await existingKeystore({
      storePassword: "old-secret",
      keyPassword: "old-secret",
    });
    const { held } = writableStore({
      "android-keystore": androidKeystoreValue({
        keystore: contents,
        storePassword: "old-secret",
        keyAlias: "eas-upload",
        keyPassword: "old-secret",
      }),
    });

    await withTTY(true, () =>
      handleUploadKeyIssue("android-keystore", { replace: true }),
    );

    expect(JSON.parse(held.get("android-keystore")!).keyAlias).toBe("upload");
    const warned = logged("warn").split("\n");
    expect(warned[0]).toBe("The old upload key was replaced");
    expect(warned[1]).toBe("Alias    eas-upload");
    expect(warned[2]).toMatch(/^SHA-256 {2}[0-9A-F:]{47}$/u);
  });

  it("--pem writes the certificate of the key it creates", async () => {
    configure();
    const pem = path.join(directory, "upload.pem");

    await withTTY(true, () =>
      handleUploadKeyIssue("android-keystore", { pem }),
    );

    expect(await fs.readFile(pem, "utf-8")).toMatch(
      /^-----BEGIN CERTIFICATE-----\n[\w+/=\n]+-----END CERTIFICATE-----\n$/u,
    );
    expect(logged("success")).toContain(
      "Play has another upload key? Send this certificate in a key reset.",
    );
  });

  it("stops with how to install a JDK when keytool is missing, before storing anything", async () => {
    const { store } = writableStore();
    vi.mocked(findKeytool).mockRejectedValue(new KeytoolMissingError());

    await withTTY(true, () => handleUploadKeyIssue());

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      [
        "keytool is missing: it comes with the JDK that Android builds use.",
        "Install JDK 17 (https://adoptium.net), or set JAVA_HOME to one.",
      ].join("\n"),
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("creates nothing without a terminal, naming the command to run in one", async () => {
    const { store } = writableStore();

    await withTTY(false, () => handleUploadKeyIssue());

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      [
        "Can't create an upload key without a terminal.",
        "Run in a terminal: npx hot-updater secrets issue android-keystore",
        "Or store yours: npx hot-updater secrets put --help",
      ].join("\n"),
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("keeps a keystore the environment sets, and --replace refuses it", async () => {
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PATH", "release.jks");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", "env-upload");
    const { store } = writableStore();

    await withTTY(true, () => handleUploadKeyIssue());
    expect(process.exitCode).toBeUndefined();
    expect(logged("step")).toBe(
      [
        "Upload key set by the environment",
        "Alias   env-upload",
        "Source  HOT_UPDATER_ANDROID_KEYSTORE_PATH",
        "        HOT_UPDATER_ANDROID_KEY_ALIAS",
      ].join("\n"),
    );

    await withTTY(true, () =>
      handleUploadKeyIssue("android-keystore", { replace: true }),
    );
    expect(process.exitCode).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    ["its variables", "fields"],
    ["localSecrets()' whole-value variable", "value"],
  ] as const)(
    "--pem exports the certificate of a keystore the environment sets in %s",
    async (_, how) => {
      const { file, contents } = await existingKeystore();
      if (how === "fields") {
        vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PATH", file);
        vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "store-secret-1");
        vi.stubEnv("HOT_UPDATER_ANDROID_KEY_ALIAS", "eas-upload");
        vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-secret-22");
      } else {
        vi.stubEnv(
          "HOT_UPDATER_ANDROID_KEYSTORE",
          androidKeystoreValue({
            keystore: contents,
            storePassword: "store-secret-1",
            keyAlias: "eas-upload",
            keyPassword: "key-secret-22",
          }),
        );
      }
      configure();
      const pem = path.join(directory, "upload.pem");

      await withTTY(true, () =>
        handleUploadKeyIssue("android-keystore", { pem }),
      );

      expect(process.exitCode).toBeUndefined();
      const { certificate } = keystores.get(contents.toString("base64"))!;
      expect(
        (await fs.readFile(pem, "utf-8")).replace(/-----[A-Z ]+-----|\s/gu, ""),
      ).toBe(certificate.toString("base64"));
      expect(logged("step")).toContain("Certificate");
      expect(printed()).not.toMatch(/store-secret-1|key-secret-22/u);
    },
  );
});

describe("hot-updater secrets put android-keystore <file>", () => {
  it("asks the passwords at a terminal, retrying a wrong one, takes its only alias, and stores what keytool opens", async () => {
    const { held } = writableStore();
    const { file, contents } = await existingKeystore();
    password
      .mockResolvedValueOnce("wrong-store")
      .mockResolvedValueOnce("store-secret-1")
      .mockResolvedValueOnce("key-secret-22");

    await withTTY(true, () => handleSecretsPut("android-keystore", { file }));

    expect(process.exitCode).toBeUndefined();
    // The file is the argument, and one alias leaves nothing to choose.
    expect(text).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(password.mock.calls.map(([options]) => options.message)).toEqual([
      "Keystore password",
      "Keystore password",
      "Password of the key eas-upload",
    ]);
    expect(logged("warn")).toBe("The keystore password is wrong.");
    expect(JSON.parse(held.get("android-keystore")!)).toEqual({
      keystore: contents.toString("base64"),
      storePassword: "store-secret-1",
      keyAlias: "eas-upload",
      keyPassword: "key-secret-22",
    });
    expect(logged("success").split("\n")[0]).toBe("Upload key stored");
    expect(printed()).not.toMatch(/store-secret-1|key-secret-22|wrong-store/u);
  });

  it("tries the key's password as the store's first, asking once when they are one", async () => {
    const { held } = writableStore();
    const { file } = await existingKeystore({
      storePassword: "same-secret",
      keyPassword: "same-secret",
    });
    password.mockResolvedValueOnce("same-secret");

    await withTTY(true, () =>
      handleSecretsPut("release-keystore", { kind: "android-keystore", file }),
    );

    expect(password).toHaveBeenCalledTimes(1);
    expect(JSON.parse(held.get("release-keystore")!).keyPassword).toBe(
      "same-secret",
    );
  });

  it("refuses in one line without a terminal and --key-alias, asking and storing nothing", async () => {
    const { store } = writableStore();
    const { file } = await existingKeystore();

    await withTTY(false, () => handleSecretsPut("android-keystore", { file }));

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      "Can't ask for the keystore's passwords without a terminal: pass --key-alias.",
    );
    expect(password).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes --key-alias and the password variables without a terminal", async () => {
    const { held } = writableStore();
    const { file } = await existingKeystore();
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD", "store-secret-1");
    vi.stubEnv("HOT_UPDATER_ANDROID_KEY_PASSWORD", "key-secret-22");

    await withTTY(false, () =>
      handleSecretsPut("android-keystore", { file, keyAlias: "eas-upload" }),
    );

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(held.get("android-keystore")!).keyAlias).toBe(
      "eas-upload",
    );
  });
});

describe("hot-updater secrets put android-keystore without the keystore", () => {
  it("names the command that stores one, and the one that creates one", async () => {
    writableStore();

    await withTTY(true, () =>
      handleSecretsPut("android-keystore", { kind: "android-keystore" }),
    );

    expect(process.exitCode).toBe(1);
    expect(logged("error")).toBe(
      [
        "secrets put needs the keystore file:",
        "npx hot-updater secrets put android-keystore <upload.jks>",
        "To create a new key, run npx hot-updater secrets issue android-keystore",
      ].join("\n"),
    );
  });
});

describe("findKeytool", () => {
  it("counts a keytool that doesn't run, such as macOS's stub without a JDK, as missing", async () => {
    const { findKeytool: realFindKeytool } = await vi.importActual<
      typeof import("../utils/native/androidKeystore")
    >("../utils/native/androidKeystore");
    const javaHome = path.join(directory, "jdk");
    await fs.mkdir(path.join(javaHome, "bin"), { recursive: true });
    const stub = path.join(javaHome, "bin", "keytool");
    await fs.writeFile(
      stub,
      "#!/bin/sh\necho 'Unable to locate a Java Runtime.' >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    );
    const empty = path.join(directory, "empty-bin");
    await fs.mkdir(empty);
    vi.stubEnv("PATH", empty);

    await expect(
      realFindKeytool({ JAVA_HOME: javaHome, PATH: empty }),
    ).rejects.toBeInstanceOf(KeytoolMissingError);
  });
});

/** The JDK's keytool, when this machine has one: CI's runners do. */
const realKeytool = await vi
  .importActual<typeof import("../utils/native/androidKeystore")>(
    "../utils/native/androidKeystore",
  )
  .then(({ findKeytool: find }) => find())
  .catch(() => undefined);

describe.skipIf(!realKeytool)("an upload key the real keytool creates", () => {
  it("opens with the passwords stored with it, and fits every secrets adapter", async () => {
    const { entry, certificate } = await createUploadKeystore(realKeytool!, {
      commonName: "com.example.app",
    });

    const reopened = await verifyKeystore(realKeytool!, entry);
    expect(reopened.fingerprints).toEqual(certificate.fingerprints);
    expect(certificate.fingerprints.sha256).toMatch(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u,
    );

    // AWS Secrets Manager takes 65,536 bytes (MAX_SECRET_BYTES in
    // plugins/aws/src/secretsManager.ts), Google Secret Manager 64 KiB:
    // a 4096-bit PKCS12 keystore is about 4.2 KB, its value about 5.8 KB.
    const bytes = Buffer.byteLength(androidKeystoreValue(entry), "utf8");
    expect(bytes).toBeLessThan(8 * 1024);
    expect(bytes).toBeLessThan(65_536);
  }, 30_000);
});

it("a value of the measured 4248-byte keystore stays well under AWS's and Google's limits", () => {
  const value = androidKeystoreValue({
    keystore: Buffer.alloc(4248),
    storePassword: "x".repeat(32),
    keyAlias: "upload",
    keyPassword: "x".repeat(32),
  });
  expect(Buffer.byteLength(value, "utf8")).toBeLessThan(65_536 / 8);
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
