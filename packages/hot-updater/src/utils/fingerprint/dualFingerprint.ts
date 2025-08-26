/**
 * Dual-part fingerprint utilities for separating OTA compatibility from native caching.
 * 
 * The fingerprint is split into two parts:
 * - OTA fingerprint (first 80 bits / 20 hex chars): For update compatibility
 * - Caching part (last 80 bits / 20 hex chars): For native build isolation
 * 
 * This allows multiple native builds with the same OTA fingerprint to receive
 * compatible updates while maintaining precise cache control.
 */

/**
 * Extracts the OTA fingerprint (first 80 bits) from a native fingerprint.
 * 
 * @param nativeFingerprint - The full 160-bit native fingerprint hash (40 hex chars)
 * @returns The 80-bit OTA fingerprint (20 hex chars)
 */
export function extractOtaFingerprint(nativeFingerprint: string): string {
  // Native fingerprint is 160 bits (40 hex characters)
  // OTA fingerprint is the first 80 bits (20 hex characters)
  return nativeFingerprint.substring(0, 20);
}

/**
 * Checks if two fingerprints are OTA-compatible by comparing their OTA parts.
 * 
 * @param fingerprint1 - First native fingerprint
 * @param fingerprint2 - Second native fingerprint
 * @returns True if the OTA parts match (first 80 bits are identical)
 */
export function isOtaCompatible(
  fingerprint1: string | null | undefined,
  fingerprint2: string | null | undefined,
): boolean {
  if (!fingerprint1 || !fingerprint2) {
    return false;
  }
  
  const ota1 = extractOtaFingerprint(fingerprint1);
  const ota2 = extractOtaFingerprint(fingerprint2);
  
  return ota1 === ota2;
}

/**
 * Extracts the caching part (last 80 bits) from a native fingerprint.
 * 
 * @param nativeFingerprint - The full 160-bit native fingerprint hash (40 hex chars)
 * @returns The 80-bit caching part (20 hex chars)
 */
export function extractCachingPart(nativeFingerprint: string): string {
  // Caching part is the last 80 bits (last 20 hex characters)
  return nativeFingerprint.substring(20, 40);
}

/**
 * Validates if a string is a valid native fingerprint (160-bit hex).
 * 
 * @param fingerprint - The fingerprint to validate
 * @returns True if valid 160-bit fingerprint
 */
export function isValidNativeFingerprint(fingerprint: string): boolean {
  // Must be exactly 40 hex characters (160 bits)
  return /^[0-9a-f]{40}$/i.test(fingerprint);
}

/**
 * Validates if a string is a valid OTA fingerprint (80-bit hex).
 * 
 * @param fingerprint - The fingerprint to validate
 * @returns True if valid 80-bit fingerprint
 */
export function isValidOtaFingerprint(fingerprint: string): boolean {
  // Must be exactly 20 hex characters (80 bits)
  return /^[0-9a-f]{20}$/i.test(fingerprint);
}