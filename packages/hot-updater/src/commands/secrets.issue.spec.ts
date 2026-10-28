import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  p,
  getLocalKeyFile,
  loadConfig,
  readLocalKey,
  resolveSecretsAdapter,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSecretsIssue, handleSecretsPut } from "./secrets";

const { log, text, select, confirm, ascKey, playKey } = vi.hoisted(() => ({
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
  confirm: vi.fn(),
  /** The App Store Connect key the stand-in Apple sign-in issues. */
  ascKey: {
    revoke: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  },
  /** The service account key the stand-in Google sign-in issues. */
  playKey: {
    revoke: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  },
}));

// Only the config, the prompts, and the two sign-ins are stood in for.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { isCancel: vi.fn(() => false), log, text, select, confirm },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
// The GitHub Actions offer has its own specs: here it finds nothing to offer.
vi.mock("../utils/native/githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));
vi.mock("open", () => ({ default: vi.fn(async () => {}) }));
vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  issueAscApiKey: vi.fn(async (request: { name: string }) => ({
    p8: NEW_P8,
    keyId: "NEWKEY0001",
    issuerId: "issuer-1",
    name: request.name,
    team: {},
    ...ascKey,
  })),
}));
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  issuePlayServiceAccount: vi.fn(
    async (request: { askPackageName: () => Promise<string> }) => {
      // The issuer asks once its sign-in tool is found.
      packageNames.push(await request.askPackageName());
      return {
        json: NEW_SERVICE_ACCOUNT,
        email: "hot-updater-play@my-app.iam.gserviceaccount.com",
        projectId: "my-app",
        keyId: "newkey-play-0001",
        ...playKey,
      };
    },
  ),
}));

/** The package names the issuer was given, in order. */
const packageNames: string[] = [];

import { issuePlayServiceAccount } from "@hot-updater/android-helper";
import { issueAscApiKey } from "@hot-updater/apple-helper";

const NEW_P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49issueSpecNewKey01\n-----END PRIVATE KEY-----";
const OLD_ASC = JSON.stringify({
  keyId: "OLDKEY0001",
  issuerId: "issuer-1",
  p8: "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49issueSpecOldKey01\n-----END PRIVATE KEY-----",
});
const NEW_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "my-app",
  private_key_id: "newkey-play-0001",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIBissueSpecNewPlayKey01\n-----END PRIVATE KEY-----",
  client_email: "hot-updater-play@my-app.iam.gserviceaccount.com",
});
const OLD_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "old-project",
  private_key_id: "oldkey-play-0001",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIBissueSpecOldPlayKey01\n-----END PRIVATE KEY-----",
  client_email: "uploader@old-project.iam.gserviceaccount.com",
});

const ENV_NAMES = [
  "HOT_UPDATER_ASC_KEY_PATH",
  "HOT_UPDATER_ASC_KEY",
  "HOT_UPDATER_ASC_KEY_ID",
  "HOT_UPDATER_ASC_ISSUER_ID",
  "HOT_UPDATER_ASC_API_KEY",
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

/** The last thing the log printed, of every level, without colors. */
const lastLogged = () => {
  const calls = Object.values(log).flatMap((fn) =>
    fn.mock.calls.map((args, index) => ({
      order: fn.mock.invocationCallOrder[index]!,
      text: args.map(String).join(" "),
    })),
  );
  calls.sort((a, b) => a.order - b.order);
  return stripVTControlCharacters(calls.at(-1)?.text ?? "");
};

/** A writable secrets adapter the config sets, recording each call. */
const writableStore = (values: Record<string, string> = {}) => {
  const held = new Map(Object.entries(values));
  const calls: string[] = [];
  const store = {
    name: "spec-store",
    describe: (name: string) => `spec://${name}`,
    get: vi.fn(async (names: readonly string[]) => {
      calls.push(`get ${names.join(",")}`);
      return Object.fromEntries(names.map((name) => [name, held.get(name)]));
    }),
    set: vi.fn(async (name: string, value: string) => {
      calls.push(`set ${name}`);
      held.set(name, value);
    }),
  } satisfies SecretsAdapter;
  configure(store);
  return { store, held, calls };
};

let directory: string;

/** Makes `secrets` the config's, as loadConfig hands it over: with `localSecrets()`'s store. */
const configure = (secrets?: SecretsAdapter) => {
  vi.mocked(loadConfig).mockResolvedValue({
    secrets: resolveSecretsAdapter(secrets),
  } as never);
};

/** Where `localSecrets()`'s store keeps `name` for the project. */
const keyFile = (name: string) => getLocalKeyFile(name, directory);

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
  vi.stubEnv("CI", "");
  for (const name of ENV_NAMES) vi.stubEnv(name, "");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-issue-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(directory, "home"));
  // The project is the scratch directory, without a .env.hotupdater.
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  text.mockImplementation(async ({ message }: { message: string }) =>
    message.startsWith("Apple Account") ? "dev@example.com" : "com.example.app",
  );
  confirm.mockResolvedValue(true);
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater secrets issue asc-api-key", () => {
  it("signs in with the Apple Account, and stores the issued key through the adapter", async () => {
    const { held, calls } = writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ appleId: "dev@example.com", role: "ADMIN" }),
    );
    expect(JSON.parse(held.get("asc-api-key")!)).toEqual({
      keyId: "NEWKEY0001",
      issuerId: "issuer-1",
      p8: NEW_P8,
    });
    // One read before the sign-in, the write, and its read-back.
    expect(calls).toEqual([
      "get asc-api-key",
      "set asc-api-key",
      "get asc-api-key",
    ]);
    expect(printed()).toContain("App Store Connect API key stored");
    expect(printed()).not.toContain("issueSpecNewKey01");
    expect(ascKey.revoke).not.toHaveBeenCalled();
    // The run ends with the key it stored and where.
    expect(lastLogged()).toBe(
      "App Store Connect API key stored\nKey ID  NEWKEY0001\nSource  spec://asc-api-key",
    );
  });

  it("stores the key as the name given", async () => {
    const { held } = writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key", "widget-asc"));

    expect(JSON.parse(held.get("widget-asc")!)).toMatchObject({
      keyId: "NEWKEY0001",
    });
    expect(held.has("asc-api-key")).toBe(false);
  });

  it("keeps a stored key without signing in, naming its key ID and where it is, and nothing to run", async () => {
    const { store } = writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(printed()).toBe(
      "App Store Connect API key already stored\nKey ID  OLDKEY0001\nSource  spec://asc-api-key",
    );
  });

  it("keeps a key the environment overrides without signing in, naming an adapter that lacks it", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const { calls } = writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).not.toHaveBeenCalled();
    // One read, to tell a teammate's view apart: nothing is written.
    expect(calls).toEqual(["get asc-api-key"]);
    expect(printed()).toBe(
      [
        "App Store Connect API key set by the environment",
        "Key ID   ENVKEY0001",
        "Source   HOT_UPDATER_ASC_KEY_ID and HOT_UPDATER_ASC_ISSUER_ID",
        "Adapter  none in spec://asc-api-key",
      ].join("\n"),
    );
  });

  it("adds no Adapter row when the adapter holds the key the environment overrides", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(printed()).not.toContain("Adapter");
  });

  it("--replace issues a new key over the stored one, names the old one and where to revoke it, and never revokes it", async () => {
    const { held } = writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(true, () =>
      handleSecretsIssue("asc-api-key", "asc-api-key", { replace: true }),
    );

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).toHaveBeenCalledTimes(1);
    expect(JSON.parse(held.get("asc-api-key")!)).toMatchObject({
      keyId: "NEWKEY0001",
    });
    // The new key is kept, and nothing reaches App Store Connect for the old.
    expect(ascKey.revoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const warned = stripVTControlCharacters(
      log.warn.mock.calls.flat().map(String).join("\n"),
    );
    expect(warned).toBe(
      [
        "The old App Store Connect API key is still valid",
        "Key ID  OLDKEY0001",
        "Revoke  https://appstoreconnect.apple.com/access/integrations/api",
      ].join("\n"),
    );
    expect(printed()).not.toContain("issueSpecOldKey01");
    expect(printed()).toContain(
      "App Store Connect API key stored\nKey ID  NEWKEY0001\nSource  spec://asc-api-key",
    );
  });

  it("says this machine has no key before signing in, on the default store, and stores the issued key there", async () => {
    configure();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    const notice = log.info.mock.calls.findIndex(([message]) =>
      String(message).startsWith(
        "No App Store Connect API key on this machine: signing in issues one.",
      ),
    );
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(log.info.mock.invocationCallOrder[notice]!).toBeLessThan(
      vi.mocked(issueAscApiKey).mock.invocationCallOrder[0]!,
    );
    expect(
      JSON.parse((await readLocalKey("asc-api-key", directory))!),
    ).toMatchObject({ keyId: "NEWKEY0001" });
  });

  it("--replace on the default store replaces the key on this machine, and names the old one to revoke", async () => {
    configure();
    await fs.mkdir(path.dirname(keyFile("asc-api-key")), { recursive: true });
    await fs.writeFile(keyFile("asc-api-key"), OLD_ASC);

    await withTTY(true, () =>
      handleSecretsIssue("asc-api-key", "asc-api-key", { replace: true }),
    );

    expect(process.exitCode).toBeUndefined();
    const file = keyFile("asc-api-key");
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      keyId: "NEWKEY0001",
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const warned = stripVTControlCharacters(
      log.warn.mock.calls.flat().map(String).join("\n"),
    );
    expect(warned).toContain("Key ID  OLDKEY0001");
    // Replacing the key, no "no key on this machine" notice.
    expect(printed()).not.toContain("signing in issues one");
    expect(printed()).not.toContain("issueSpecOldKey01");
    expect(ascKey.revoke).not.toHaveBeenCalled();
    expect(printed()).toContain(
      "App Store Connect API key stored\nKey ID  NEWKEY0001\nSource  ",
    );
  });

  it("keeps the key the environment's whole value sets for localSecrets(), which reads it before its files", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", OLD_ASC);
    configure();

    await withTTY(true, () =>
      handleSecretsIssue("asc-api-key", "asc-api-key", { replace: true }),
    );

    expect(process.exitCode).toBe(1);
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "The environment or .env.hotupdater overrides asc-api-key.\nUnset HOT_UPDATER_ASC_API_KEY.",
    );
    expect(await readLocalKey("asc-api-key", directory)).toBeUndefined();
  });

  it("--replace refuses a key the environment overrides, which a new key would never replace", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    const { calls } = writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(true, () =>
      handleSecretsIssue("asc-api-key", "asc-api-key", { replace: true }),
    );

    expect(process.exitCode).toBe(1);
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      "The environment or .env.hotupdater overrides asc-api-key.\nUnset HOT_UPDATER_ASC_KEY_ID.",
    );
  });

  it("refuses without a terminal when no key is stored, naming the command to run in one and the import", async () => {
    const { calls } = writableStore();

    await withTTY(false, () => handleSecretsIssue("asc-api-key", "widget-asc"));

    expect(process.exitCode).toBe(1);
    expect(stripVTControlCharacters(log.error.mock.calls[0]![0])).toBe(
      [
        "Can't sign in to your Apple Account without a terminal.",
        "Run in a terminal: npx hot-updater secrets issue asc-api-key widget-asc",
        "Or store a key you have: npx hot-updater secrets put --help",
      ].join("\n"),
    );
    // Only the read that found no key: nothing is written.
    expect(calls).toEqual(["get widget-asc"]);
    expect(text).not.toHaveBeenCalled();
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });

  it.each([
    ["without a terminal", false, ""],
    ["in CI", true, "true"],
  ])(
    "reports a stored key %s, as at a terminal, and exits 0",
    async (_, isTTY, ci) => {
      vi.stubEnv("CI", ci);
      const { store } = writableStore({ "asc-api-key": OLD_ASC });

      await withTTY(isTTY, () => handleSecretsIssue("asc-api-key"));

      expect(process.exitCode).toBeUndefined();
      expect(log.error).not.toHaveBeenCalled();
      expect(issueAscApiKey).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
      expect(printed()).toBe(
        "App Store Connect API key already stored\nKey ID  OLDKEY0001\nSource  spec://asc-api-key",
      );
    },
  );

  it("reports a key the environment sets without a terminal, and exits 0", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    writableStore();

    await withTTY(false, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(printed()).toContain(
      "App Store Connect API key set by the environment",
    );
  });

  it("--replace still refuses without a terminal, since it signs in", async () => {
    const { store } = writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(false, () =>
      handleSecretsIssue("asc-api-key", "asc-api-key", { replace: true }),
    );

    expect(process.exitCode).toBe(1);
    expect(stripVTControlCharacters(log.error.mock.calls[0]![0])).toBe(
      [
        "Can't sign in to your Apple Account without a terminal.",
        "Run in a terminal: npx hot-updater secrets issue asc-api-key --replace",
        "Or store a key you have: npx hot-updater secrets put --help",
      ].join("\n"),
    );
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses in CI, even on a terminal the runner allocates", async () => {
    vi.stubEnv("CI", "true");
    writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Can't sign in to your Apple Account in CI (CI is set).",
      ),
    );
    expect(text).not.toHaveBeenCalled();
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });

  it("refuses a name that is no secret name", async () => {
    writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key", "../key"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('"../key" is not a secret name.'),
    );
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });
});

describe("hot-updater secrets issue play-service-account", () => {
  it("signs in with Google through gcloud, and stores the issued service account through the adapter", async () => {
    const { held } = writableStore();

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(packageNames.at(-1)).toBe("com.example.app");
    expect(held.get("play-service-account")).toBe(NEW_SERVICE_ACCOUNT);
    expect(printed()).toContain("Play service account stored");
    expect(printed()).not.toContain("issueSpecNewPlayKey01");
    expect(playKey.revoke).not.toHaveBeenCalled();
    expect(lastLogged()).toBe(
      [
        "Play service account stored",
        "Service account  hot-updater-play@my-app.iam.gserviceaccount.com",
        "Key ID           newkey-play-0001",
        "Source           spec://play-service-account",
      ].join("\n"),
    );
  });

  it("offers the package name the config's nativeBuild.android scheme declares", async () => {
    const { store } = writableStore();
    vi.mocked(loadConfig).mockResolvedValue({
      secrets: resolveSecretsAdapter(store),
      nativeBuild: {
        android: {
          release: { packageName: "com.codex.relay" },
          staging: {
            packageName: "com.codex.relay",
            applicationId: "com.codex.relay",
          },
        },
      },
    } as never);
    text.mockImplementation(
      async ({ initialValue }: { initialValue?: string }) => initialValue,
    );

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(select).not.toHaveBeenCalled();
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "com.codex.relay" }),
    );
    expect(packageNames.at(-1)).toBe("com.codex.relay");
  });

  it("chooses among the application IDs several schemes declare, or takes another", async () => {
    const { store } = writableStore();
    vi.mocked(loadConfig).mockResolvedValue({
      secrets: resolveSecretsAdapter(store),
      nativeBuild: {
        android: {
          release: { packageName: "com.codex.relay" },
          staging: {
            packageName: "com.codex.relay",
            applicationId: "com.codex.relay.staging",
          },
        },
      },
    } as never);
    select.mockResolvedValueOnce("com.codex.relay.staging");

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The app's package name in Google Play",
        options: [
          { value: "com.codex.relay", label: "com.codex.relay" },
          {
            value: "com.codex.relay.staging",
            label: "com.codex.relay.staging",
          },
          { value: "", label: "Another package name" },
        ],
      }),
    );
    expect(text).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The app's package name in Google Play",
      }),
    );
    expect(packageNames.at(-1)).toBe("com.codex.relay.staging");

    vi.clearAllMocks();
    select.mockResolvedValueOnce("");
    await withTTY(true, () =>
      handleSecretsIssue("play-service-account", "play-other"),
    );

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: "com.example.app" }),
    );
    expect(packageNames.at(-1)).toBe("com.example.app");
  });

  it("keeps a stored service account without signing in, naming it", async () => {
    writableStore({ "play-service-account": OLD_SERVICE_ACCOUNT });

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
    expect(printed()).toBe(
      [
        "Play service account already stored",
        "Service account  uploader@old-project.iam.gserviceaccount.com",
        "Key ID           oldkey-play-0001",
        "Source           spec://play-service-account",
      ].join("\n"),
    );
  });

  it("keeps a service account the environment's file sets, naming its email", async () => {
    const file = path.join(directory, "service-account.json");
    await fs.writeFile(file, OLD_SERVICE_ACCOUNT);
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH", file);
    const { calls } = writableStore();

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
    expect(calls).toEqual(["get play-service-account"]);
    const output = printed();
    expect(output).toContain("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH");
    expect(output).toContain("uploader@old-project.iam.gserviceaccount.com");
    expect(output).not.toContain("issueSpecOldPlayKey01");
  });

  it("--replace stores a new key, names the old key and where to delete it, and never deletes it", async () => {
    const { held } = writableStore({
      "play-service-account": OLD_SERVICE_ACCOUNT,
    });

    await withTTY(true, () =>
      handleSecretsIssue("play-service-account", "play-service-account", {
        replace: true,
      }),
    );

    expect(process.exitCode).toBeUndefined();
    expect(held.get("play-service-account")).toBe(NEW_SERVICE_ACCOUNT);
    expect(playKey.revoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const warned = stripVTControlCharacters(
      log.warn.mock.calls.flat().map(String).join("\n"),
    );
    // The URL, too long for its row, goes under its label.
    expect(warned).toBe(
      [
        "The old Play service account is still valid",
        "Service account  uploader@old-project.iam.gserviceaccount.com",
        "Key ID           oldkey-play-0001",
        "Revoke",
        "https://console.cloud.google.com/iam-admin/serviceaccounts?project=old-project",
      ].join("\n"),
    );
  });

  it("reports a stored service account without a terminal, and exits 0", async () => {
    const { store } = writableStore({
      "play-service-account": OLD_SERVICE_ACCOUNT,
    });

    await withTTY(false, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(printed()).toBe(
      [
        "Play service account already stored",
        "Service account  uploader@old-project.iam.gserviceaccount.com",
        "Key ID           oldkey-play-0001",
        "Source           spec://play-service-account",
      ].join("\n"),
    );
  });

  it("refuses without a terminal, naming the import with --service-account", async () => {
    writableStore();

    await withTTY(false, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBe(1);
    expect(stripVTControlCharacters(log.error.mock.calls[0]![0])).toBe(
      [
        "Can't sign in to your Google Account without a terminal.",
        "Run in a terminal: npx hot-updater google-play login",
        "Or store a key you have: npx hot-updater secrets put --help",
      ].join("\n"),
    );
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
  });
});

describe("hot-updater secrets put without the key's files", () => {
  it.each([
    [
      "asc-api-key",
      "asc-api-key",
      "--p8 <file>, --key-id <id>, --issuer-id <id>",
      "To issue a new key, run npx hot-updater apple login",
    ],
    [
      "widget-play",
      "play-service-account",
      "--service-account <file>",
      // Too long for the line, the command goes on its own.
      "To issue a new key, run\nnpx hot-updater secrets issue play-service-account widget-play",
    ],
  ] as const)(
    "never signs in for %s (%s), and names the command that issues it",
    async (name, kind, flags, issue) => {
      const { store } = writableStore();

      await withTTY(true, () => handleSecretsPut(name, { kind }));

      expect(process.exitCode).toBe(1);
      expect(stripVTControlCharacters(log.error.mock.calls[0]![0])).toBe(
        `secrets put needs ${flags}.\n${issue}`,
      );
      expect(text).not.toHaveBeenCalled();
      expect(issueAscApiKey).not.toHaveBeenCalled();
      expect(issuePlayServiceAccount).not.toHaveBeenCalled();
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    },
  );
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
