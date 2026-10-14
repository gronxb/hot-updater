import type {
  ArtifactFiles,
  ArtifactInfo,
  ArtifactInfoV2,
  ReleaseCatalog,
} from "@hot-updater/protocol";

import type { BundleDetail, KeysetInput, ReleaseFilter } from "../coreApi";
import type {
  BundlePatchRow,
  ChannelRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "../types/databaseRows";

/** The scope of a device's update check, by its update strategy. */
export type ReleaseCatalogRequest =
  | {
      readonly strategy: "APP_VERSION";
      readonly platform: "ios" | "android";
      readonly channelKey: string;
      readonly appVersion: string;
    }
  | {
      readonly strategy: "FINGERPRINT";
      readonly platform: "ios" | "android";
      readonly channelKey: string;
      readonly fingerprintHash: string;
    };

/**
 * Core's reads: bundles, Releases, Catalogs, and channels, each through a
 * declared index. A plugin gets them as `ctx.core` and never writes core.
 */
export interface CoreReads {
  /** The Release Catalog a device's update check receives, or null when its scope has none. */
  getReleaseCatalog(
    input: ReleaseCatalogRequest,
  ): Promise<ReleaseCatalog | null>;
  /** How a device on `currentBundleId` downloads `targetBundleId`. */
  getArtifactInfo(
    targetBundleId: string,
    currentBundleId: string,
    artifactProtocolVersion: 1,
  ): Promise<ArtifactInfo | null>;
  /** The same in artifact protocol v2, which carries no URL per file. */
  getArtifactInfo(
    targetBundleId: string,
    currentBundleId: string,
    artifactProtocolVersion: 2,
  ): Promise<ArtifactInfoV2 | null>;
  /**
   * Download URLs for the manifest files of `bundleId` that a device downloads
   * one by one; null when the Bundle or any path is unknown.
   */
  getArtifactFiles(
    bundleId: string,
    paths: readonly string[],
  ): Promise<ArtifactFiles | null>;
  getBundle(id: string): Promise<BundleDetail | null>;
  /** Each base bundle's reference counter: one batch read of the bundle rows, and no patches. */
  countBundleChildren(
    baseBundleIds: readonly string[],
  ): Promise<Record<string, number>>;
  /** One page of the patches that start from a bundle, by target bundle id. */
  listPatchesFromBase(
    baseBundleId: string,
    input: KeysetInput,
  ): Promise<BundlePatchRow[]>;
  listBundles(
    input: KeysetInput & { readonly platform?: "ios" | "android" },
  ): Promise<BundleDetail[]>;
  countBundles(platform?: "ios" | "android"): Promise<number>;
  findBaseBundleIds(
    candidateKey: string,
    bundleId: string,
    limit: number,
  ): Promise<string[]>;
  getRelease(id: string): Promise<ReleaseRow | null>;
  /** One page of releases through the index its filter names. */
  listReleases(
    input: KeysetInput & { readonly filter: ReleaseFilter },
  ): Promise<ReleaseRow[]>;
  latestReleaseId(scopeKey: string): Promise<string | null>;
  getReleaseCatalogRow(scopeKey: string): Promise<ReleaseCatalogRow | null>;
  listReleaseCatalogs(input: KeysetInput): Promise<ReleaseCatalogRow[]>;
  listChannels(): Promise<ChannelRow[]>;
  findChannelByName(name: string): Promise<ChannelRow | null>;
}
