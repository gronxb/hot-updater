import type {
  ReleaseCatalogMutationPreflight,
  ReleaseCatalogMutationResult,
  ReleaseCatalogRebuildPreflight,
  ReleaseCatalogRebuildResult,
} from "./releaseCatalogMutation";
import type {
  PromoteReleaseResult,
  ReleasePolicyPatch,
} from "./releaseManagement";
import type {
  Bundle,
  BundlePatchRow,
  BundleRow,
  ChannelDeleteResult,
  ChannelRow,
  DatabaseBundleMetadata,
  NativeBuildArtifactKind,
  NativeBuildDeleteResult,
  NativeBuildRow,
  NativeBuildSubmissionDestination,
  Platform,
  ReleaseCatalogRow,
  ReleaseRow,
} from "./types";

/** A keyset page: rows strictly after `after`, in `order`, at most `limit`. */
export interface KeysetInput {
  readonly order?: "asc" | "desc";
  /** The last key a previous page returned. */
  readonly after?: string;
  readonly limit: number;
}

/** A release list's filter: exactly the sets the release indexes serve. */
export type ReleaseFilter =
  | { readonly kind: "all" }
  | {
      readonly kind: "channelPlatform";
      readonly channelId: string;
      readonly platform: "ios" | "android";
      readonly enabled?: boolean;
    }
  | { readonly kind: "bundle"; readonly bundleId: string }
  | {
      readonly kind: "scope";
      readonly scopeKey: string;
      readonly enabled?: boolean;
    };

export interface BundleDetail {
  readonly bundle: BundleRow;
  readonly patches: BundlePatchRow[];
  /** Patches that start from this bundle. */
  readonly childCount: number;
}

/** How a deploy publishes its bundle in one channel's catalog. */
export interface DeployReleasePolicy {
  readonly channel: string;
  readonly enabled: boolean;
  readonly fingerprintHash: string | null;
  readonly message: string | null;
  readonly rolloutCohortCount?: number;
  readonly shouldForceUpdate: boolean;
  readonly targetAppVersion: string | null;
  readonly targetCohorts?: string[];
}

/** A new bundle and the release that publishes it. */
export interface BundleDeployment {
  readonly bundle: Bundle;
  readonly release: DeployReleasePolicy;
}

/** A new release for a bundle the database already holds, such as a republish. */
export interface StoredBundleDeployment {
  readonly bundleId: string;
  readonly release: DeployReleasePolicy;
}

export type Deployment = BundleDeployment | StoredBundleDeployment;

/**
 * A native build's scope: its platform, the default channel it compiled in,
 * and whichever of the fingerprint and the app version the update strategy
 * selects by.
 */
export type NativeBuildScope = {
  readonly platform: Platform;
  readonly channel: string;
} & (
  | { readonly fingerprintHash: string; readonly appVersion: null }
  | { readonly fingerprintHash: null; readonly appVersion: string }
);

/** A native build to register: its stored artifact and its built-in bundle. */
export type NativeBuildRegistration = NativeBuildScope & {
  /** A UUIDv7, which also names the artifact's storage directory. */
  readonly id: string;
  /** The MIN_BUNDLE_ID the build compiled in: the built-in bundle's ID. */
  readonly minBundleId: string;
  readonly gitCommitHash: string | null;
  /**
   * The native build key of every input the artifact was built from:
   * `nbk1:` and a SHA-256. A build with the same key reuses this one. Null
   * for a build whose inputs no key covers, which is never reused.
   */
  readonly buildKey: string | null;
  readonly artifact: {
    readonly kind: NativeBuildArtifactKind;
    readonly storageUri: string;
    readonly byteSize: number;
  };
  /**
   * The built-in bundle as deploy stores a bundle, with a manifest that
   * lists only its JavaScript bundle file, taken from the artifact.
   */
  readonly embeddedBundle: {
    readonly manifestStorageUri: string;
    readonly manifestFileHash: string;
    readonly assetBaseStorageUri: string;
    readonly metadata?: DatabaseBundleMetadata;
  };
};

export interface ReleaseTarget {
  readonly releaseId: string;
  /** Refuses the change when the release is at another revision. */
  readonly expectedRevision?: number;
}

/**
 * Core's reads and typed operations, the same in process and over the admin
 * API: bundles, Releases, their Catalogs, and channels. Every read goes
 * through a declared index, and lists page by key.
 */
export interface HotUpdaterCoreApi {
  /**
   * Checks the database before a command changes anything: its schema, and a
   * self-hosted server's admin protocol. Throws what the first read would.
   */
  ready(): Promise<void>;
  getBundle(id: string): Promise<BundleDetail | null>;
  listBundles(
    input: KeysetInput & { readonly platform?: "ios" | "android" },
  ): Promise<BundleDetail[]>;
  /** One counter row: every bundle, or one platform's. */
  countBundles(platform?: "ios" | "android"): Promise<number>;
  listPatchesFromBase(
    baseBundleId: string,
    input: KeysetInput,
  ): Promise<BundlePatchRow[]>;
  /** Each base bundle's child count, from its reference counter: one batch read of the bundle rows. */
  countBundleChildren(
    baseBundleIds: readonly string[],
  ): Promise<Record<string, number>>;
  /**
   * Auto-patch bases for a new bundle, from its candidate key's catalog
   * scope: older bundles whose enabled releases serve the key's fingerprint,
   * or a range intersecting its app version range; newest release first.
   */
  findBaseBundleIds(
    candidateKey: string,
    bundleId: string,
    limit: number,
  ): Promise<string[]>;
  getRelease(id: string): Promise<ReleaseRow | null>;
  listReleases(
    input: KeysetInput & { readonly filter: ReleaseFilter },
  ): Promise<ReleaseRow[]>;
  getReleaseCatalogRow(scopeKey: string): Promise<ReleaseCatalogRow | null>;
  listReleaseCatalogs(input: KeysetInput): Promise<ReleaseCatalogRow[]>;
  listChannels(): Promise<ChannelRow[]>;
  findChannelByName(name: string): Promise<ChannelRow | null>;
  /** A native build by ID: one read of its key. */
  getNativeBuild(id: string): Promise<NativeBuildRow | null>;
  /**
   * The newest native build of a scope: one read of its index. With
   * `buildKey`, the newest of the scope registered with that native build
   * key, also one read.
   */
  findNativeBuild(
    scope: NativeBuildScope,
    options?: { readonly buildKey?: string },
  ): Promise<NativeBuildRow | null>;
  /**
   * One page of native builds, by ID: oldest or newest first. With
   * `channelId`, only the builds that embed that channel, also one read.
   */
  listNativeBuilds(
    input: KeysetInput & { readonly channelId?: string },
  ): Promise<NativeBuildRow[]>;

  /**
   * Writes each new bundle with its patches, and each release, with the next
   * catalog of each scope, in one transaction. A stored bundle's deployment
   * publishes a new release for it and writes no bundle.
   */
  deploy(
    deployments: readonly Deployment[],
  ): Promise<ReleaseCatalogMutationResult[]>;
  updateReleasePolicy(
    input: ReleaseTarget & { readonly patch: ReleasePolicyPatch },
  ): Promise<ReleaseCatalogMutationResult>;
  /** What `updateReleasePolicy` would write, without writing it. */
  preflightReleasePolicy(
    input: ReleaseTarget & { readonly patch: ReleasePolicyPatch },
  ): Promise<ReleaseCatalogMutationPreflight>;
  /** Deletes a disabled release; an enabled one refuses. */
  deleteRelease(input: ReleaseTarget): Promise<ReleaseCatalogMutationResult>;
  /** Copies a bundle release into another channel, and with `move` disables the source. */
  promoteRelease(
    input: ReleaseTarget & {
      readonly targetChannel: string;
      readonly action?: "copy" | "move";
    },
  ): Promise<PromoteReleaseResult>;
  rebuildReleaseCatalog(scopeKey: string): Promise<ReleaseCatalogRebuildResult>;
  preflightReleaseCatalogRebuild(
    scopeKey: string,
  ): Promise<ReleaseCatalogRebuildPreflight>;
  /** The channel named `name`, created when missing. */
  ensureChannel(name: string): Promise<ChannelRow>;
  /** Deletes a channel no release uses. */
  deleteChannel(id: string): Promise<ChannelDeleteResult>;
  /** Changes a bundle's fields; `patches`, when given, replaces its patches. */
  updateBundle(
    id: string,
    update: Partial<Omit<Bundle, "id" | "patches">> & {
      readonly patches?: Bundle["patches"];
    },
  ): Promise<void>;
  /**
   * Deletes bundles with their patches; a bundle a release uses, or a native
   * build's built-in bundle, refuses.
   */
  deleteBundles(ids: readonly string[]): Promise<void>;
  /**
   * Writes a native build and its built-in bundle's row in one transaction.
   * That row is no OTA bundle: no release publishes it, and the bundle
   * totals leave it out.
   */
  registerNativeBuild(
    registration: NativeBuildRegistration,
  ): Promise<NativeBuildRow>;
  /**
   * Records that a store took a native build: the track and the store's
   * label of the build, with the time of the record. One read and one write;
   * the CLI calls it after the store accepted the upload, or found the build
   * already there. Null for an unknown ID.
   */
  recordNativeBuildSubmission(
    id: string,
    submission: {
      readonly destination: NativeBuildSubmissionDestination;
      readonly version: string;
    },
  ): Promise<NativeBuildRow | null>;
  /**
   * Deletes a native build and its built-in bundle's row in one transaction,
   * with the patches from that bundle: an installed build then downloads
   * full bundles. Its artifact stays in storage for the caller to delete.
   */
  deleteNativeBuild(id: string): Promise<NativeBuildDeleteResult>;
}
