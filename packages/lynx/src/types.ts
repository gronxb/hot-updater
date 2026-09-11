import type {
  PersistedSelectionReceipt,
  ReleaseCatalog,
} from "@hot-updater/core";

export interface HotUpdaterOptions {
  baseURL: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
}

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

export interface PreparedUpdate {
  bundleId: string;
  releaseId: string | null;
  status: "UPDATE" | "ROLLBACK";
  message: string | null;
  shouldForceUpdate: boolean;
  /** Publishes the prepared selection; never changes this process's bytes. */
  install(): Promise<InstallResult>;
}

export interface HotUpdater {
  getLaunchInfo(): Promise<LaunchInfo>;
  notifyAppReady(): Promise<ConfirmationResult>;
  /** Downloads and verifies the candidate, without selecting it for launch. */
  checkForUpdate(): Promise<PreparedUpdate | null>;
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
}
