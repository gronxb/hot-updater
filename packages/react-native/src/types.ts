import type { AppUpdateInfo } from "@hot-updater/core";

export type HotUpdaterBaseURL = string | (() => string | Promise<string>);

/**
 * Parameters passed to resolver.checkUpdate method
 */
export interface ResolverCheckUpdateParams {
  /**
   * The platform the app is running on
   */
  platform: "ios" | "android";

  /**
   * The current app version
   */
  appVersion: string;

  /**
   * The current bundle ID
   */
  bundleId: string;

  /**
   * Minimum bundle ID from build time
   */
  minBundleId: string;

  /**
   * The channel name (e.g., "production", "staging")
   */
  channel: string;

  /**
   * Cohort identifier used for server-side rollout decisions.
   */
  cohort: string;

  /**
   * Update strategy being used
   */
  updateStrategy: "fingerprint" | "appVersion";

  /**
   * The fingerprint hash (only present when using fingerprint strategy)
   */
  fingerprintHash: string | null;

  /**
   * Request headers from global config (for optional use)
   */
  requestHeaders?: Record<string, string>;

  /**
   * Request timeout from global config (for optional use)
   */
  requestTimeout?: number;
}

/** Parameters shared by all resolver.notifyAppReady event variants. */
interface ResolverNotifyAppReadyCommonParams {
  /**
   * Stable install identity for the current app installation.
   */
  readonly installId: string;

  /**
   * Optional persisted user identity associated with this install.
   */
  readonly userId?: string;

  /**
   * Optional persisted username associated with this install.
   */
  readonly username?: string;

  /**
   * The platform the app is running on.
   */
  readonly platform: "ios" | "android";

  /**
   * The current app version.
   */
  readonly appVersion: string;

  /**
   * The current channel.
   */
  readonly channel: string;

  /**
   * Cohort identifier used for server-side rollout decisions.
   */
  readonly cohort: string;

  /**
   * Current fingerprint hash when available.
   */
  readonly fingerprintHash: string | null;

  /**
   * Request headers from global config (for optional use)
   */
  readonly requestHeaders?: Record<string, string>;

  /**
   * Request timeout from global config (for optional use)
   */
  readonly requestTimeout?: number;
}

/** Parameters passed to resolver.notifyAppReady for an applied update. */
type ResolverNotifyAppReadyUpdateAppliedParams =
  ResolverNotifyAppReadyCommonParams & {
    /** Transition event type to append. */
    readonly type: "UPDATE_APPLIED";

    /** Bundle replaced or rolled back from. */
    readonly fromBundleId: string;

    /** Bundle now active after the transition. */
    readonly toBundleId: string;

    /** Persisted update strategy for the qualifying transition. */
    readonly updateStrategy: "fingerprint" | "appVersion";
  };

/** Parameters passed to resolver.notifyAppReady for a recovered update. */
type ResolverNotifyAppReadyRecoveredParams =
  ResolverNotifyAppReadyCommonParams & {
    /** Transition event type to append. */
    readonly type: "RECOVERED";

    /** Bundle replaced or rolled back from. */
    readonly fromBundleId: string;

    /** Bundle now active after the transition. */
    readonly toBundleId: string;

    /** Persisted update strategy for the qualifying transition. */
    readonly updateStrategy: "fingerprint" | "appVersion";
  };

/** Parameters passed to resolver.notifyAppReady when the bundle is unchanged. */
type ResolverNotifyAppReadyUnchangedParams =
  ResolverNotifyAppReadyCommonParams & {
    /** App-ready event type to append. */
    readonly type: "UNCHANGED";

    /** No previous bundle exists for an unchanged report. */
    readonly fromBundleId: null;

    /** The currently active bundle. */
    readonly toBundleId: string;

    /** Unchanged reports have no transition strategy. */
    readonly updateStrategy: null;
  };

/**
 * Parameters passed to resolver.notifyAppReady method.
 *
 * Transition events require directional bundle ids and an update strategy;
 * unchanged events require null transition fields and report the active
 * bundle as `toBundleId`.
 */
export type ResolverNotifyAppReadyParams =
  | ResolverNotifyAppReadyUpdateAppliedParams
  | ResolverNotifyAppReadyRecoveredParams
  | ResolverNotifyAppReadyUnchangedParams;

/**
 * Resolver interface for custom network operations
 */
export interface HotUpdaterResolver {
  /**
   * Custom implementation for checking updates.
   * When provided, this completely replaces the default fetchUpdateInfo flow.
   *
   * @param params - All parameters needed to check for updates
   * @returns Update information or null if up to date
   *
   * @example
   * ```typescript
   * checkUpdate: async (params) => {
   *   const response = await fetch(`https://api.custom.com/check`, {
   *     method: 'POST',
   *     body: JSON.stringify(params),
   *     headers: params.requestHeaders,
   *   });
   *
   *   if (!response.ok) return null;
   *   return response.json();
   * }
   * ```
   */
  checkUpdate?: (
    params: ResolverCheckUpdateParams,
  ) => Promise<AppUpdateInfo | null>;

  /**
   * Custom implementation for notifying app ready.
   * When provided, this completely replaces the default notifyAppReady network flow.
   * Note: Native rollback/promotion semantics are already finalized before this callback runs.
   *
   * @param params - All parameters about the current app state
   * @returns Promise that resolves when transport completes successfully
   *
   * @example
   * ```typescript
   * notifyAppReady: async (params) => {
   *   await fetch(`https://api.custom.com/events`, {
   *     method: 'POST',
   *     body: JSON.stringify(params),
   *   });
   * }
   * ```
   */
  notifyAppReady?: (params: ResolverNotifyAppReadyParams) => Promise<void>;
}

/**
 * Information about a signature verification failure.
 * This is a security-critical event that indicates the bundle
 * may have been tampered with or the public key is misconfigured.
 */
export interface SignatureVerificationFailure {
  /**
   * The bundle ID that failed verification.
   */
  bundleId: string;
  /**
   * Human-readable error message from the native layer.
   */
  message: string;
  /**
   * The underlying error object.
   */
  error: Error;
}

/**
 * Checks if an error is a signature verification failure.
 * Matches error messages from both iOS and Android native implementations.
 *
 * **IMPORTANT**: This function relies on specific error message patterns from native code.
 * If you change the error messages in the native implementations, update these patterns:
 * - iOS: `ios/HotUpdater/Internal/SignatureVerifier.swift` (SignatureVerificationError)
 * - Android: `android/src/main/java/com/hotupdater/SignatureVerifier.kt` (SignatureVerificationException)
 */
export function isSignatureVerificationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Match iOS SignatureVerificationError messages
  // Match Android SignatureVerificationException messages
  return (
    message.includes("signature verification") ||
    message.includes("public key not configured") ||
    message.includes("public key format is invalid") ||
    message.includes("signature format is invalid") ||
    message.includes("bundle may be corrupted or tampered")
  );
}

/**
 * Extracts signature verification failure details from an error.
 */
export function extractSignatureFailure(
  error: unknown,
  bundleId: string,
): SignatureVerificationFailure {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  return {
    bundleId,
    message: normalizedError.message,
    error: normalizedError,
  };
}
