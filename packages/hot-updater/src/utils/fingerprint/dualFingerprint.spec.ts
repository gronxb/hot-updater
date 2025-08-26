import { describe, expect, it } from "vitest";
import {
  extractCachingPart,
  extractOtaFingerprint,
  isOtaCompatible,
  isValidNativeFingerprint,
  isValidOtaFingerprint,
} from "./dualFingerprint";

describe("dualFingerprint", () => {
  describe("extractOtaFingerprint", () => {
    it("should extract first 80 bits (20 hex chars) from native fingerprint", () => {
      const nativeFingerprint = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      const otaFingerprint = extractOtaFingerprint(nativeFingerprint);
      
      expect(otaFingerprint).toBe("8b47da71b3b7cf7fa7fd");
      expect(otaFingerprint.length).toBe(20);
    });

    it("should handle different fingerprints correctly", () => {
      const fingerprint1 = "1234567890abcdef12341234567890abcdef1234";
      const fingerprint2 = "1234567890abcdef1234fedcba0987654321fedc";
      
      const ota1 = extractOtaFingerprint(fingerprint1);
      const ota2 = extractOtaFingerprint(fingerprint2);
      
      // Same OTA part (first 20 chars)
      expect(ota1).toBe("1234567890abcdef1234");
      expect(ota2).toBe("1234567890abcdef1234");
      expect(ota1).toBe(ota2);
    });
  });

  describe("extractCachingPart", () => {
    it("should extract last 80 bits (20 hex chars) from native fingerprint", () => {
      const nativeFingerprint = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      const cachingPart = extractCachingPart(nativeFingerprint);
      
      expect(cachingPart).toBe("0ad4938207d01d584430");
      expect(cachingPart.length).toBe(20);
    });
  });

  describe("isOtaCompatible", () => {
    it("should return true for fingerprints with same OTA part", () => {
      const fingerprint1 = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      const fingerprint2 = "8b47da71b3b7cf7fa7fdfedcba0987654321fedc";
      
      expect(isOtaCompatible(fingerprint1, fingerprint2)).toBe(true);
    });

    it("should return false for fingerprints with different OTA part", () => {
      const fingerprint1 = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      const fingerprint2 = "1234567890abcdef12340ad4938207d01d584430";
      
      expect(isOtaCompatible(fingerprint1, fingerprint2)).toBe(false);
    });

    it("should return false for null or undefined fingerprints", () => {
      expect(isOtaCompatible(null, "8b47da71b3b7cf7fa7fd0ad4938207d01d584430")).toBe(false);
      expect(isOtaCompatible("8b47da71b3b7cf7fa7fd0ad4938207d01d584430", null)).toBe(false);
      expect(isOtaCompatible(undefined, "8b47da71b3b7cf7fa7fd0ad4938207d01d584430")).toBe(false);
      expect(isOtaCompatible("8b47da71b3b7cf7fa7fd0ad4938207d01d584430", undefined)).toBe(false);
      expect(isOtaCompatible(null, null)).toBe(false);
      expect(isOtaCompatible(undefined, undefined)).toBe(false);
    });

    it("should handle edge case where fingerprints are identical", () => {
      const fingerprint = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      
      expect(isOtaCompatible(fingerprint, fingerprint)).toBe(true);
    });
  });

  describe("isValidNativeFingerprint", () => {
    it("should return true for valid 160-bit fingerprints", () => {
      expect(isValidNativeFingerprint("8b47da71b3b7cf7fa7fd0ad4938207d01d584430")).toBe(true);
      expect(isValidNativeFingerprint("1234567890abcdef1234567890abcdef12345678")).toBe(true);
      expect(isValidNativeFingerprint("ABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(true);
    });

    it("should return false for invalid fingerprints", () => {
      // Too short
      expect(isValidNativeFingerprint("8b47da71b3b7cf7fa7fd")).toBe(false);
      // Too long
      expect(isValidNativeFingerprint("8b47da71b3b7cf7fa7fd0ad4938207d01d5844301")).toBe(false);
      // Invalid characters
      expect(isValidNativeFingerprint("8b47da71b3b7cf7fa7fd0ad4938207d01d58443g")).toBe(false);
      expect(isValidNativeFingerprint("8b47da71b3b7cf7fa7fd0ad4938207d01d58443!")).toBe(false);
      // Empty string
      expect(isValidNativeFingerprint("")).toBe(false);
    });
  });

  describe("isValidOtaFingerprint", () => {
    it("should return true for valid 80-bit fingerprints", () => {
      expect(isValidOtaFingerprint("8b47da71b3b7cf7fa7fd")).toBe(true);
      expect(isValidOtaFingerprint("1234567890abcdef1234")).toBe(true);
      expect(isValidOtaFingerprint("ABCDEF1234567890ABCD")).toBe(true);
    });

    it("should return false for invalid fingerprints", () => {
      // Too short
      expect(isValidOtaFingerprint("8b47da71b3")).toBe(false);
      // Too long
      expect(isValidOtaFingerprint("8b47da71b3b7cf7fa7fd1")).toBe(false);
      // Invalid characters
      expect(isValidOtaFingerprint("8b47da71b3b7cf7fa7fg")).toBe(false);
      expect(isValidOtaFingerprint("8b47da71b3b7cf7fa7f!")).toBe(false);
      // Empty string
      expect(isValidOtaFingerprint("")).toBe(false);
    });
  });

  describe("Integration scenarios", () => {
    it("should correctly identify OTA-compatible builds with different caching parts", () => {
      // Scenario: Multiple native builds with same OTA compatibility but different caching
      const builds = [
        { id: "build1", fingerprint: "8b47da71b3b7cf7fa7fd0ad4938207d01d584430" },
        { id: "build2", fingerprint: "8b47da71b3b7cf7fa7fdfedcba0987654321fedc" },
        { id: "build3", fingerprint: "8b47da71b3b7cf7fa7fd1111222233334444aaaa" },
        { id: "build4", fingerprint: "1234567890abcdef12340ad4938207d01d584430" }, // Different OTA
      ];
      
      const clientFingerprint = "8b47da71b3b7cf7fa7fd9999888877776666bbbb";
      
      const compatibleBuilds = builds.filter(build => 
        isOtaCompatible(build.fingerprint, clientFingerprint)
      );
      
      // Builds 1, 2, and 3 should be compatible (same OTA part)
      expect(compatibleBuilds).toHaveLength(3);
      expect(compatibleBuilds.map(b => b.id)).toEqual(["build1", "build2", "build3"]);
    });
  });
});