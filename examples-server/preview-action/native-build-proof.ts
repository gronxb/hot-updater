/**
 * The native build action's CI proof: what each run must have printed, and
 * left in Postgres, read from the CLI's recorded output (PROOF_LOG, written
 * by scripts/record-cli.mjs) and from Postgres directly. The config sets no
 * `secrets` adapter, so the CLI reads every credential from the job's
 * environment, then this machine's key store under HOT_UPDATER_HOME.
 *
 *   node native-build-proof.ts <stage>
 *
 * Stages:
 * - upload-missing: the environment lacks play-service-account; the run
 *   never signs in to Google, and fails before the build, naming the
 *   variable and the key store file the default store reads, the command
 *   that signs in once, and the variables that replace it.
 * - keystore-missing: the scheme's keystore is missing, without an upload;
 *   the signing credential fails before the build too.
 * - keystore-malformed: the keystore's JSON value lacks a field; the run
 *   names the field and the shape before the build.
 * - ios-missing: build:ios in CI without the App Store Connect API key, as
 *   the CLI runs it without a terminal and on one (`script`), never asking.
 * - put-key-store <service-account.json>: `secrets put` stored the service
 *   account in the key store, outside the project, readable by the user
 *   alone, as the file's exact contents, and wrote no `.env.hotupdater`.
 * - built: with every credential set, the service account in the key store
 *   alone, the run builds, registers, and fails only at Google, which
 *   refuses the proof's made-up service account.
 *
 * Each reads PROOF_LOG.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import pg from "pg";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

/**
 * The recorded output as one line: without colors, the prompt library's
 * frame, or the line breaks a long message may get.
 */
const readLog = () =>
  readFileSync(env("PROOF_LOG"), "utf8")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[│┌└◇◆■▲●○]/g, " ")
    .replace(/\s+/g, " ");

const expectIncludes = (log: string, expected: string) => {
  if (!log.includes(expected)) {
    throw new Error(`The output lacks:\n  ${expected}\n\nOutput:\n${log}`);
  }
};

const expectExcludes = (log: string, unexpected: string, why: string) => {
  if (log.includes(unexpected)) {
    throw new Error(
      `The output has "${unexpected}": ${why}\n\nOutput:\n${log}`,
    );
  }
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where the default store says it reads `name`: its variable, then its
 * file in the key store, `<HOT_UPDATER_HOME>/keys/<project-key>/<name>.json`,
 * whose project key hashes the repository's origin and the project's
 * directory in it.
 */
const defaultStorePattern = (variable: string, name: string) =>
  `${variable} in the environment, or ${escapeRegExp(env("HOT_UPDATER_HOME"))}/keys/[A-Za-z0-9._-]+-[0-9a-f]{12}/${escapeRegExp(name)}\\.json on this machine`;

const expectMatches = (log: string, expected: string) => {
  if (!new RegExp(expected, "u").test(log)) {
    throw new Error(
      `The output does not match:\n  ${expected}\n\nOutput:\n${log}`,
    );
  }
};

/** The key store's files of `name`, one per project. */
const keyStoreFiles = (name: string) => {
  const keys = path.join(env("HOT_UPDATER_HOME"), "keys");
  return existsSync(keys)
    ? readdirSync(keys)
        .map((project) => path.join(keys, project, `${name}.json`))
        .filter((file) => existsSync(file))
    : [];
};

/** Fingerprinting is the first step after the prebuild: none ran. */
const expectNothingBuilt = (log: string) =>
  expectExcludes(
    log,
    "Fingerprint",
    "the run went past the credential check into the build.",
  );

const nativeBuildCount = async () => {
  const client = new pg.Client({
    connectionString: env("HOT_UPDATER_DATABASE_URL"),
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: string; kinds: string }>(
      "select count(*) as count, coalesce(string_agg(artifact_kind, ','), '') as kinds from native_builds",
    );
    return { count: Number(rows[0]!.count), kinds: rows[0]!.kinds };
  } finally {
    await client.end();
  }
};

const stages: Record<string, () => Promise<void>> = {
  "upload-missing": async () => {
    const log = readLog();
    // The words of a build that finds no key to issue, and CI never
    // signing in.
    expectMatches(
      log,
      `play-service-account is not in the default secrets adapter \\(${defaultStorePattern("HOT_UPDATER_PLAY_SERVICE_ACCOUNT", "play-service-account")}\\)\\. Store it once from a terminal with \`npx hot-updater google-play login\``,
    );
    expectIncludes(
      log,
      "Hot Updater signs in to your Google Account to issue it only at a terminal, never in CI (CI is set).",
    );
    expectIncludes(
      log,
      "Or set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide play-service-account from the environment.",
    );
    expectNothingBuilt(log);
    const { count } = await nativeBuildCount();
    if (count !== 0) throw new Error(`${count} native builds are registered.`);
  },
  "keystore-missing": async () => {
    const log = readLog();
    expectMatches(
      log,
      `widget-keystore \\(android-keystore\\) is not in the default secrets adapter \\(${defaultStorePattern("HOT_UPDATER_WIDGET_KEYSTORE", "widget-keystore")}\\)\\. Store it once with ${escapeRegExp("`npx hot-updater secrets put widget-keystore --kind android-keystore --keystore <release.jks> --key-alias <alias>`.")}`,
    );
    expectIncludes(
      log,
      "Or set HOT_UPDATER_ANDROID_KEYSTORE_PATH (or HOT_UPDATER_ANDROID_KEYSTORE_BASE64), HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, and HOT_UPDATER_ANDROID_KEY_PASSWORD to provide android-keystore from the environment.",
    );
    expectNothingBuilt(log);
  },
  "keystore-malformed": async () => {
    const log = readLog();
    expectIncludes(
      log,
      'The default secrets adapter\'s release-keystore (android-keystore) has no keyPassword: an android-keystore is one JSON value, {"keystore", "storePassword", "keyAlias", "keyPassword"}.',
    );
    expectExcludes(
      log,
      "malformed-proof-pass",
      "the keystore's password is printed.",
    );
    expectNothingBuilt(log);
  },
  // A missing App Store Connect API key is one Hot Updater issues after an
  // Apple Account sign-in, which CI never starts: the build refuses before
  // anything runs, with the command that signs in once.
  "ios-missing": async () => {
    const log = readLog();
    expectMatches(
      log,
      `asc-api-key is not in the default secrets adapter \\(${defaultStorePattern("HOT_UPDATER_ASC_API_KEY", "asc-api-key")}\\)\\. Store it once from a terminal with \`npx hot-updater apple login\``,
    );
    expectIncludes(
      log,
      "Hot Updater signs in to your Apple Account to issue it only at a terminal, never in CI (CI is set).",
    );
    expectIncludes(
      log,
      "Or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key from the environment.",
    );
    expectNothingBuilt(log);
  },
  // The default store keeps what `secrets put` imports in this machine's
  // key store, outside the project, where the next build reads it.
  "put-key-store": async () => {
    const log = readLog();
    expectIncludes(log, "Secret stored");
    const source = process.argv[3];
    if (!source) throw new Error("Pass the service account's file.");
    const files = keyStoreFiles("play-service-account");
    if (files.length !== 1) {
      throw new Error(
        `Expected one play-service-account in the key store, found ${files.length}.`,
      );
    }
    const file = files[0]!;
    expectIncludes(log, file);
    if (readFileSync(file, "utf8") !== readFileSync(source, "utf8")) {
      throw new Error(`${file} does not hold the service account as given.`);
    }
    if ((statSync(file).mode & 0o777) !== 0o600) {
      throw new Error(`${file} is readable by others.`);
    }
    if ((statSync(path.dirname(file)).mode & 0o777) !== 0o700) {
      throw new Error(`${path.dirname(file)} is open to others.`);
    }
    if (!path.relative(process.cwd(), file).startsWith("..")) {
      throw new Error(`${file} is inside the project.`);
    }
    if (existsSync(".env.hotupdater")) {
      throw new Error("secrets put wrote .env.hotupdater.");
    }
    const { private_key: privateKey } = JSON.parse(
      readFileSync(source, "utf8"),
    ) as { private_key: string };
    const keyLine = privateKey.split("\n")[1]!;
    expectExcludes(log, keyLine, "the private key is printed.");
  },
  built: async () => {
    const log = readLog();
    // The service account comes from the key store alone.
    if (process.env["HOT_UPDATER_PLAY_SERVICE_ACCOUNT"]) {
      throw new Error("HOT_UPDATER_PLAY_SERVICE_ACCOUNT is set.");
    }
    if (keyStoreFiles("play-service-account").length !== 1) {
      throw new Error("The key store holds no play-service-account.");
    }
    expectExcludes(
      log,
      "is not in the default secrets adapter",
      "every credential the build needs is set.",
    );
    expectExcludes(
      log,
      "native-proof-pass",
      "the keystore's password is printed.",
    );
    expectIncludes(log, "Fingerprint(");
    // Google refuses the made-up service account after the build and the
    // registration, and the build is kept.
    expectIncludes(log, "The build stays at");
    const { count, kinds } = await nativeBuildCount();
    if (count !== 1 || kinds !== "aab") {
      throw new Error(
        `Expected one registered .aab native build, found ${count} (${kinds}).`,
      );
    }
  },
};

const stage = process.argv[2] ?? "";
const run = stages[stage];
if (!run) {
  throw new Error(
    `Run a stage: ${Object.keys(stages).join(", ")}, not "${stage}".`,
  );
}
await run();
console.log(`native build proof: ${stage} passed`);
