/**
 * Core fingerprint utilities shared across packages.
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