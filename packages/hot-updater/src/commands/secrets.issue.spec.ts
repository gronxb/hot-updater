import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  getLocalKeyFile,
  loadConfig,
  readLocalKey,
  withLocalKeyStore,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
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
  issuePlayServiceAccount: vi.fn(async () => ({
    json: NEW_SERVICE_ACCOUNT,
    email: "hot-updater-play@my-app.iam.gserviceaccount.com",
    projectId: "my-app",
    developerId: "1234",
    keyId: "newkey-play-0001",
    ...playKey,
  })),
}));

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
  "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
  "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
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
    secrets: withLocalKeyStore(secrets),
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
    // The run ends saying that only the key stayed, not a session.
    expect(lastLogged()).toBe(
      "Hot Updater kept no Apple session: it stored key NEWKEY0001 as asc-api-key in spec://asc-api-key.",
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

  it("keeps a stored key without signing in, naming where it is, its key ID, and --replace", async () => {
    const { store } = writableStore({ "asc-api-key": OLD_ASC });

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    const output = printed();
    expect(output).toContain("App Store Connect API key already stored");
    expect(output).toContain("spec://asc-api-key");
    expect(output).toContain("OLDKEY0001");
    expect(output).toContain(
      "`npx hot-updater secrets issue asc-api-key --replace`",
    );
    expect(output).not.toContain("kept no Apple session");
    expect(output).not.toContain("issueSpecOldKey01");
  });

  it("keeps a key the environment overrides without signing in or reading the adapter", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY0001");
    vi.stubEnv("HOT_UPDATER_ASC_ISSUER_ID", "issuer-1");
    const { calls } = writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    const output = printed();
    expect(output).toContain(
      "HOT_UPDATER_ASC_KEY_ID and HOT_UPDATER_ASC_ISSUER_ID",
    );
    expect(output).toContain("ENVKEY0001");
    expect(output).toContain("unset them");
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
    expect(warned).toContain(
      "The old App Store Connect API key is still valid",
    );
    expect(warned).toContain("OLDKEY0001");
    expect(warned).toContain(
      "Revoke OLDKEY0001 at https://appstoreconnect.apple.com/access/integrations/api",
    );
    expect(warned).toContain("Hot Updater never revokes it");
    expect(printed()).not.toContain("issueSpecOldKey01");
    expect(lastLogged()).toBe(
      "Hot Updater kept no Apple session: it stored key NEWKEY0001 as asc-api-key in spec://asc-api-key.",
    );
  });

  it("says this machine has no key before signing in, on the default store, and stores the issued key there", async () => {
    configure();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBeUndefined();
    const notice = log.info.mock.calls.findIndex(([message]) =>
      String(message).startsWith(
        "No App Store Connect API key on this machine.",
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
    expect(warned).toContain("OLDKEY0001");
    expect(warned).toContain("Hot Updater never revokes it");
    // Replacing the key, no "no key on this machine" notice.
    expect(printed()).not.toContain("on this machine. Signing in issues");
    expect(printed()).not.toContain("issueSpecOldKey01");
    expect(ascKey.revoke).not.toHaveBeenCalled();
    expect(lastLogged()).toBe(
      `Hot Updater kept no Apple session: it stored key NEWKEY0001 as asc-api-key in ${file}.`,
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
      "HOT_UPDATER_ASC_API_KEY is set in the environment or .env.hotupdater, which builds read before any secrets adapter, so a new App Store Connect API key would never be used. Unset it, then run `npx hot-updater secrets issue asc-api-key --replace` again.",
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
      "HOT_UPDATER_ASC_KEY_ID is set in the environment or .env.hotupdater, which builds read before any secrets adapter, so a new App Store Connect API key would never be used. Unset it, then run `npx hot-updater secrets issue asc-api-key --replace` again.",
    );
  });

  it("refuses without a terminal before anything else, naming the command to run in one and the import", async () => {
    const { calls } = writableStore();

    await withTTY(false, () => handleSecretsIssue("asc-api-key", "widget-asc"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "Hot Updater signs in to your Apple Account to issue the App Store Connect API key only at a terminal, never without a terminal. Run `npx hot-updater secrets issue asc-api-key widget-asc` in a terminal, or store a key you have with `npx hot-updater secrets put widget-asc --kind asc-api-key --p8 <AuthKey.p8> --key-id <id> --issuer-id <id>`.",
    );
    expect(loadConfig).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(text).not.toHaveBeenCalled();
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });

  it("refuses in CI, even on a terminal the runner allocates", async () => {
    vi.stubEnv("CI", "true");
    writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("never in CI (CI is set)."),
    );
    expect(text).not.toHaveBeenCalled();
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });

  it("refuses a name that is no secret name", async () => {
    writableStore();

    await withTTY(true, () => handleSecretsIssue("asc-api-key", "../key"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('"../key" is no secret name'),
    );
    expect(issueAscApiKey).not.toHaveBeenCalled();
  });
});

describe("hot-updater secrets issue play-service-account", () => {
  it("signs in with Google, and stores the issued service account through the adapter", async () => {
    vi.stubEnv("HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID", "client.apps");
    const { held } = writableStore();

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(issuePlayServiceAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "com.example.app",
        oauthClient: { clientId: "client.apps" },
      }),
    );
    expect(held.get("play-service-account")).toBe(NEW_SERVICE_ACCOUNT);
    expect(printed()).toContain("Play service account stored");
    expect(printed()).not.toContain("issueSpecNewPlayKey01");
    expect(playKey.revoke).not.toHaveBeenCalled();
    expect(lastLogged()).toBe(
      "Hot Updater kept no Google session: it stored a key of hot-updater-play@my-app.iam.gserviceaccount.com as play-service-account in spec://play-service-account.",
    );
  });

  it("keeps a stored service account without signing in, naming it", async () => {
    writableStore({ "play-service-account": OLD_SERVICE_ACCOUNT });

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
    const output = printed();
    expect(output).toContain("Play service account already stored");
    expect(output).toContain("uploader@old-project.iam.gserviceaccount.com");
    expect(output).toContain("oldkey-play-0001");
    expect(output).not.toContain("issueSpecOldPlayKey01");
  });

  it("keeps a service account the environment's file sets, naming its email", async () => {
    const file = path.join(directory, "service-account.json");
    await fs.writeFile(file, OLD_SERVICE_ACCOUNT);
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH", file);
    const { calls } = writableStore();

    await withTTY(true, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBeUndefined();
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    const output = printed();
    expect(output).toContain("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH");
    expect(output).toContain("uploader@old-project.iam.gserviceaccount.com");
    expect(output).not.toContain("issueSpecOldPlayKey01");
  });

  it("--replace stores a new key, names the old key and where to delete it, and never deletes it", async () => {
    vi.stubEnv("HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID", "client.apps");
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
    expect(warned).toContain("The old Play service account is still valid");
    expect(warned).toContain(
      "Delete the key oldkey-play-0001 under the service account uploader@old-project.iam.gserviceaccount.com's keys at https://console.cloud.google.com/iam-admin/serviceaccounts?project=old-project",
    );
    expect(warned).toContain("Hot Updater never revokes it");
  });

  it("refuses without a terminal, naming the import with --service-account", async () => {
    writableStore();

    await withTTY(false, () => handleSecretsIssue("play-service-account"));

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `npx hot-updater google-play login` in a terminal, or store a key you have with `npx hot-updater secrets put play-service-account --kind play-service-account --service-account <key.json>`.",
      ),
    );
    expect(issuePlayServiceAccount).not.toHaveBeenCalled();
  });
});

describe("hot-updater secrets put without the key's files", () => {
  it.each([
    [
      "asc-api-key",
      "asc-api-key",
      "an asc-api-key",
      "--p8 <file>, --key-id <id>, --issuer-id <id>",
      "npx hot-updater apple login",
    ],
    [
      "widget-play",
      "play-service-account",
      "a play-service-account",
      "--service-account <file>",
      "npx hot-updater secrets issue play-service-account widget-play",
    ],
  ] as const)(
    "never signs in for %s (%s), and names the command that issues it",
    async (name, kind, item, flags, issue) => {
      const { store } = writableStore();

      await withTTY(true, () => handleSecretsPut(name, { kind }));

      expect(process.exitCode).toBe(1);
      expect(log.error).toHaveBeenCalledWith(
        `secrets put stores ${item} you have: ${flags}. To sign in and have Hot Updater issue one, run \`${issue}\` in a terminal.`,
      );
      expect(text).not.toHaveBeenCalled();
      expect(issueAscApiKey).not.toHaveBeenCalled();
      expect(issuePlayServiceAccount).not.toHaveBeenCalled();
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    },
  );
});
