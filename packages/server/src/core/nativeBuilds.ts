import {
  DatabaseConstraintError,
  isUUIDv7,
  type HotUpdaterCoreApi,
  type KeysetInput,
  type NativeBuildRegistration,
  type NativeBuildRow,
  type NativeBuildScope,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";

import { NATIVE_BUILD_SUBMISSION_DESTINATIONS } from "./nativeBuildDestinations";
import { after, type CoreDatabase } from "./reads";
import { insertChannel, type CoreTransaction } from "./writes";

/** The artifacts each platform's build produces. */
const ARTIFACT_KINDS = {
  android: ["apk", "aab"],
  ios: ["ipa", "app"],
} as const satisfies Record<NativeBuildRow["platform"], readonly string[]>;

/** `native_builds.scope_key`'s bound in core's schema. */
const SCOPE_KEY_MAX_LENGTH = 2048;

/** The `git_commit_hash` bound of `bundles` and `native_builds`. */
const GIT_COMMIT_HASH_MAX_LENGTH = 255;

/**
 * A native build key: `nbk1:` and a SHA-256, as the CLI computes it. The
 * format is the CLI's convention, implemented here so the registry stores
 * and looks up nothing else.
 */
const BUILD_KEY = /^nbk1:[0-9a-f]{64}$/;

/** `native_builds.sandbox_url_scheme`'s bound in core's schema. */
const SANDBOX_URL_SCHEME_MAX_LENGTH = 255;

/**
 * A URL scheme as RFC 3986 spells it, in lower case: what a sandbox build's
 * artifact registers, as `@hot-updater/protocol/native-artifact` reads it.
 */
const URL_SCHEME = new RegExp(
  `^[a-z][a-z0-9+.-]{0,${SANDBOX_URL_SCHEME_MAX_LENGTH - 1}}$`,
);

/** A native build or scope core cannot store or look up: the caller's input. */
export class NativeBuildInputError extends TypeError {
  override readonly name = "NativeBuildInputError";
}

const pick = (row: Readonly<Record<string, unknown>>): NativeBuildRow => ({
  id: row.id as string,
  scope_key: row.scope_key as string,
  platform: row.platform as NativeBuildRow["platform"],
  channel_id: row.channel_id as string,
  fingerprint_hash: (row.fingerprint_hash ?? null) as string | null,
  app_version: (row.app_version ?? null) as string | null,
  min_bundle_id: row.min_bundle_id as string,
  artifact_kind: row.artifact_kind as NativeBuildRow["artifact_kind"],
  artifact_storage_uri: row.artifact_storage_uri as string,
  byte_size: row.byte_size as number,
  git_commit_hash: (row.git_commit_hash ?? null) as string | null,
  created_at_ms: row.created_at_ms as number,
  build_key: (row.build_key ?? null) as string | null,
  build_number: (row.build_number ?? null) as string | null,
  submitted_to: (row.submitted_to ?? null) as NativeBuildRow["submitted_to"],
  submitted_at_ms: (row.submitted_at_ms ?? null) as number | null,
  submitted_version: (row.submitted_version ?? null) as string | null,
  // A key-value or document row written before a boolean column lacks it.
  is_store_build: row.is_store_build === true,
  is_sandbox: row.is_sandbox === true,
  sandbox_url_scheme: (row.sandbox_url_scheme ?? null) as string | null,
  export_method: (row.export_method ?? null) as NativeBuildRow["export_method"],
});

/** The export methods an `.ipa` registers with. */
const EXPORT_METHODS: ReadonlySet<string> = new Set([
  "app-store",
  "ad-hoc",
  "development",
  "enterprise",
] satisfies NonNullable<NativeBuildRow["export_method"]>[]);

/**
 * The channels only sandbox builds register on: a registration's `sandbox`
 * must agree with it. The registry's convention, as
 * `@hot-updater/protocol/native-artifact` checks it for a build's artifact.
 */
const SANDBOX_CHANNEL_PREFIX = "sandbox-";

/**
 * How many older builds of a scope one read takes, looking for one older than
 * a bundle when a build made after the bundle is the newest.
 */
const OLDER_BUILDS_PAGE = 20;

/** How many times a mark runs again after losing its scope's mark to another. */
const MARK_ATTEMPTS = 8;

/** `native_builds.build_number`'s bound in core's schema. */
const BUILD_NUMBER_MAX_LENGTH = 64;

/** `native_builds.submitted_version`'s bound in core's schema. */
const SUBMITTED_VERSION_MAX_LENGTH = 255;

/**
 * A native build scope's key: the Release Catalog scope key of a
 * fingerprint, or of the app-version strategy followed by the exact app
 * version the build compiled in. One key serves both strategies, so one
 * index finds the newest build of either.
 */
export const nativeBuildScopeKey = (scope: NativeBuildScope): string => {
  let scopeKey: string;
  try {
    const channelKey = encodeChannelKey(scope.channel);
    scopeKey =
      scope.fingerprintHash === null
        ? `${createReleaseCatalogScopeKey({
            channelKey,
            platform: scope.platform,
            strategy: "APP_VERSION",
          })}:${encodeURIComponent(scope.appVersion)}`
        : createReleaseCatalogScopeKey({
            channelKey,
            fingerprintHash: scope.fingerprintHash,
            platform: scope.platform,
            strategy: "FINGERPRINT",
          });
  } catch (error) {
    throw new NativeBuildInputError(
      `Invalid native build scope: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (scopeKey.length > SCOPE_KEY_MAX_LENGTH) {
    throw new NativeBuildInputError(
      `Invalid native build scope: its key is longer than ${SCOPE_KEY_MAX_LENGTH} characters; shorten the channel or app version.`,
    );
  }
  return scopeKey;
};

/** The ID of the channel row a distribution path names. */
const nativeBuildChannelId = (channel: string): string => {
  try {
    return `channel:${encodeChannelKey(channel)}`;
  } catch (error) {
    throw new NativeBuildInputError(
      `Invalid distribution path: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
};

/** Whether `bundleId` is a native build's built-in bundle: one unique read. */
export const isBuiltInBundle = async (
  db: Pick<CoreDatabase | CoreTransaction, "findOne">,
  bundleId: string,
): Promise<boolean> =>
  (await db.findOne("native_builds", { min_bundle_id: bundleId })) !== null;

const problemOf = ({
  id,
  minBundleId,
  platform,
  channel,
  fingerprintHash,
  appVersion,
  gitCommitHash,
  buildKey,
  buildNumber,
  isSandbox,
  sandboxUrlScheme,
  exportMethod,
  artifact,
}: NativeBuildRegistration): string | null => {
  if (!isUUIDv7(id)) return "id must be a UUIDv7";
  // A debug build's nil UUID is no UUIDv7: it has no built-in bundle.
  if (!isUUIDv7(minBundleId)) {
    return "minBundleId must be the UUIDv7 a release build compiles in";
  }
  if (platform !== "ios" && platform !== "android") {
    return "platform must be ios or android";
  }
  if (channel.trim().length === 0) return "channel is required";
  if (isSandbox !== undefined && typeof isSandbox !== "boolean") {
    return "isSandbox must be true or false";
  }
  const reserved = channel.startsWith(SANDBOX_CHANNEL_PREFIX);
  if (isSandbox === true && !reserved) {
    return `a sandbox build registers on a ${SANDBOX_CHANNEL_PREFIX}* channel, not ${channel}`;
  }
  if (isSandbox !== true && reserved) {
    return `channel ${channel} is reserved for sandbox builds`;
  }
  if (sandboxUrlScheme !== undefined && sandboxUrlScheme !== null) {
    if (isSandbox !== true) {
      return "sandboxUrlScheme is a sandbox build's, and this isn't one";
    }
    if (
      typeof sandboxUrlScheme !== "string" ||
      !URL_SCHEME.test(sandboxUrlScheme)
    ) {
      return `sandboxUrlScheme must be a URL scheme in lower case, up to ${SANDBOX_URL_SCHEME_MAX_LENGTH} characters, or null`;
    }
  }
  if (
    gitCommitHash !== null &&
    gitCommitHash.length > GIT_COMMIT_HASH_MAX_LENGTH
  ) {
    return `gitCommitHash must be at most ${GIT_COMMIT_HASH_MAX_LENGTH} characters`;
  }
  if ((fingerprintHash === null) === (appVersion === null)) {
    return "exactly one of fingerprintHash and appVersion is required";
  }
  if (buildKey !== null && !BUILD_KEY.test(buildKey)) {
    return "buildKey must be nbk1: and a SHA-256, or null";
  }
  if (
    buildNumber !== undefined &&
    buildNumber !== null &&
    (buildNumber.trim().length === 0 ||
      buildNumber.length > BUILD_NUMBER_MAX_LENGTH)
  ) {
    return `buildNumber must be the artifact's build number, up to ${BUILD_NUMBER_MAX_LENGTH} characters, or null`;
  }
  const kinds: readonly string[] = ARTIFACT_KINDS[platform];
  if (!kinds.includes(artifact.kind)) {
    return `artifact.kind of an ${platform} build must be ${kinds.join(" or ")}`;
  }
  if (exportMethod !== undefined && exportMethod !== null) {
    if (artifact.kind !== "ipa") {
      return "exportMethod is an .ipa's, and this artifact isn't one";
    }
    if (!EXPORT_METHODS.has(exportMethod)) {
      return `exportMethod must be ${[...EXPORT_METHODS].join(", ")}, or null`;
    }
  }
  if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0) {
    return "artifact.byteSize must be a byte count";
  }
  return null;
};

/** The native build registry: core's `native_builds` and the built-in bundle rows. */
export const createNativeBuildApi = (
  db: CoreDatabase,
  { now = Date.now }: { readonly now?: () => number } = {},
): Pick<
  HotUpdaterCoreApi,
  | "registerNativeBuild"
  | "getNativeBuild"
  | "findNativeBuild"
  | "findNativeBuildOnPath"
  | "listNativeBuilds"
  | "deleteNativeBuild"
  | "recordNativeBuildSubmission"
  | "markNativeBuild"
> => ({
  async registerNativeBuild(registration) {
    const problem = problemOf(registration);
    if (problem !== null) {
      throw new NativeBuildInputError(`Invalid native build: ${problem}.`);
    }
    // The scope key checks the channel before it names a channel row.
    const scopeKey = nativeBuildScopeKey(registration);
    const channelId = `channel:${encodeChannelKey(registration.channel)}`;
    const { embeddedBundle } = registration;
    const row: NativeBuildRow = {
      id: registration.id,
      scope_key: scopeKey,
      platform: registration.platform,
      channel_id: channelId,
      fingerprint_hash: registration.fingerprintHash,
      app_version: registration.appVersion,
      min_bundle_id: registration.minBundleId,
      artifact_kind: registration.artifact.kind,
      artifact_storage_uri: registration.artifact.storageUri,
      byte_size: registration.artifact.byteSize,
      git_commit_hash: registration.gitCommitHash,
      created_at_ms: now(),
      build_key: registration.buildKey,
      build_number: registration.buildNumber ?? null,
      submitted_to: null,
      submitted_at_ms: null,
      submitted_version: null,
      is_store_build: false,
      is_sandbox: registration.isSandbox === true,
      sandbox_url_scheme: registration.sandboxUrlScheme ?? null,
      export_method: registration.exportMethod ?? null,
    };
    // A channel deleted between ensuring it and the write refuses the write
    // through `byChannel`'s root, so it runs again and ensures it anew.
    for (let attempt = 1; ; attempt += 1) {
      await insertChannel(db, { id: channelId, name: registration.channel });
      try {
        await db.transaction(async (tx) => {
          // The built-in bundle is no OTA bundle, so the bundle totals leave
          // it out: `deleteBundles` refuses it, so they never count it back.
          tx.create("bundles", {
            id: registration.minBundleId,
            platform: registration.platform,
            git_commit_hash: registration.gitCommitHash,
            metadata: embeddedBundle.metadata ?? {},
            manifest_storage_uri: embeddedBundle.manifestStorageUri,
            manifest_file_hash: embeddedBundle.manifestFileHash,
            asset_base_storage_uri: embeddedBundle.assetBaseStorageUri,
          });
          tx.create("native_builds", row);
        });
        break;
      } catch (error) {
        if (!(error instanceof DatabaseConstraintError)) throw error;
        if (error.reason === "exists" || error.reason === "unique") {
          throw new DatabaseConstraintError(error.reason, "native_builds");
        }
        if (
          attempt < 3 &&
          error.reason === "not_found" &&
          error.model === "channels"
        ) {
          continue;
        }
        throw error;
      }
    }
    return row;
  },

  async getNativeBuild(id) {
    const row = await db.findOne("native_builds", { id });
    return row === null ? null : pick(row);
  },

  async findNativeBuild(scope, options) {
    const scopeKey = nativeBuildScopeKey(scope);
    const buildKey = options?.buildKey;
    if (buildKey !== undefined && !BUILD_KEY.test(buildKey)) {
      throw new NativeBuildInputError(
        "Invalid native build key: it must be nbk1: and a SHA-256.",
      );
    }
    if (options?.storeBuild) {
      const marked = await db.findOne("native_builds", {
        store_build_scope_key: scopeKey,
      });
      return marked === null ? null : pick(marked);
    }
    // The scope's builds newest first, or with a build key its builds of that
    // key: the newest alone, or a page of those older than `before`.
    const read = (limit: number, before?: string) => {
      const page = {
        order: "desc" as const,
        limit,
        ...(before === undefined ? {} : { range: { lt: before } }),
      };
      return buildKey === undefined
        ? db.findMany("native_builds", {
            index: "byScope",
            where: { scope_key: scopeKey },
            ...page,
          })
        : db.findMany("native_builds", {
            index: "byBuildKey",
            where: { scope_key: scopeKey, build_key: buildKey },
            ...page,
          });
    };
    const { rows } = await read(1);
    const newest = rows[0];
    if (newest === undefined) return null;
    const bundleId = options?.builtInOlderThan;
    if (bundleId === undefined || newest.min_bundle_id < bundleId) {
      return pick(newest);
    }
    // A build made after the bundle can't take it. No index orders a scope by
    // its built-in bundles, so the older builds are read a page at a time
    // until one is older than the bundle, or the scope runs out: only when
    // the newest was made after the bundle.
    for (let before = newest.id; ; ) {
      const { rows: older } = await read(OLDER_BUILDS_PAGE, before);
      // oxlint-disable-next-line hot-updater/no-filtered-find-many -- no index selects builds by their built-in bundle; this path runs only past a build made after the bundle
      const usable = older.find(
        ({ min_bundle_id }) => min_bundle_id < bundleId,
      );
      if (usable !== undefined) return pick(usable);
      const last = older.at(-1);
      if (older.length < OLDER_BUILDS_PAGE || last === undefined) return null;
      before = last.id;
    }
  },

  async findNativeBuildOnPath(path) {
    const channelId = nativeBuildChannelId(path.channel);
    const { rows } = await db.findMany("native_builds", {
      index: "byDistributionPath",
      where: {
        channel_id: channelId,
        platform: path.platform,
        is_sandbox: path.sandbox,
        distribution: path.distribution,
      },
      order: "desc",
      limit: 1,
    });
    const newest = rows[0];
    return newest === undefined ? null : pick(newest);
  },

  async recordNativeBuildSubmission(id, { destination, version }) {
    if (
      version.trim().length === 0 ||
      version.length > SUBMITTED_VERSION_MAX_LENGTH
    ) {
      throw new NativeBuildInputError(
        `Invalid native build submission: version must be the store's label of the build, up to ${SUBMITTED_VERSION_MAX_LENGTH} characters.`,
      );
    }
    return db.transaction(async (tx) => {
      const row = await tx.findOne("native_builds", { id });
      if (row === null) return null;
      const build = pick(row);
      if (
        !(
          NATIVE_BUILD_SUBMISSION_DESTINATIONS[
            build.platform
          ] as readonly string[]
        ).includes(destination)
      ) {
        throw new NativeBuildInputError(
          `Invalid native build submission: an ${build.platform} build is submitted to ${NATIVE_BUILD_SUBMISSION_DESTINATIONS[build.platform].join(" or ")}, not ${destination}.`,
        );
      }
      if (
        build.is_sandbox &&
        destination !== "testflight" &&
        destination !== "play-internal"
      ) {
        throw new NativeBuildInputError(
          "A sandbox build can submit only to TestFlight or Play internal testing.",
        );
      }
      const set = {
        submitted_to: destination,
        submitted_at_ms: now(),
        submitted_version: version,
      };
      tx.update("native_builds", row, set);
      return { ...build, ...set };
    });
  },

  // The mark is `is_store_build`, and the engine derives the scope's one value
  // of a unique index from it, `store_build_scope_key`, so a store holds one
  // per scope whatever races it, and moving it frees and takes the value in
  // one write. A
  // holder this run read is guarded, so a mark that moved it reruns the write
  // through the engine. A scope with no holder has nothing to guard: two first
  // marks meet at the index, and the loser runs again, finding the winner.
  async markNativeBuild(id, { storeBuild }) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await db.transaction(async (tx) => {
          const row = await tx.findOne("native_builds", { id });
          if (row === null) return null;
          const build = pick(row);
          if (!storeBuild) {
            if (build.is_store_build) {
              tx.update("native_builds", row, { is_store_build: false });
            }
            return {
              nativeBuild: { ...build, is_store_build: false },
              previous: null,
            };
          }
          // No store sells a sandbox build: its record says so, whatever
          // its channel.
          if (build.is_sandbox) {
            throw new NativeBuildInputError(
              "A sandbox build can't be the store build.",
            );
          }
          if (build.is_store_build) {
            return { nativeBuild: build, previous: null };
          }
          const holder = await tx.findOne("native_builds", {
            store_build_scope_key: build.scope_key,
          });
          // First, so a store that checks a unique index per statement finds
          // the value free.
          if (holder !== null) {
            tx.update("native_builds", holder, { is_store_build: false });
          }
          tx.update("native_builds", row, { is_store_build: true });
          return {
            nativeBuild: { ...build, is_store_build: true },
            previous:
              holder === null
                ? null
                : { ...pick(holder), is_store_build: false },
          };
        });
      } catch (error) {
        if (
          attempt < MARK_ATTEMPTS &&
          error instanceof DatabaseConstraintError &&
          error.reason === "unique"
        ) {
          continue;
        }
        throw error;
      }
    }
  },

  async deleteNativeBuild(id) {
    return db.transaction(async (tx) => {
      const row = await tx.findOne("native_builds", { id });
      if (row === null) return { deleted: false, reason: "not_found" } as const;
      await tx.delete("native_builds", row);
      // The built-in bundle was never counted in the bundle totals, so it is
      // deleted without them; its patches cascade with it.
      const bundle = await tx.findOne("bundles", { id: row.min_bundle_id });
      if (bundle !== null) await tx.delete("bundles", bundle);
      return { deleted: true, nativeBuild: pick(row) } as const;
    });
  },

  async listNativeBuilds(input: KeysetInput & { channelId?: string }) {
    const page = { order: input.order ?? "asc", limit: input.limit };
    const { rows } =
      input.channelId === undefined
        ? await db.findMany("native_builds", {
            index: "all",
            where: {},
            ...page,
            ...after(input),
          })
        : await db.findMany("native_builds", {
            index: "byChannel",
            where: { channel_id: input.channelId },
            ...page,
            ...after(input),
          });
    return rows.map(pick);
  },
});
