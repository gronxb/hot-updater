/**
 * The native build action's CI proof: what each run must have printed, and
 * left in Postgres, read from the CLI's recorded output (PROOF_LOG, written
 * by scripts/record-cli.mjs) and from Postgres directly. Every credential
 * comes from the job's environment through the default envSecrets() secrets
 * adapter.
 *
 *   node native-build-proof.ts <stage>
 *
 * Stages:
 * - upload-missing: the environment lacks play-service-account; the run
 *   never signs in to Google, and fails before the build, naming the
 *   variable envSecrets() reads, the command that signs in once, and the
 *   variables that replace it.
 * - keystore-missing: the scheme's keystore is missing, without an upload;
 *   the signing credential fails before the build too.
 * - keystore-malformed: the keystore's JSON value lacks a field; the run
 *   names the field and the shape before the build.
 * - ios-missing: build:ios in CI without the App Store Connect API key, as
 *   the CLI runs it without a terminal and on one (`script`), never asking.
 * - put-read-only: `secrets put` with envSecrets(), which stores nothing, names
 *   the variable to set instead.
 * - built: with every credential set, the run builds, registers, and fails
 *   only at Google, which refuses the proof's made-up service account.
 *
 * Each reads PROOF_LOG.
 */
import { readFileSync } from "node:fs";

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
    expectIncludes(
      log,
      "play-service-account is not in the envSecrets secrets adapter (HOT_UPDATER_PLAY_SERVICE_ACCOUNT in the environment or .env.hotupdater). Store it once from a terminal with `npx hot-updater google-play login`",
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
    expectIncludes(
      log,
      "widget-keystore (android-keystore) is not in the envSecrets secrets adapter (HOT_UPDATER_WIDGET_KEYSTORE in the environment or .env.hotupdater). Store it once with `npx hot-updater secrets put widget-keystore --kind android-keystore --keystore <release.jks> --key-alias <alias>`.",
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
      'The envSecrets secrets adapter\'s release-keystore (android-keystore) has no keyPassword: an android-keystore is one JSON value, {"keystore", "storePassword", "keyAlias", "keyPassword"}.',
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
    expectIncludes(
      log,
      "asc-api-key is not in the envSecrets secrets adapter (HOT_UPDATER_ASC_API_KEY in the environment or .env.hotupdater). Store it once from a terminal with `npx hot-updater apple login`",
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
  "put-read-only": async () => {
    const log = readLog();
    expectIncludes(
      log,
      "The envSecrets secrets adapter is read-only, so Hot Updater stores nothing in it. Set HOT_UPDATER_PLAY_SERVICE_ACCOUNT in the environment or .env.hotupdater to the play-service-account as one JSON value",
    );
  },
  built: async () => {
    const log = readLog();
    expectExcludes(
      log,
      "is not in the envSecrets secrets adapter",
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
