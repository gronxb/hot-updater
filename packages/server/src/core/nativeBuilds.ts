import {
  DatabaseConstraintError,
  isUUIDv7,
  type HotUpdaterCoreApi,
  type KeysetInput,
  type NativeBuildDistribution,
  type NativeBuildRegistration,
  type NativeBuildRow,
  type NativeBuildSandboxScope,
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

/**
 * A bundle identifier or application ID, as an artifact reports it: letters,
 * digits, dots, dashes and underscores, which a scope key holds as they are.
 */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** A fingerprint hash as a Release Catalog scope key holds it. */
const FINGERPRINT_HASH = /^[A-Za-z0-9._~-]{1,255}$/;

/** How each kind of artifact can install. */
const DISTRIBUTIONS = {
  apk: ["direct"],
  app: ["direct"],
  aab: ["store"],
  ipa: ["direct", "store"],
} as const satisfies Record<
  NativeBuildRow["artifact_kind"],
  readonly NativeBuildDistribution[]
>;

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
  native_app_version: (row.native_app_version ?? null) as string | null,
});

/** The export methods an `.ipa` registers with. */
const EXPORT_METHODS: ReadonlySet<string> = new Set([
  "app-store",
  "ad-hoc",
  "development",
  "enterprise",
] satisfies NonNullable<NativeBuildRow["export_method"]>[]);

/**
 * How many older builds of a scope one read takes, looking for one older than
 * a bundle when a build made after the bundle is the newest.
 */
const OLDER_BUILDS_PAGE = 20;

/**
 * How many pages of older builds that look reads before it answers null: 100
 * builds made after the bundle in one scope, where a deploy's new bundle has
 * none or a few registered while it deploys.
 */
const OLDER_BUILDS_PAGES = 5;

/** How many times a mark runs again after losing its scope's mark to another. */
const MARK_ATTEMPTS = 8;

/** `native_builds.build_number`'s bound in core's schema. */
const BUILD_NUMBER_MAX_LENGTH = 64;

/** `native_builds.submitted_version`'s bound in core's schema. */
const SUBMITTED_VERSION_MAX_LENGTH = 255;

const checkedScopeKey = (scopeKey: string): string => {
  if (scopeKey.length > SCOPE_KEY_MAX_LENGTH) {
    throw new NativeBuildInputError(
      `Invalid native build scope: its key is longer than ${SCOPE_KEY_MAX_LENGTH} characters; shorten the channel or app version.`,
    );
  }
  return scopeKey;
};

/**
 * How a registered artifact installs: an `.ipa` by its export method, and
 * `unknown` for one whose export no profile confirmed, which no lookup asks
 * for, so it is never reused as either.
 */
const registeredDistribution = (
  kind: NativeBuildRow["artifact_kind"],
  exportMethod: NativeBuildRow["export_method"] | undefined,
): NativeBuildDistribution | "unknown" =>
  kind !== "ipa"
    ? DISTRIBUTIONS[kind][0]
    : exportMethod === undefined || exportMethod === null
      ? "unknown"
      : exportMethod === "app-store"
        ? "store"
        : "direct";

/**
 * A sandbox build scope's key, which names no channel: the app ID, URL
 * scheme, artifact kind and distribution in its place, then the fingerprint,
 * or the app-version strategy and the exact app version. `v1:sandbox:` is no
 * Release Catalog strategy, so it never meets a normal build's key.
 */
const sandboxScopeKey = (
  scope: Pick<NativeBuildScope, "platform" | "fingerprintHash" | "appVersion">,
  sandbox: Omit<NativeBuildSandboxScope, "distribution"> & {
    readonly distribution: NativeBuildDistribution | "unknown";
  },
): string => {
  const { appId, urlScheme, artifactKind, distribution } = sandbox;
  const problem =
    typeof appId !== "string" || !APP_ID.test(appId)
      ? "its app ID must be a bundle identifier or application ID, up to 255 characters"
      : typeof urlScheme !== "string" || !URL_SCHEME.test(urlScheme)
        ? `its URL scheme must be a URL scheme in lower case, up to ${SANDBOX_URL_SCHEME_MAX_LENGTH} characters`
        : !(
              ARTIFACT_KINDS[scope.platform] as readonly string[] | undefined
            )?.includes(artifactKind)
          ? `its artifact kind must be one an ${scope.platform} build makes`
          : distribution !== "unknown" &&
              !(DISTRIBUTIONS[artifactKind] as readonly string[]).includes(
                distribution,
              )
            ? `an .${artifactKind} doesn't install as ${String(distribution)}`
            : scope.fingerprintHash !== null &&
                !FINGERPRINT_HASH.test(scope.fingerprintHash)
              ? "its fingerprint hash must be 1-255 URL-safe ASCII characters"
              : null;
  if (problem !== null) {
    throw new NativeBuildInputError(`Invalid sandbox build scope: ${problem}.`);
  }
  const target =
    scope.fingerprintHash === null
      ? `app-version:${encodeURIComponent(scope.appVersion as string)}`
      : `fingerprint:${scope.fingerprintHash}`;
  return checkedScopeKey(
    `v1:sandbox:${scope.platform}:${appId}:${urlScheme}:${artifactKind}:${distribution}:${target}`,
  );
};

/**
 * A native build scope's key: the Release Catalog scope key of a
 * fingerprint, or of the app-version strategy followed by the exact app
 * version the build compiled in. One key serves both strategies, so one
 * index finds the newest build of either. A sandbox scope's key names no
 * channel, so pull requests find a sandbox build on any.
 */
export const nativeBuildScopeKey = (scope: NativeBuildScope): string => {
  const { sandbox } = scope;
  if (sandbox !== undefined && sandbox !== null) {
    if (sandbox.distribution !== "direct" && sandbox.distribution !== "store") {
      throw new NativeBuildInputError(
        "Invalid sandbox build scope: its distribution must be direct or store.",
      );
    }
    return sandboxScopeKey(scope, sandbox);
  }
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
  return checkedScopeKey(scopeKey);
};

/** The channel row a registration names, or the refusal of its channel. */
const channelIdOf = (channel: string): string => {
  try {
    return `channel:${encodeChannelKey(channel)}`;
  } catch (error) {
    throw new NativeBuildInputError(
      `Invalid native build scope: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
};

/**
 * A registration's scope key, from the registration's own facts: a sandbox
 * build's from what its artifact says, whatever `sandbox` it names.
 */
const registrationScopeKey = (registration: NativeBuildRegistration) => {
  // The channel is checked whatever the key: it names the channel row.
  channelIdOf(registration.channel);
  return registration.isSandbox === true
    ? sandboxScopeKey(registration, {
        appId: registration.sandboxAppId as string,
        urlScheme: registration.sandboxUrlScheme as string,
        artifactKind: registration.artifact.kind,
        distribution: registeredDistribution(
          registration.artifact.kind,
          registration.exportMethod,
        ),
      })
    : nativeBuildScopeKey({ ...registration, sandbox: null });
};

/**
 * Refuses a patch from a sandbox build's built-in bundle: no deploy patches
 * from one, so no store or test install of the app gets a patch made for a
 * sandbox build. One unique read of the base.
 */
export const refuseSandboxPatchBase = async (
  db: Pick<CoreDatabase | CoreTransaction, "findOne">,
  baseBundleId: string,
): Promise<void> => {
  const build = await db.findOne("native_builds", {
    min_bundle_id: baseBundleId,
  });
  if (build?.is_sandbox === true) {
    throw new NativeBuildInputError(
      "A sandbox build's built-in bundle is no patch base.",
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
  sandboxAppId,
  exportMethod,
  nativeAppVersion,
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
  if (sandboxAppId !== undefined && sandboxAppId !== null) {
    if (isSandbox !== true) {
      return "sandboxAppId is a sandbox build's, and this isn't one";
    }
    if (typeof sandboxAppId !== "string" || !APP_ID.test(sandboxAppId)) {
      return "sandboxAppId must be the artifact's bundle identifier or application ID, up to 255 characters";
    }
  }
  if (isSandbox === true) {
    // What its scope is made of in place of a channel.
    if (sandboxUrlScheme === undefined || sandboxUrlScheme === null) {
      return "a sandbox build needs the sandboxUrlScheme its artifact registers";
    }
    if (sandboxAppId === undefined || sandboxAppId === null) {
      // An older CLI sends none: it registers on a channel this server no
      // longer reserves, and only an upgrade fixes it.
      return "a sandbox build needs the sandboxAppId its artifact reports, which an older hot-updater CLI doesn't send. Upgrade the hot-updater CLI to the version that matches this server, and build again";
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
  if (
    nativeAppVersion !== undefined &&
    nativeAppVersion !== null &&
    (typeof nativeAppVersion !== "string" ||
      nativeAppVersion.trim().length === 0)
  ) {
    return "nativeAppVersion must be the artifact's app version, or null";
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

/** The other install target of an iOS sandbox build's native code. */
const SIBLING_KINDS: Partial<
  Record<NativeBuildRow["artifact_kind"], NativeBuildRow["artifact_kind"]>
> = { app: "ipa", ipa: "app" };

/**
 * Whether a build is one a person installs from its file: a Simulator `.app`,
 * or an `.ipa` exported for direct install, that no store took and that isn't
 * the store build. One rule for a sibling and the build it is found from, so
 * a build that shows its sibling is shown by it.
 */
const isInstallTarget = (
  build: Pick<
    NativeBuildRow,
    "artifact_kind" | "is_store_build" | "submitted_to" | "export_method"
  >,
): boolean =>
  !build.is_store_build &&
  build.submitted_to === null &&
  (build.artifact_kind === "app" ||
    (build.artifact_kind === "ipa" &&
      build.export_method !== null &&
      build.export_method !== "app-store"));

/**
 * The scope key of the other install target of a sandbox build, from its own
 * key's app ID and URL scheme, which hold no colon, and its row's fingerprint
 * or app version, through `sandboxScopeKey`; null for a key it didn't make.
 */
const siblingSandboxScopeKey = (
  build: Pick<
    NativeBuildRow,
    | "scope_key"
    | "platform"
    | "fingerprint_hash"
    | "app_version"
    | "artifact_kind"
    | "export_method"
  >,
  artifactKind: NativeBuildRow["artifact_kind"],
): string | null => {
  const [version, sandbox, platform, appId, urlScheme] =
    build.scope_key.split(":");
  if (
    version !== "v1" ||
    sandbox !== "sandbox" ||
    platform !== build.platform ||
    appId === undefined ||
    urlScheme === undefined
  ) {
    return null;
  }
  const target =
    build.fingerprint_hash === null
      ? {
          platform: build.platform,
          fingerprintHash: null,
          appVersion: build.app_version ?? "",
        }
      : {
          platform: build.platform,
          fingerprintHash: build.fingerprint_hash,
          appVersion: null,
        };
  try {
    const own = sandboxScopeKey(target, {
      appId,
      urlScheme,
      artifactKind: build.artifact_kind,
      distribution: registeredDistribution(
        build.artifact_kind,
        build.export_method,
      ),
    });
    return own === build.scope_key
      ? sandboxScopeKey(target, {
          appId,
          urlScheme,
          artifactKind,
          distribution: "direct",
        })
      : null;
  } catch {
    return null;
  }
};

/** The native build registry: core's `native_builds` and the built-in bundle rows. */
export const createNativeBuildApi = (
  db: CoreDatabase,
  { now = Date.now }: { readonly now?: () => number } = {},
): Pick<
  HotUpdaterCoreApi,
  | "registerNativeBuild"
  | "getNativeBuild"
  | "findNativeBuildByBuiltInBundle"
  | "findNativeBuild"
  | "findNativeBuildSibling"
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
    const scopeKey = registrationScopeKey(registration);
    const channelId = channelIdOf(registration.channel);
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
      native_app_version: registration.nativeAppVersion ?? null,
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

  async findNativeBuildByBuiltInBundle(bundleId) {
    const row = await db.findOne("native_builds", {
      min_bundle_id: bundleId,
    });
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
    const artifactKind = options?.artifactKind;
    if (
      artifactKind !== undefined &&
      !(ARTIFACT_KINDS[scope.platform] as readonly string[]).includes(
        artifactKind,
      )
    ) {
      throw new NativeBuildInputError(
        `Invalid native build kind: an ${scope.platform} build is ${ARTIFACT_KINDS[scope.platform].join(" or ")}.`,
      );
    }
    // `artifactKind` holds whatever it's combined with: a build key or a
    // mark names a build of one kind, and another kind is no build.
    const ofKind = (row: { readonly artifact_kind: unknown }) =>
      artifactKind === undefined || row.artifact_kind === artifactKind;
    if (options?.storeBuild) {
      const marked = await db.findOne("native_builds", {
        store_build_scope_key: scopeKey,
      });
      return marked === null || !ofKind(marked) ? null : pick(marked);
    }
    // The scope's builds newest first, or with a build key its builds of that
    // key: the newest alone, or a page of those older than `before`.
    const read = (limit: number, before?: string) => {
      const page = {
        order: "desc" as const,
        limit,
        ...(before === undefined ? {} : { range: { lt: before } }),
      };
      return buildKey !== undefined
        ? db.findMany("native_builds", {
            index: "byBuildKey",
            where: { scope_key: scopeKey, build_key: buildKey },
            ...page,
          })
        : artifactKind !== undefined
          ? db.findMany("native_builds", {
              index: "byScopeKind",
              where: { scope_key: scopeKey, artifact_kind: artifactKind },
              ...page,
            })
          : db.findMany("native_builds", {
              index: "byScope",
              where: { scope_key: scopeKey },
              ...page,
            });
    };
    const bundleId = options?.builtInOlderThan;
    // A deploy's patch base: never a sandbox build's built-in bundle, so a
    // sandbox scope has none, with no read.
    if (
      bundleId !== undefined &&
      scope.sandbox !== undefined &&
      scope.sandbox !== null
    ) {
      return null;
    }
    const { rows } = await read(1);
    const indexed = rows[0] === undefined ? undefined : pick(rows[0]);
    // A row written before `byScopeKind` is in `byScope` alone, on a store
    // that indexes rows as they are written: the scope's newest row stands
    // for it when it is of the kind.
    const newest =
      indexed ??
      (artifactKind !== undefined && buildKey === undefined
        ? await db
            .findMany("native_builds", {
              index: "byScope",
              where: { scope_key: scopeKey },
              order: "desc",
              limit: 1,
            })
            .then(({ rows: [row] }) =>
              row?.artifact_kind === artifactKind ? pick(row) : undefined,
            )
        : undefined);
    if (newest === undefined || !ofKind(newest)) return null;
    if (bundleId === undefined || newest.min_bundle_id < bundleId) {
      return newest;
    }
    // A build made after the bundle can't take it. No index orders a scope by
    // its built-in bundles in the order builds were registered, so the older
    // builds are read a page at a time until one is older than the bundle, the
    // scope runs out, or `OLDER_BUILDS_PAGES` pages had none: only when the
    // newest was made after the bundle.
    let before = newest.id;
    for (let page = 0; page < OLDER_BUILDS_PAGES; page += 1) {
      const { rows: older } = await read(OLDER_BUILDS_PAGE, before);
      // oxlint-disable-next-line hot-updater/no-filtered-find-many -- no index selects builds by their built-in bundle; this path runs only past a build made after the bundle, a bounded number of pages
      const usable = older.find(
        ({ min_bundle_id }) => min_bundle_id < bundleId,
      );
      if (usable !== undefined) return ofKind(usable) ? pick(usable) : null;
      const last = older.at(-1);
      if (older.length < OLDER_BUILDS_PAGE || last === undefined) return null;
      before = last.id;
    }
    return null;
  },

  async findNativeBuildSibling(build) {
    const artifactKind = SIBLING_KINDS[build.artifact_kind];
    if (
      build.platform !== "ios" ||
      !build.is_sandbox ||
      artifactKind === undefined ||
      !isInstallTarget(build)
    ) {
      return null;
    }
    const scopeKey = siblingSandboxScopeKey(build, artifactKind);
    if (scopeKey === null) return null;
    // The newest, so one rebuilt for a newly registered iPhone wins.
    const { rows } = await db.findMany("native_builds", {
      index: "byScope",
      where: { scope_key: scopeKey },
      order: "desc",
      limit: 1,
    });
    const sibling = rows[0] === undefined ? null : pick(rows[0]);
    return sibling !== null && isInstallTarget(sibling) ? sibling : null;
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
