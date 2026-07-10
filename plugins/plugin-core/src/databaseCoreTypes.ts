import type {
  BundleEventResource,
  BundlePatchResource,
  BundleResource,
  UpdateInfoRepository,
} from "./types";

export interface DatabaseTransaction {
  readonly core: DatabasePluginCore;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export interface DatabasePluginCore {
  readonly beginTransaction?: () => Promise<DatabaseTransaction>;
  readonly bundles: BundleResource;
  readonly bundlePatches: BundlePatchResource;
  readonly bundleEvents?: BundleEventResource;
  readonly updateInfo?: UpdateInfoRepository;
  readonly close?: () => Promise<void>;
}
