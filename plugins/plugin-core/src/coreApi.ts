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
  IosDeviceRow,
  IosDeviceStatus,
  NativeBuildArtifactKind,
  NativeBuildDeleteResult,
  NativeBuildExportMethod,
  NativeBuildMarkResult,
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
  /** The last key this read may return: it ends with that key, if present. */
  readonly through?: string;
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
 * How a native build's artifact reaches a device: installed directly (an
 * APK, a simulator `.app`, or an ad hoc, development or enterprise `.ipa`),
 * or through a store (an AAB, or an App Store `.ipa`). Part of the core API
 * a standalone server's client implements.
 */
export type NativeBuildDistribution = "direct" | "store";

/**
 * What tells sandbox builds apart in place of the channel, which pull requests
 * reuse a sandbox build across: the app ID its artifact reports (its bundle
 * identifier or application ID, with Android's `.sandbox` suffix), the URL
 * scheme its preview links open, its artifact's kind, and how that installs.
 * Part of the core API a standalone server's client implements.
 */
export interface NativeBuildSandboxScope {
  readonly appId: string;
  readonly urlScheme: string;
  readonly artifactKind: NativeBuildArtifactKind;
  readonly distribution: NativeBuildDistribution;
}

/**
 * A native build's scope: its platform, the default channel it compiled in,
 * and whichever of the fingerprint and the app version the update strategy
 * selects by. With `sandbox`, the scope of sandbox builds of that fingerprint
 * or app version, on any channel: `channel` is then the one a new build would
 * embed, and no lookup reads it. A registration ignores `sandbox`: its own
 * `isSandbox`, `sandboxAppId`, `sandboxUrlScheme`, `exportMethod` and
 * artifact decide its scope.
 */
export type NativeBuildScope = {
  readonly platform: Platform;
  readonly channel: string;
  readonly sandbox?: NativeBuildSandboxScope | null;
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
  /**
   * The build number the artifact reports, its `CFBundleVersion` or
   * `versionCode`, or null (or left out) when it can't be read.
   */
  readonly buildNumber?: string | null;
  /**
   * Whether the artifact is a sandbox build, as the artifact says; left out,
   * it isn't. A sandbox build registers on any channel, and is found through
   * its sandbox scope, never a normal one.
   */
  readonly isSandbox?: boolean;
  /**
   * The URL scheme a sandbox build's artifact registers, which its preview
   * links open: required for a sandbox build, and null or left out for any
   * other.
   */
  readonly sandboxUrlScheme?: string | null;
  /**
   * The app ID a sandbox build's artifact reports, its bundle identifier or
   * application ID: required for a sandbox build, and null or left out for
   * any other.
   */
  readonly sandboxAppId?: string | null;
  /**
   * How an `.ipa` was exported, read from its embedded profile; null or left
   * out for any other artifact, or an `.ipa` whose profile wasn't read.
   */
  readonly exportMethod?: NativeBuildExportMethod | null;
  /**
   * The app version the artifact reports, its `CFBundleShortVersionString`
   * or `versionName`, whatever the update strategy; null or left out when it
   * wasn't read.
   */
  readonly nativeAppVersion?: string | null;
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

/**
 * What a build or `native-build devices add` learned from Apple about one
 * registry row: Apple has it enabled (`registered`), refused to add it
 * (`refused`), has it disabled (`disabled`), or no longer lists a device the
 * row says it registered (`missing`).
 */
export type IosDeviceOutcome =
  | "registered"
  | "refused"
  | "disabled"
  | "missing";

/** A device registry row's outcome at Apple, written only over the row the caller read. */
export interface IosDeviceOutcomeInput {
  readonly id: string;
  /**
   * The row as the caller read it before asking Apple: a row that changed
   * since, such as one removed and requested again, is left alone.
   */
  readonly seen: {
    readonly status: IosDeviceStatus;
    readonly approvedAtMs: number | null;
  };
  /** The App Store Connect issuer of the key that asked Apple. */
  readonly issuerId: string;
  readonly outcome: IosDeviceOutcome;
  /** Apple's words for `refused`, kept as the row's `apple_error`. */
  readonly reason?: string;
}

/** The device registry's Apple account, after a build tried to claim it. */
export interface IosDeviceAccountClaim {
  /** The App Store Connect issuer the registry belongs to. */
  readonly issuerId: string;
  /** Whether that is the issuer that asked: false means another account's. */
  readonly claimed: boolean;
}

/** A device request's row, and whether the request created it. */
export interface IosDeviceRequestResult {
  readonly device: IosDeviceRow;
  /** False when the UDID was already in the registry, whose row is unchanged. */
  readonly created: boolean;
}

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
   * The newest native build of a scope: the one registered last, in one read
   * of its index. With `buildKey`, the newest of the scope registered with that
   * native build key, also one read. With `storeBuild`, the scope's marked
   * build or null, also one read. With `builtInOlderThan`, the newest of the
   * scope whose built-in bundle is older than that bundle: one read when the
   * newest is, and then a page of older builds per read until one is, when
   * builds made after the bundle are in the way. With `buildKey` too, only
   * builds of that key. With `scope.sandbox`, sandbox builds on any channel;
   * without it, never one. A sandbox build's built-in bundle is no patch
   * base, so with `builtInOlderThan` a sandbox scope answers null without a
   * read.
   */
  findNativeBuild(
    scope: NativeBuildScope,
    options?: {
      readonly buildKey?: string;
      readonly storeBuild?: true;
      readonly builtInOlderThan?: string;
    },
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
   * publishes a new release for it and writes no bundle. Like `updateBundle`,
   * it refuses a patch from a sandbox build's built-in bundle: one read of
   * each new bundle's patch base.
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
  /**
   * Changes a bundle's fields; `patches`, when given, replaces its patches.
   * It refuses a new patch from a sandbox build's built-in bundle, which is
   * no patch base: one read of each new patch's base.
   */
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
  /**
   * Marks a build as what the store sells, replacing its scope's mark in one
   * write, or clears the mark it holds. Running it again changes nothing. Null
   * for an unknown ID. A sandbox build can't be marked.
   */
  markNativeBuild(
    id: string,
    mark: { readonly storeBuild: boolean },
  ): Promise<NativeBuildMarkResult | null>;

  /**
   * One page of the iOS device registry, by ID: oldest or newest first. With
   * `status`, only the rows in it, also one read.
   */
  listIosDevices(
    input: KeysetInput & { readonly status?: IosDeviceStatus },
  ): Promise<IosDeviceRow[]>;
  /** The registry's row of a UDID, in either case: one read. Null for none. */
  findIosDevice(udid: string): Promise<IosDeviceRow | null>;
  /**
   * Adds a UDID to the registry as `pending`. A UDID already there keeps its
   * row unchanged, so nobody takes over another person's request.
   */
  requestIosDevice(input: {
    readonly udid: string;
    readonly name: string;
    /** Who asks, or null for the CLI. */
    readonly requestedBy: string | null;
  }): Promise<IosDeviceRequestResult>;
  /**
   * Approves a pending device, so the next ad hoc build registers it with
   * Apple. A device past `pending` stays as it is. With `name`, renames it.
   * Null for an unknown ID.
   */
  approveIosDevice(
    id: string,
    input: {
      readonly name?: string;
      /** Who approves: a Console email, or null for the CLI. */
      readonly approvedBy: string | null;
    },
  ): Promise<IosDeviceRow | null>;
  /** Renames a device in the registry, whatever its status. Null for an unknown ID. */
  renameIosDevice(id: string, name: string): Promise<IosDeviceRow | null>;
  /**
   * Records what Apple said of a device, only over the row the caller read
   * (`seen`) and only for the account that registered it: null, with nothing
   * written, for a row that changed, is gone, or belongs to another issuer.
   * It never creates a row.
   */
  recordIosDeviceOutcome(
    input: IosDeviceOutcomeInput,
  ): Promise<IosDeviceRow | null>;
  /**
   * Claims the device registry for an Apple account before a build records
   * or sends anything at Apple: the first claim wins, atomically, and holds
   * for good. A registry with no claim yet whose rows already name an account
   * (any status) goes to the earliest of them, not to the caller. Answers the
   * registry's account and whether it is `issuerId`'s; a build of another
   * account registers nothing.
   */
  claimIosDeviceAccount(issuerId: string): Promise<IosDeviceAccountClaim>;
  /**
   * Records that a native build's .ipa lists these devices, one write per
   * row: a row removed meanwhile is skipped.
   */
  markIosDevicesInBuild(input: {
    readonly buildId: string;
    readonly ids: readonly string[];
  }): Promise<void>;
  /**
   * Deletes a device from the registry. Apple keeps it: a device enabled
   * there stays in new ad hoc builds. With `only`, it deletes the row only
   * while it still has that status and requester, read in the same
   * transaction, such as a request its owner withdraws. Null, with nothing
   * deleted, for an unknown ID or a row that no longer matches.
   */
  deleteIosDevice(
    id: string,
    only?: {
      readonly status?: IosDeviceStatus;
      readonly requestedBy?: string;
    },
  ): Promise<IosDeviceRow | null>;
}
