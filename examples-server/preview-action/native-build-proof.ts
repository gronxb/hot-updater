/**
 * The native build action's CI proof: what each run must have printed, and
 * left in Postgres, read from the CLI's recorded output (PROOF_LOG, written
 * by scripts/record-cli.mjs) and from Postgres directly. The config sets no
 * `secrets` adapter, so the CLI reads every credential from the job's
 * environment, then localSecrets()'s store under HOT_UPDATER_HOME.
 *
 *   node native-build-proof.ts <stage>
 *
 * Stages:
 * - upload-missing: the environment lacks play-service-account; the run
 *   never signs in to Google, and fails before the build, naming the
 *   secrets adapter and the command that signs in once.
 * - keystore-missing: the scheme's keystore is missing, without an upload;
 *   the signing credential fails before the build too.
 * - keystore-malformed: the keystore's JSON value lacks a field; the run
 *   names the field and the shape before the build.
 * - ios-missing: native-build ios in CI without the App Store Connect API key, as
 *   the CLI runs it without a terminal and on one (`script`), never asking.
 * - put-key-store <service-account.json>: `secrets put` stored the service
 *   account in localSecrets()'s store, outside the project, readable by the user
 *   alone, as the file's exact contents, and wrote no `.env.hotupdater`.
 * - built: with every credential set, the service account in localSecrets()'s store
 *   alone, the run builds, tracks, and fails only at Google, which
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

const expectMatches = (log: string, expected: string) => {
  if (!new RegExp(expected, "u").test(log)) {
    throw new Error(
      `The output does not match:\n  ${expected}\n\nOutput:\n${log}`,
    );
  }
};

/** localSecrets()'s files of `name`, one per project. */
const keyStoreFiles = (name: string) => {
  const keys = path.join(env("HOT_UPDATER_HOME"), "secrets");
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
    // Everything Google Play needs, before the build: the missing key with
    // the command that stores it, and the keystore the job's environment
    // sets.
    expectIncludes(
      log,
      "Google Play isn't ready for com.hotupdaterexample: ✗ Service account key npx hot-updater secrets put play-service-account <key.json> ✓ Upload keystore · Play access checked once the key is stored Guide: https://hot-updater.dev/docs/guides/native-build#set-up-google-play",
    );
    expectNothingBuilt(log);
    const { count } = await nativeBuildCount();
    if (count !== 0) throw new Error(`${count} native builds are registered.`);
  },
  "keystore-missing": async () => {
    // The command may be broken over lines with " \".
    const log = readLog().replaceAll(" \\ ", " ");
    expectIncludes(
      log,
      "No widget-keystore (android-keystore) in the localSecrets secrets adapter. Store the app's upload key: npx hot-updater secrets put widget-keystore --kind android-keystore <upload.jks> No .aab on Play yet? Create one: npx hot-updater secrets issue android-keystore widget-keystore",
    );
    expectNothingBuilt(log);
  },
  "keystore-malformed": async () => {
    const log = readLog();
    expectIncludes(
      log,
      'The localSecrets secrets adapter\'s release-keystore (android-keystore) has no keyPassword. An android-keystore is one JSON value: {"keystore", "storePassword", "keyAlias", "keyPassword"}',
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
      "asc-api-key is not in the localSecrets secrets adapter. Can't sign in to your Apple Account in CI (CI is set). Run once in a terminal: npx hot-updater apple login",
    );
    expectNothingBuilt(log);
  },
  // localSecrets() keeps what `secrets put` imports in this machine's
  // localSecrets() store, outside the project, where the next build reads it.
  "put-key-store": async () => {
    const log = readLog();
    expectIncludes(log, "Secret stored");
    const source = process.argv[3];
    if (!source) throw new Error("Pass the service account's file.");
    const files = keyStoreFiles("play-service-account");
    if (files.length !== 1) {
      throw new Error(
        `Expected one play-service-account in localSecrets()'s store, found ${files.length}.`,
      );
    }
    const file = files[0]!;
    // The file, shown with ~ or shortened in the middle.
    expectMatches(
      log,
      `Secret stored Name play-service-account Kind play-service-account Service account uploader@hot-updater-proof\\.iam\\.gserviceaccount\\.com Source \\S*${escapeRegExp(path.basename(file))}`,
    );
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
  // Google refuses the proof's made-up key when the build checks Play
  // access, before anything is built or tracked.
  "play-refused": async () => {
    const log = readLog();
    expectIncludes(
      log,
      "Google Play isn't ready for com.hotupdaterexample: ✗ Service account key Google refuses it",
    );
    expectIncludes(log, "✓ Upload keystore");
    expectNothingBuilt(log);
    const { count } = await nativeBuildCount();
    if (count !== 0) throw new Error(`${count} native builds are registered.`);
  },
  built: async () => {
    const log = readLog();
    // The service account comes from localSecrets()'s store alone.
    if (process.env["HOT_UPDATER_PLAY_SERVICE_ACCOUNT"]) {
      throw new Error("HOT_UPDATER_PLAY_SERVICE_ACCOUNT is set.");
    }
    if (keyStoreFiles("play-service-account").length !== 1) {
      throw new Error("localSecrets()'s store holds no play-service-account.");
    }
    expectExcludes(
      log,
      "in the localSecrets secrets adapter",
      "every credential the build needs is set.",
    );
    expectExcludes(
      log,
      "native-proof-pass",
      "the keystore's password is printed.",
    );
    // The fingerprint step's result, which only a build that ran prints.
    expectIncludes(log, "Android fingerprint ");
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
