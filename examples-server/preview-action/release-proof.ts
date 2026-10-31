/**
 * The release action's CI proof. Each stage of the workflow changed the app in
 * a known way, so what must happen is written down here by hand, never taken
 * from the decision code, and checked against what happened: Postgres, the
 * stored artifact, the fake store's own record of what it took, and the CLI
 * commands that ran. The action's result output is only checked against those.
 *
 *   node release-proof.ts <stage>
 *
 * It reads PROOF_RESULT and PROOF_OUTCOME, the action's output and the step's
 * outcome, PROOF_CHANNEL, PROOF_COMMANDS (scripts/record-cli.mjs), and
 * PROOF_PLAY_LOG (scripts/fake-play.mjs). A stage that passes empties the
 * command log, so the next stage sees only its own run.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

interface Expected {
  /** What the action must decide, and what must come of it, by platform. */
  readonly platforms: Readonly<
    Record<string, { readonly decision: string; readonly outcome: string }>
  >;
  /** Whether the action's step must fail. */
  readonly fails?: boolean;
  /** The tracked Android builds, oldest first: whether each reached the store. */
  readonly builds: readonly ("submitted" | "not submitted")[];
  /** Bundles on the channel, by platform. */
  readonly releases: { readonly android: number; readonly ios: number };
  /** The uploads the store took, each the artifact of a submitted build. */
  readonly uploads: number;
  /** The CLI commands that may run, by their first words, in order. */
  readonly commands: readonly string[];
  /** Whether the second build must have another fingerprint than the first. */
  readonly newFingerprint?: boolean;
}

const FIND = "native-build find";
const BUILD = "native-build android";
const DEPLOY = ["fingerprint create", "deploy", "bundle list"];
const noBundles = { android: 0, ios: 0 };

const STAGES: Readonly<Record<string, Expected>> = {
  // Nothing is tracked: a native build, which the dry run only says.
  "first-dry-run": {
    platforms: { android: { decision: "build", outcome: "decided" } },
    builds: [],
    releases: noBundles,
    uploads: 0,
    commands: [FIND],
  },
  // The store fails the upload after the build is tracked.
  "first-upload-fails": {
    platforms: { android: { decision: "build", outcome: "failed" } },
    fails: true,
    builds: ["not submitted"],
    releases: noBundles,
    uploads: 0,
    commands: [FIND, "channel set", FIND, BUILD],
  },
  // The build is tracked but the store has nothing: not a reason to deploy.
  "rerun-dry-run": {
    platforms: { android: { decision: "build", outcome: "decided" } },
    builds: ["not submitted"],
    releases: noBundles,
    uploads: 0,
    commands: [FIND],
  },
  // The rerun finishes the submit, reusing the tracked build.
  rerun: {
    platforms: { android: { decision: "build", outcome: "built" } },
    builds: ["submitted"],
    releases: noBundles,
    uploads: 1,
    commands: [FIND, "channel set", FIND, BUILD],
  },
  // Only JavaScript changed, and the store has the build.
  "js-dry-run": {
    platforms: { android: { decision: "ota", outcome: "decided" } },
    builds: ["submitted"],
    releases: noBundles,
    uploads: 1,
    commands: [FIND],
  },
  "js-deployed": {
    platforms: { android: { decision: "ota", outcome: "deployed" } },
    builds: ["submitted"],
    releases: { android: 1, ios: 0 },
    uploads: 1,
    commands: [FIND, ...DEPLOY],
  },
  // A declared native input changed.
  "native-dry-run": {
    platforms: { android: { decision: "build", outcome: "decided" } },
    builds: ["submitted"],
    releases: { android: 1, ios: 0 },
    uploads: 1,
    commands: [FIND],
  },
  // The store has the version code: the native change didn't reach it. The
  // build stays tracked, and the new version code builds again.
  "native-refused": {
    platforms: { android: { decision: "build", outcome: "failed" } },
    fails: true,
    builds: ["submitted", "not submitted"],
    releases: { android: 1, ios: 0 },
    uploads: 1,
    commands: [FIND, "channel set", FIND, BUILD],
    newFingerprint: true,
  },
  "native-submitted": {
    platforms: { android: { decision: "build", outcome: "built" } },
    builds: ["submitted", "not submitted", "submitted"],
    releases: { android: 1, ios: 0 },
    uploads: 2,
    commands: [FIND, "channel set", FIND, BUILD],
    newFingerprint: true,
  },
  // The registry is down: no decision, so nothing runs.
  "lookup-fails": {
    platforms: { android: { decision: "none", outcome: "failed" } },
    fails: true,
    builds: ["submitted", "not submitted", "submitted"],
    releases: { android: 1, ios: 0 },
    uploads: 2,
    commands: [FIND],
    newFingerprint: true,
  },
  // iOS's lookup fails: Android still deploys, and the run fails.
  partial: {
    platforms: {
      android: { decision: "ota", outcome: "deployed" },
      ios: { decision: "none", outcome: "failed" },
    },
    fails: true,
    builds: ["submitted", "not submitted", "submitted"],
    releases: { android: 2, ios: 0 },
    uploads: 2,
    commands: [FIND, ...DEPLOY, FIND],
    newFingerprint: true,
  },
};

const stage = process.argv[2] ?? "";
const expected = STAGES[stage];
if (!expected) {
  throw new Error(
    `Run a stage: ${Object.keys(STAGES).join(", ")}, not "${stage}".`,
  );
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];

const artifactSha256 = async (storageUri: string) => {
  const { hostname: Bucket, pathname } = new URL(storageUri);
  const client = new S3Client({
    region: env("HOT_UPDATER_S3_REGION"),
    endpoint: env("HOT_UPDATER_S3_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: env("HOT_UPDATER_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("HOT_UPDATER_S3_SECRET_ACCESS_KEY"),
    },
  });
  const { Body } = await client.send(
    new GetObjectCommand({ Bucket, Key: pathname.slice(1) }),
  );
  const bytes = await Body?.transformToByteArray();
  if (!bytes) throw new Error(`${storageUri} has no contents.`);
  return createHash("sha256").update(bytes).digest("hex");
};

interface BuildRow {
  id: string;
  fingerprint_hash: string | null;
  artifact_storage_uri: string;
  submitted_to: string | null;
}

const db = new pg.Client({
  connectionString: env("HOT_UPDATER_DATABASE_URL"),
});
await db.connect();
try {
  // What the step and the action say.
  const outcome = env("PROOF_OUTCOME");
  check(
    outcome === (expected.fails ? "failure" : "success"),
    `the step's outcome is ${outcome}`,
  );
  const result = JSON.parse(env("PROOF_RESULT")) as {
    ok: boolean;
    platforms: {
      platform: string;
      decision: string;
      outcome: string;
      nativeBuildId: string | null;
      bundleId: string | null;
    }[];
  };
  check(result.ok === !expected.fails, `the result's ok is ${result.ok}`);
  const reported = Object.fromEntries(
    result.platforms.map((entry) => [entry.platform, entry]),
  );
  check(
    Object.keys(reported).length === Object.keys(expected.platforms).length,
    `the result has ${Object.keys(reported).join(", ")}`,
  );
  for (const [platform, want] of Object.entries(expected.platforms)) {
    check(
      reported[platform]?.decision === want.decision,
      `${platform} decided ${reported[platform]?.decision}, not ${want.decision}`,
    );
    check(
      reported[platform]?.outcome === want.outcome,
      `${platform} ended ${reported[platform]?.outcome}, not ${want.outcome}`,
    );
  }

  // The CLI commands that ran.
  const ran = lines(env("PROOF_COMMANDS"));
  check(
    ran.length === expected.commands.length &&
      expected.commands.every((command, i) => ran[i]?.startsWith(command)),
    `the commands that ran are:\n  ${ran.join("\n  ")}\nnot:\n  ${expected.commands.join("\n  ")}`,
  );

  // Hot Updater's registry.
  const { rows: builds } = await db.query<BuildRow>(
    `select id, fingerprint_hash, artifact_storage_uri, submitted_to
       from native_builds where platform = 'android' order by id`,
  );
  const states = builds.map((build) =>
    build.submitted_to === "play-internal" ? "submitted" : "not submitted",
  );
  check(
    states.join() === expected.builds.join(),
    `the tracked builds are [${states.join(", ")}], not [${expected.builds.join(", ")}]`,
  );
  if (expected.newFingerprint) {
    check(
      builds[0]?.fingerprint_hash !== builds[1]?.fingerprint_hash,
      "the second build has the first build's fingerprint",
    );
  }

  // The channel's bundles, which target the newest build's fingerprint.
  const { rows: releases } = await db.query<{
    id: string;
    platform: string;
    enabled: boolean;
    fingerprint_hash: string | null;
  }>(
    `select r.id, r.platform, r.enabled, r.fingerprint_hash
       from releases r join channels c on c.id = r.channel_id
      where c.name = $1 order by r.id`,
    [env("PROOF_CHANNEL")],
  );
  for (const platform of ["android", "ios"] as const) {
    const count = releases.filter((r) => r.platform === platform).length;
    check(
      count === expected.releases[platform],
      `${count} ${platform} bundles, not ${expected.releases[platform]}`,
    );
  }
  // A bundle this run deployed reaches the newest build.
  if (expected.platforms["android"]?.outcome === "deployed") {
    const newest = releases.filter((r) => r.platform === "android").at(-1);
    const target = builds.at(-1);
    check(newest?.enabled === true, `bundle ${newest?.id} is not enabled`);
    check(
      newest?.fingerprint_hash === target?.fingerprint_hash,
      `bundle ${newest?.id} targets ${newest?.fingerprint_hash}, not the build's ${target?.fingerprint_hash}`,
    );
    check(
      reported["android"]?.bundleId === newest?.id,
      `the result names bundle ${reported["android"]?.bundleId}, not ${newest?.id}`,
    );
  }

  // The store's own record: what it took is what Hot Updater tracked.
  const uploads = lines(env("PROOF_PLAY_LOG")).map(
    (line) => JSON.parse(line) as { sha256: string },
  );
  check(
    uploads.length === expected.uploads,
    `the store took ${uploads.length} uploads, not ${expected.uploads}`,
  );
  const submitted = builds.filter((build) => build.submitted_to !== null);
  for (const [i, upload] of uploads.entries()) {
    const build = submitted[i];
    if (!build) continue;
    const stored = await artifactSha256(build.artifact_storage_uri);
    check(
      stored === upload.sha256,
      `upload ${i} is ${upload.sha256}, but build ${build.id}'s artifact is ${stored}`,
    );
  }
} finally {
  await db.end();
}

if (failures.length > 0) {
  console.error(`release proof: ${stage} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
writeFileSync(env("PROOF_COMMANDS"), "");
console.log(`release proof: ${stage} passed`);
