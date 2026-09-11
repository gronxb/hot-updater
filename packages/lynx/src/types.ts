import type {
  PersistedSelectionReceipt,
  ReleaseCatalog,
} from "@hot-updater/core";

export interface HotUpdaterOptions {
  baseURL: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
}

export type HotUpdaterInitOptions = HotUpdaterOptions & {
  insights?: boolean;
  onError?: (error: Error) => void;
};

export interface CheckForUpdateOptions {
  updateStrategy: "appVersion" | "fingerprint";
  channel?: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onError?: (error: Error) => void;
}

export type ReleaseTransitionKind =
  | "INSTALL"
  | "ADOPT_RELEASE"
  | "USE_EMBEDDED"
  | "USE_BUILTIN";

export type NotifyAppReadyResult =
  | { status: "UNCHANGED" }
  | {
      status: "UPDATE_APPLIED";
      fromBundleId: string;
      toBundleId: string;
      fromReleaseId?: string;
      toReleaseId?: string;
    }
  | {
      status: "RECOVERED";
      fromBundleId: string;
      toBundleId: string;
      fromReleaseId?: string;
      toReleaseId?: string;
    };

export type ReloadBehavior = "reload" | "processRestart";
export type ReloadBehaviorSetting = ReloadBehavior | "custom";
export type CustomReloadHandler = () => void | Promise<void>;

export interface ManifestAsset {
  fileHash: string;
  signature?: string;
}

export interface Manifest {
  bundleId: string;
  assets: Record<string, ManifestAsset>;
}

export interface ActiveUpdateSelection {
  kind: "BUNDLE" | "EMBEDDED" | "BUILTIN";
  releaseId: string | null;
  bundleId: string;
  channel: string;
}

export interface ActiveUpdateState {
  activeSelection: ActiveUpdateSelection | null;
  stableSelection: ActiveUpdateSelection | null;
  verificationPending: boolean;
}

export type HotUpdaterEvent = {
  onProgress: { progress: number };
};

export type SetUserParams = {
  userId?: string | null;
  name?: string | null;
};

export type SelectionSummary = Pick<
  PersistedSelectionReceipt,
  "kind" | "bundleId" | "releaseId" | "channel"
>;

export interface LaunchInfo {
  platform: "ios" | "android";
  runtimeId: string;
  running: SelectionSummary;
  confirmed: boolean;
  next: SelectionSummary | null;
}

export interface InstallResult {
  status: "STAGED" | "ADOPTED";
  requiresRestart: boolean;
}

export interface ConfirmationResult {
  status: "CONFIRMED" | "ALREADY_CONFIRMED";
}

export interface CheckForUpdateResult {
  readonly id: string;
  readonly bundleId: string;
  readonly message: string | null;
  readonly rolloutCohortCount: number;
  readonly shouldForceUpdate: boolean;
  readonly status: "ROLLBACK" | "UPDATE";
  readonly targetCohorts: string[];
  readonly releaseId: string | null;
  readonly transitionKind: ReleaseTransitionKind;
  readonly fileUrl: string | null;
  readonly fileHash: string | null;
  /**
   * Publishes the prepared selection. Equivalent to RN
   * `update.updateBundle()`. Never changes this process's bytes.
   */
  updateBundle: () => Promise<boolean>;
}

/** Internal bridge contract. These fields come from one native state snapshot. */
export interface NativeState {
  revision: string;
  platform: "ios" | "android";
  /** Canonical app version supplied by native configuration. */
  appVersion: string;
  channel: string;
  /** Native-validated NFC channel encoded as unpadded UTF-8 base64url. */
  channelKey: string;
  runtimeId: string;
  embeddedBundleId: string;
  minimumBundleId: string;
  cohort: string;
  runningSelection: PersistedSelectionReceipt;
  runningConfirmed: boolean;
  confirmedSelection: PersistedSelectionReceipt | null;
  nextSelection: PersistedSelectionReceipt | null;
  crashedBundleIds: string[];
  unconfirmedReleaseIds: string[];
  fingerprintHash?: string | null;
}

/** Native binds this guard to its revision and accepted catalog. */
export interface SelectionGuard {
  revision: string;
  catalogId: string;
  scopeKey: string;
  generation: number;
  catalogHash: string;
  channel: string;
  selectionContextHash: string;
}

export interface AcceptCatalogParams {
  catalog: ReleaseCatalog;
  expectedRevision: string;
  selectionContextHash: string;
}

export interface ArchiveArtifact {
  bundleId: string;
  fileUrl: string;
  fileHash: string;
  /** When absent, native must use the verified archive as the trust anchor. */
  manifestFileHash: string | null;
}

export interface PrepareSelectionParams {
  guard: SelectionGuard;
  selection: PersistedSelectionReceipt;
  artifact: ArchiveArtifact | null;
}

export type NativeReply<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

type Callback<T> = (reply: NativeReply<T>) => void;

/** Methods are called only from Lynx background scripting. */
export interface HotUpdaterLynxNative {
  getState(callback: Callback<NativeState>): void;
  acceptCatalog(
    params: AcceptCatalogParams,
    callback: Callback<SelectionGuard>,
  ): void;
  prepareSelection(
    params: PrepareSelectionParams,
    callback: Callback<{ preparedId: string }>,
  ): void;
  stageSelection(
    params: { preparedId: string },
    callback: Callback<InstallResult>,
  ): void;
  notifyAppReady(callback: Callback<ConfirmationResult>): void;
  reload?(callback: Callback<void>): void;
  setCohort?(params: { cohort: string }, callback: Callback<NativeState>): void;
  setChannel?(
    params: { channel: string },
    callback: Callback<NativeState>,
  ): void;
  resetChannel?(callback: Callback<{ reset: boolean }>): void;
  clearCrashHistory?(callback: Callback<NativeState>): void;
}
