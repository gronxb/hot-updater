import { describe, expect, it } from "vitest";
import { extractOtaFingerprint, isOtaCompatible } from "./fingerprint";

describe("Core fingerprint utilities", () => {
  describe("extractOtaFingerprint", () => {
    it("should extract first 80 bits (20 hex chars) from native fingerprint", () => {
      const nativeFingerprint = "8b47da71b3b7cf7fa7fd0ad4938207d01d584430";
      const otaFingerprint = extractOtaFingerprint(nativeFingerprint);
      
      expect(otaFingerprint).toBe("8b47da71b3b7cf7fa7fd");
      expect(otaFingerprint.length).toBe(20);
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
  });
});