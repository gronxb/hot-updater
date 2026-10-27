/**
 * The preview action's CI proof: what each run of the action must have left
 * in the backend, read from Postgres and MinIO directly, never from the
 * action's own output, which is only checked against them.
 *
 *   node proof.ts create-bucket
 *   node proof.ts <built|reused|rebuilt|closed>
 *
 * The stages run in order, after the action's runs: built after the first
 * (no native build: build, register, deploy), reused after the second (the
 * same native fingerprint: deploy only), rebuilt after a native input
 * changed (build again), closed after the cleanup. Each reads
 * PROOF_CHANNEL, the pull request's channel, which its native builds embed,
 * PROOF_PLATFORM, PROOF_COMMENT, the comment the run rendered,
 * PROOF_CONSOLE_URL, and PROOF_STATE, a file that carries what one stage saw
 * to the next.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const s3 = () =>
  new S3Client({
    region: env("HOT_UPDATER_S3_REGION"),
    endpoint: env("HOT_UPDATER_S3_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: env("HOT_UPDATER_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("HOT_UPDATER_S3_SECRET_ACCESS_KEY"),
    },
  });

interface NativeBuild {
  id: string;
  channel: string;
  fingerprint_hash: string | null;
  min_bundle_id: string;
  artifact_storage_uri: string;
  byte_size: string;
}

interface Release {
  id: string;
  enabled: boolean;
  fingerprint_hash: string | null;
  manifest_file_hash: string | null;
}

interface State {
  firstBuildId?: string;
  /** Every native build's built-in bundle, which its deletion takes along. */
  builtInBundleIds?: string[];
  firstFingerprint?: string | null;
  channelId?: string;
  releaseIds?: string[];
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const nativeBuilds = async (db: pg.Pool, platform: string) =>
  (
    await db.query<NativeBuild>(
      `select nb.id, c.name as channel, nb.fingerprint_hash, nb.min_bundle_id,
              nb.artifact_storage_uri, nb.byte_size
         from native_builds nb join channels c on c.id = nb.channel_id
        where nb.platform = $1 order by nb.id`,
      [platform],
    )
  ).rows;

const releases = async (db: pg.Pool, channel: string, platform: string) =>
  (
    await db.query<Release>(
      `select r.id, r.enabled, r.fingerprint_hash, b.manifest_file_hash
         from releases r
         join channels c on c.id = r.channel_id
         left join bundles b on b.id = r.bundle_id
        where c.name = $1 and r.platform = $2 order by r.id`,
      [channel, platform],
    )
  ).rows;

/** The artifacts stored under native-builds/<platform>/, by key. */
const storedArtifacts = async (platform: string) => {
  const keys: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: env("HOT_UPDATER_S3_BUCKET_NAME"),
        Prefix: `native-builds/${platform}/`,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      keys.push({ key: object.Key!, size: object.Size ?? 0 });
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
};

/** The native build's artifact is stored, at its size. */
const checkArtifact = (
  build: NativeBuild,
  artifacts: { key: string; size: number }[],
) => {
  const stored = artifacts.find(({ key }) =>
    build.artifact_storage_uri.endsWith(`/${key}`),
  );
  check(
    stored !== undefined,
    `native build ${build.id}'s artifact ${build.artifact_storage_uri} is not in storage`,
  );
  check(
    stored?.size === Number(build.byte_size) && Number(build.byte_size) > 0,
    `native build ${build.id}'s stored artifact is ${stored?.size} bytes, its row says ${build.byte_size}`,
  );
};

/** The newest release is enabled, signed, and reaches the build. */
const checkRelease = (release: Release | undefined, build: NativeBuild) => {
  check(release !== undefined, "no release on the pull request's channel");
  if (!release) return;
  check(release.enabled, `release ${release.id} is disabled`);
  check(
    release.fingerprint_hash === build.fingerprint_hash,
    `release ${release.id} targets ${release.fingerprint_hash}, the native build ${build.id} has ${build.fingerprint_hash}`,
  );
  // The seed's key signed it: a signed bundle's manifest hash is `sig:...`.
  check(
    release.manifest_file_hash?.startsWith("sig:") === true,
    `release ${release.id}'s bundle is not signed: ${release.manifest_file_hash}`,
  );
};

const checkComment = async (
  comment: string,
  expected: { buildId: string; built: boolean; releaseId: string },
) => {
  const consoleUrl = env("PROOF_CONSOLE_URL").replace(/\/+$/, "");
  // The comment shows the APK's QR code exactly when the Console serves it
  // to the runner under its own address, as the proof asks the Console here
  // rather than the action: a public Console serves it, and a local one,
  // whose per-run session guards every route, as this job's does, doesn't.
  const qr = `${consoleUrl}/_hot-updater/native-builds/qr?build=${expected.buildId}`;
  const response = await fetch(qr, { method: "HEAD" });
  const served =
    response.ok &&
    response.headers.get("x-hot-updater-download-url") ===
      `${consoleUrl}/api/native-builds/${expected.buildId}/download`;
  check(
    comment.includes(`<img src="${qr}"`) === served,
    served
      ? `the Console serves the QR code ${qr}, but the comment doesn't show it:\n${comment}`
      : `the Console answers ${response.status} to ${qr}, but the comment shows it:\n${comment}`,
  );
  check(
    !/hot-updater\/channel\/|openurl|am start/.test(comment),
    `the comment has a channel link:\n${comment}`,
  );
  const link = `[Download](${consoleUrl}/api/native-builds/${expected.buildId}/download) · [Details](${consoleUrl}/native-builds/${expected.buildId}) · ${expected.built ? "built for this commit" : "reused"}`;
  check(
    comment.includes(link),
    `the comment doesn't have ${link}:\n${comment}`,
  );
  check(
    comment.includes(`\`${expected.releaseId}\``),
    `the comment doesn't name bundle ${expected.releaseId}`,
  );
};

const [stage] = process.argv.slice(2);

if (stage === "create-bucket") {
  await s3().send(
    new CreateBucketCommand({ Bucket: env("HOT_UPDATER_S3_BUCKET_NAME") }),
  );
  process.exit(0);
}

const platform = process.env["PROOF_PLATFORM"] ?? "android";
const channel = env("PROOF_CHANNEL");
const statePath = env("PROOF_STATE");
const state: State = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const comment = env("PROOF_COMMENT");
const db = new pg.Pool({ connectionString: env("HOT_UPDATER_DATABASE_URL") });

try {
  const builds = await nativeBuilds(db, platform);
  const artifacts = await storedArtifacts(platform);
  const onChannel = await releases(db, channel, platform);
  const newestRelease = onChannel.at(-1);

  switch (stage) {
    case "built": {
      // No build had the fingerprint: one was built and registered.
      check(builds.length === 1, `${builds.length} native builds, not 1`);
      const [build] = builds;
      if (!build) break;
      check(
        build.channel === channel,
        `the native build embeds ${build.channel}, not the pull request's ${channel}`,
      );
      check(artifacts.length === 1, `${artifacts.length} artifacts, not 1`);
      checkArtifact(build, artifacts);
      check(onChannel.length === 1, `${onChannel.length} releases, not 1`);
      checkRelease(newestRelease, build);
      await checkComment(comment, {
        buildId: build.id,
        built: true,
        releaseId: newestRelease?.id ?? "",
      });
      state.firstBuildId = build.id;
      state.firstFingerprint = build.fingerprint_hash;
      break;
    }
    case "reused": {
      // The same fingerprint: no build, no upload, one more release.
      check(
        builds.length === 1 && builds[0]?.id === state.firstBuildId,
        `native builds are ${builds.map(({ id }) => id).join(", ")}, not only ${state.firstBuildId}`,
      );
      check(artifacts.length === 1, `${artifacts.length} artifacts, not 1`);
      check(onChannel.length === 2, `${onChannel.length} releases, not 2`);
      check(
        newestRelease?.id !== state.releaseIds?.at(-1),
        "no new release on the pull request's channel",
      );
      if (builds[0]) checkRelease(newestRelease, builds[0]);
      await checkComment(comment, {
        buildId: state.firstBuildId ?? "",
        built: false,
        releaseId: newestRelease?.id ?? "",
      });
      check(
        !comment.includes("built for this commit"),
        "the comment says it built a native build",
      );
      break;
    }
    case "rebuilt": {
      // A native input changed the fingerprint: a second build.
      check(builds.length === 2, `${builds.length} native builds, not 2`);
      const build = builds.at(-1);
      if (!build) break;
      check(build.id !== state.firstBuildId, "the newest build is the first");
      check(
        build.fingerprint_hash !== state.firstFingerprint,
        `the second build has the first build's fingerprint ${build.fingerprint_hash}`,
      );
      check(
        build.channel === channel,
        `the native build embeds ${build.channel}, not the pull request's ${channel}`,
      );
      check(artifacts.length === 2, `${artifacts.length} artifacts, not 2`);
      checkArtifact(build, artifacts);
      check(onChannel.length === 3, `${onChannel.length} releases, not 3`);
      checkRelease(newestRelease, build);
      await checkComment(comment, {
        buildId: build.id,
        built: true,
        releaseId: newestRelease?.id ?? "",
      });
      break;
    }
    case "closed": {
      // The channel, its bundles, and both of its native builds with their
      // artifacts are gone.
      const channels = (
        await db.query<{ id: string; name: string }>(
          "select id, name from channels",
        )
      ).rows;
      check(
        !channels.some(({ name }) => name === channel),
        `the ${channel} channel is still there`,
      );
      const left = (
        await db.query(
          "select id from releases where channel_id = $1 or id = any($2)",
          [state.channelId, state.releaseIds ?? []],
        )
      ).rows;
      check(left.length === 0, `${left.length} of the channel's releases left`);
      check(builds.length === 0, `${builds.length} native builds left`);
      check(artifacts.length === 0, `${artifacts.length} artifacts left`);
      const bundleRows = (
        await db.query("select id from bundles where id = any($1)", [
          state.builtInBundleIds ?? [],
        ])
      ).rows;
      check(
        bundleRows.length === 0,
        `${bundleRows.length} built-in bundles left`,
      );
      check(
        comment.includes(
          `its channel \`${channel}\`, its ${state.releaseIds?.length} bundles, and its 2 native builds are deleted.`,
        ),
        `the comment doesn't say the channel, its ${state.releaseIds?.length} bundles, and its 2 native builds are deleted:\n${comment}`,
      );
      break;
    }
    default:
      throw new Error(`Unknown stage ${stage}.`);
  }

  if (stage !== "closed") {
    state.releaseIds = onChannel.map(({ id }) => id);
    state.builtInBundleIds = builds.map(({ min_bundle_id }) => min_bundle_id);
    state.channelId = (
      await db.query<{ id: string }>(
        "select id from channels where name = $1",
        [channel],
      )
    ).rows[0]?.id;
  }
} finally {
  await db.end();
}

if (failures.length > 0) {
  console.error(`The ${stage} proof failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
writeFileSync(statePath, JSON.stringify(state));
console.log(`The ${stage} proof passed.`);
