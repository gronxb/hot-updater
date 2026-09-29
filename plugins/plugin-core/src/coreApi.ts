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
  /** Auto-patch bases for a new bundle: the newest older bundles sharing its candidate key. */
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
  /** Deletes bundles with their patches; a bundle a release uses refuses. */
  deleteBundles(ids: readonly string[]): Promise<void>;
}
