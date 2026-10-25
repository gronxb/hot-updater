/**
 * The native build action's CI proof: what each run must have printed, and
 * left in Postgres, read from the CLI's recorded output (PROOF_LOG, written
 * by scripts/record-cli.mjs) and from Postgres directly.
 *
 *   node native-build-proof.ts <stage>
 *
 * Stages:
 * - upload-missing: the vault lacks play-service-account; the run never
 *   signs in to Google, and fails before the build, naming it, the command
 *   that signs in once, and the environment variables that replace it.
 * - keystore-missing: the scheme's keystore is missing, without an upload;
 *   the signing credential fails before the build too.
 * - scope: the token reads only deploy-credentials, and the build signs
 *   with the vault's keystore; the run names the token to issue.
 * - ios-missing: build:ios in CI without the App Store Connect API key, as
 *   the CLI runs it without a terminal and on one (`script`), never asking.
 * - built: with every credential stored, the run builds, registers, and
 *   fails only at Google, which refuses the proof's made-up service account.
 *
 * Each reads PROOF_CONSOLE_URL and PROOF_LOG.
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

const consoleUrl = () => env("PROOF_CONSOLE_URL");

const stages: Record<string, () => Promise<void>> = {
  "upload-missing": async () => {
    const log = readLog();
    expectIncludes(
      log,
      `play-service-account is not in the vault at ${consoleUrl()}, or the vault token's scope does not reach it, and Hot Updater signs in to your Google Account only at a terminal, never in CI (CI is set). Run \`npx hot-updater secrets put play-service-account --kind play-service-account\` once on a machine where you can sign in, and give this build a vault token that reads play-service-account, or set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide it without the vault.`,
    );
    expectNothingBuilt(log);
    const { count } = await nativeBuildCount();
    if (count !== 0) throw new Error(`${count} native builds are registered.`);
  },
  "keystore-missing": async () => {
    const log = readLog();
    expectIncludes(
      log,
      `widget-keystore (android-keystore) is not in the vault at ${consoleUrl()}. Store it once from a machine that reaches the Console, with \`npx hot-updater secrets put widget-keystore --kind android-keystore --keystore <release.jks> --key-alias <alias>\``,
    );
    expectIncludes(
      log,
      "Set HOT_UPDATER_ANDROID_KEYSTORE_PATH (or HOT_UPDATER_ANDROID_KEYSTORE_BASE64), HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD, HOT_UPDATER_ANDROID_KEY_ALIAS, and HOT_UPDATER_ANDROID_KEY_PASSWORD to provide android-keystore without the vault.",
    );
    expectNothingBuilt(log);
  },
  scope: async () => {
    const log = readLog();
    expectIncludes(
      log,
      `The Console at ${consoleUrl()} refused the request: The vault token's scope does not allow reading`,
    );
    expectIncludes(
      log,
      "give the build a vault token whose scope allows read on it, such as one from `npx hot-updater secrets token create --name ci-native --secrets",
    );
    expectNothingBuilt(log);
  },
  // A missing App Store Connect API key is one Hot Updater issues after an
  // Apple Account sign-in, which CI never starts: the build refuses before
  // anything runs, naming the command that signs in once.
  "ios-missing": async () => {
    const log = readLog();
    expectIncludes(
      log,
      `asc-api-key is not in the vault at ${consoleUrl()}, or the vault token's scope does not reach it, and Hot Updater signs in to your Apple Account only at a terminal, never in CI (CI is set). Run \`npx hot-updater secrets put asc-api-key --kind asc-api-key\` once on a machine where you can sign in`,
    );
    expectIncludes(
      log,
      "or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide it without the vault.",
    );
    expectNothingBuilt(log);
  },
  built: async () => {
    const log = readLog();
    expectExcludes(
      log,
      "is not in the vault",
      "every credential the build needs is stored.",
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
