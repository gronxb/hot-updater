/**
 * The preview action's store proof. What must happen in each stage is written
 * down here by hand, never taken from the action's code, and checked against
 * what happened: Postgres, the stored artifact's own manifest, the fake store's
 * record of what it took, and the CLI commands that ran.
 *
 *   node preview-store-proof.ts <stage>
 *
 * It reads PROOF_OUTCOME, the step's outcome, PROOF_COMMANDS
 * (scripts/record-cli.mjs), PROOF_PLAY_LOG (scripts/fake-play.mjs), and the
 * action's PROOF_COMMENT, PROOF_STORE_URL, PROOF_STORE_STATE and
 * PROOF_INSTALL_URL. A stage that passes empties the command log, so the next
 * stage sees only its own run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

interface Stage {
  readonly fails: boolean;
  /** The commands that must run, by their first words, in order. */
  readonly commands: readonly string[];
  /** A command must carry these, on the line that starts with its key. */
  readonly commandHolds?: Readonly<Record<string, readonly string[]>>;
  /** The version codes the store holds, in order. */
  readonly storeCodes: readonly number[];
  /** Tracked builds, oldest first, by the version code each reached the store as. */
  readonly builds: readonly number[];
  /** Bundles on a channel, by its name; null for a deleted channel. */
  readonly channels: Readonly<Record<string, number | null>>;
  /** Whether a store build's comment and outputs must be checked. */
  readonly comment?: "built for this commit" | "reused";
}

const BUILD =
  "native-build android --scheme sandboxStore --submit play-internal";
const FIND =
  "native-build find -p android -s sandboxStore --store-status --json";
const AFTER_BUILD = ["deploy", "bundle list", "native-build find"];

const stages: Readonly<Record<string, Stage>> = {
  "refused-track": {
    fails: true,
    commands: [],
    storeCodes: [41],
    builds: [],
    channels: { "pr-1": null },
  },
  "refused-normal": {
    fails: true,
    commands: [
      "channel set pr-1",
      "native-build find -p android -s release --store-status --json",
    ],
    storeCodes: [41],
    builds: [],
    channels: { "pr-1": null },
  },
  uploaded: {
    fails: false,
    commands: ["channel set pr-1", FIND, BUILD, ...AFTER_BUILD],
    storeCodes: [41, 42],
    builds: [42],
    channels: { "pr-1": 1 },
    comment: "built for this commit",
  },
  reused: {
    fails: false,
    commands: ["channel set pr-2", FIND, "fingerprint create", ...AFTER_BUILD],
    storeCodes: [41, 42],
    builds: [42],
    channels: { "pr-1": 1, "pr-2": 1 },
    comment: "reused",
  },
  closed: {
    fails: false,
    commands: ["channel delete pr-1"],
    storeCodes: [41, 42],
    builds: [42],
    channels: { "pr-1": null, "pr-2": 1 },
  },
  replaced: {
    fails: false,
    commands: ["channel set pr-2", FIND, BUILD, ...AFTER_BUILD],
    commandHolds: { [BUILD]: ["--no-cache"] },
    storeCodes: [41, 42, 43, 44],
    builds: [42, 44],
    channels: { "pr-2": 2 },
    comment: "built for this commit",
  },
};

const stageName = process.argv[2] ?? "";
const stage = stages[stageName];
if (!stage) throw new Error(`No stage ${stageName}.`);

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];

const aapt2 = () => {
  const sdk = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"];
  if (!sdk) throw new Error("ANDROID_HOME is not set.");
  const tools = path.join(sdk, "build-tools");
  const newest = readdirSync(tools).sort().at(-1);
  if (!newest) throw new Error(`${tools} has no build tools.`);
  return path.join(tools, newest, "aapt2");
};

/**
 * The stored artifact's digest, and what its own manifest and signature say,
 * read with the Android SDK's tools: nothing of the CLI's.
 */
const readArtifact = async (storageUri: string) => {
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "preview-store-proof-"));
  try {
    const aab = path.join(directory, "artifact.aab");
    writeFileSync(aab, bytes);
    // An .aab's base module, as the proto .apk aapt2 reads.
    execFileSync("unzip", [
      "-qo",
      aab,
      "base/manifest/AndroidManifest.xml",
      "base/resources.pb",
      "-d",
      directory,
    ]);
    const apk = path.join(directory, "base.apk");
    execFileSync("zip", [
      "-qj",
      apk,
      path.join(directory, "base/manifest/AndroidManifest.xml"),
      path.join(directory, "base/resources.pb"),
    ]);
    const manifest = execFileSync(
      aapt2(),
      ["dump", "xmltree", "--file", "AndroidManifest.xml", apk],
      { encoding: "utf8" },
    );
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      versionCode: Number(
        /android:versionCode\(0x0101021b\)="?(\d+)/.exec(manifest)?.[1],
      ),
      packageName: /package="([^"]+)"/.exec(manifest)?.[1],
      sandboxChannel: manifest.includes('"sandbox-sandboxStore"'),
      signer: execFileSync(
        "keytool",
        ["-J-Duser.language=en", "-printcert", "-jarfile", aab],
        { encoding: "utf8" },
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const outcome = env("PROOF_OUTCOME");
check(
  outcome === (stage.fails ? "failure" : "success"),
  `the step's outcome is ${outcome}`,
);

const ran = lines(env("PROOF_COMMANDS"));
check(
  ran.length === stage.commands.length &&
    stage.commands.every((command, i) => ran[i]?.startsWith(command)),
  `the commands that ran are:\n  ${ran.join("\n  ")}\nnot:\n  ${stage.commands.join("\n  ")}`,
);
for (const [command, words] of Object.entries(stage.commandHolds ?? {})) {
  const line = ran.find((entry) => entry.startsWith(command)) ?? "";
  for (const word of words) {
    check(line.includes(word), `${command} ran without ${word}: ${line}`);
  }
}

const store = lines(env("PROOF_PLAY_LOG")).map(
  (line) =>
    JSON.parse(line) as {
      versionCode?: number;
      sha256?: string;
      refused?: string;
    },
);
const taken = store.filter(({ refused }) => refused === undefined);
check(
  taken.map(({ versionCode }) => versionCode).join() ===
    stage.storeCodes.join(),
  `the store holds [${taken.map(({ versionCode }) => versionCode).join(", ")}], not [${stage.storeCodes.join(", ")}]`,
);
check(
  taken.length === store.length,
  `the store refused: ${store.flatMap(({ refused }) => refused ?? []).join(", ")}`,
);

const db = new pg.Client({ connectionString: env("HOT_UPDATER_DATABASE_URL") });
await db.connect();
try {
  const hasTable = await db.query<{ exists: boolean }>(
    "select to_regclass('public.native_builds') is not null as exists",
  );
  const { rows: builds } = hasTable.rows[0]?.exists
    ? await db.query<{
        id: string;
        channel: string;
        fingerprint_hash: string;
        artifact_storage_uri: string;
        submitted_to: string | null;
        submitted_version: string | null;
      }>(
        `select b.id, c.name as channel, b.fingerprint_hash,
                b.artifact_storage_uri, b.submitted_to, b.submitted_version
           from native_builds b join channels c on c.id = b.channel_id
          where b.platform = 'android' order by b.id`,
      )
    : { rows: [] };
  check(
    builds.length === stage.builds.length,
    `${builds.length} tracked builds, not ${stage.builds.length}`,
  );
  for (const [i, code] of stage.builds.entries()) {
    const build = builds[i];
    if (!build) continue;
    check(
      build.channel === "sandbox-sandboxStore",
      `build ${build.id} is on ${build.channel}, not the sandbox channel`,
    );
    check(
      build.submitted_to === "play-internal" &&
        build.submitted_version?.endsWith(`(${code})`) === true,
      `build ${build.id} records ${build.submitted_to} ${build.submitted_version}, not version code ${code}`,
    );
    const artifact = await readArtifact(build.artifact_storage_uri);
    check(
      artifact.versionCode === code,
      `build ${build.id}'s manifest says version code ${artifact.versionCode}, not ${code}`,
    );
    check(
      artifact.packageName === env("PROOF_PACKAGE"),
      `build ${build.id}'s manifest says package ${artifact.packageName}`,
    );
    check(
      artifact.signer.includes("CN=Native build proof"),
      `build ${build.id} isn't signed with the scheme's keystore`,
    );
    const upload = taken.find(({ versionCode }) => versionCode === code);
    check(
      upload?.sha256 === artifact.sha256,
      `the store's ${code} is ${upload?.sha256}, but the artifact is ${artifact.sha256}`,
    );
  }

  for (const [channel, count] of Object.entries(stage.channels)) {
    const { rows } = await db.query<{
      fingerprint_hash: string | null;
    }>(
      `select r.fingerprint_hash from releases r
         join channels c on c.id = r.channel_id
        where c.name = $1 and r.platform = 'android' order by r.id`,
      [channel],
    );
    const { rowCount } = await db.query(
      "select 1 from channels where name = $1",
      [channel],
    );
    if (count === null) {
      check(rowCount === 0, `channel ${channel} is still there`);
      continue;
    }
    check(
      rows.length === count,
      `${rows.length} bundles on ${channel}, not ${count}`,
    );
    check(
      rows.at(-1)?.fingerprint_hash === builds.at(-1)?.fingerprint_hash,
      `${channel}'s bundle targets ${rows.at(-1)?.fingerprint_hash}, not the build's ${builds.at(-1)?.fingerprint_hash}`,
    );
  }

  if (stage.comment) {
    const url = `https://play.google.com/apps/testing/${env("PROOF_PACKAGE")}`;
    const comment = env("PROOF_COMMENT");
    check(
      comment.includes(`](${url})`),
      `the comment has no ${url}:\n${comment}`,
    );
    check(
      comment.includes(stage.comment),
      `the comment doesn't say ${stage.comment}`,
    );
    check(
      comment.includes("ready to install"),
      `the comment doesn't say ready:\n${comment}`,
    );
    check(
      !comment.includes("/download)"),
      `the comment offers a download:\n${comment}`,
    );
    check(
      env("PROOF_STORE_URL") === url,
      `android-store-url is ${process.env["PROOF_STORE_URL"]}`,
    );
    check(
      env("PROOF_INSTALL_URL") === url,
      `android-install-url is ${process.env["PROOF_INSTALL_URL"]}`,
    );
    check(
      env("PROOF_STORE_STATE") === "ready",
      `android-store-state is ${process.env["PROOF_STORE_STATE"]}`,
    );
  }
} finally {
  await db.end();
}

if (failures.length > 0) {
  console.error(
    `preview store proof: ${stageName} failed:\n- ${failures.join("\n- ")}`,
  );
  process.exit(1);
}
writeFileSync(env("PROOF_COMMANDS"), "");
console.log(`preview store proof: ${stageName} passed`);
