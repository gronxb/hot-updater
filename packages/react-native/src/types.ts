import type { AppUpdateInfo } from "@hot-updater/core";
import type { NotifyAppReadyResult } from "./native";

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

/**
 * Parameters passed to resolver.notifyAppReady method
 */
export interface ResolverNotifyAppReadyParams {
  /**
   * The bundle state from native notifyAppReady
   * - "PROMOTED": Staging bundle was promoted to stable
   * - "RECOVERED": App recovered from crash, rollback occurred
   * - "STABLE": No changes, bundle is stable
   */
  status: "PROMOTED" | "RECOVERED" | "STABLE";

  /**
   * Present only when status is "RECOVERED"
   */
  crashedBundleId?: string;

  /**
   * Request headers from global config (for optional use)
   */
  requestHeaders?: Record<string, string>;

  /**
   * Request timeout from global config (for optional use)
   */
  requestTimeout?: number;
}

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
   * Note: The native notifyAppReady for bundle promotion still happens automatically.
   *
   * @param params - All parameters about the current app state
   * @returns Notification result
   *
   * @example
   * ```typescript
   * notifyAppReady: async (params) => {
   *   await fetch(`https://api.custom.com/notify`, {
   *     method: 'POST',
   *     body: JSON.stringify(params),
   *   });
   *
   *   return { status: "STABLE" };
   * }
   * ```
   */
  notifyAppReady?: (
    params: ResolverNotifyAppReadyParams,
  ) => Promise<NotifyAppReadyResult | undefined>;
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
