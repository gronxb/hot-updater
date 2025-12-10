import { describe, expect, it } from "vitest";
import {
  createSignedFileHash,
  extractSignature,
  isSignedFileHash,
  SIGNED_HASH_PREFIX,
  SignedHashFormatError,
} from "./signedHashUtils";

// Test data constants
const SAMPLE_SIGNATURE = "MEUCIQDKZokqTesting+Base64/Signature==";
const SIGNED_FORMAT = `sig:${SAMPLE_SIGNATURE}`;

// Additional test data
const SIMPLE_SIGNATURE = "dGVzdA==";
const ALL_BASE64_CHARS_SIGNATURE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==";
const LONG_SIGNATURE = `${"A".repeat(500)}==`;
const SAMPLE_HASH =
  "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";

describe("signedHashUtils", () => {
  describe("Constants", () => {
    it("should export correct prefix constant", () => {
      expect(SIGNED_HASH_PREFIX).toBe("sig:");
    });
  });

  describe("createSignedFileHash", () => {
    it("should create correct signed hash format with signature only", () => {
      const result = createSignedFileHash(SAMPLE_SIGNATURE);

      expect(result).toBe(SIGNED_FORMAT);
      expect(result).toBe(`sig:${SAMPLE_SIGNATURE}`);
    });

    it("should create correct format with simple signature", () => {
      const result = createSignedFileHash(SIMPLE_SIGNATURE);

      expect(result).toBe(`sig:${SIMPLE_SIGNATURE}`);
    });

    it("should handle signatures with base64 special characters (+, /, =)", () => {
      const signatureWithSpecialChars = "MEUCIQDKZokq+Test/Value==";
      const result = createSignedFileHash(signatureWithSpecialChars);

      expect(result).toBe(`sig:${signatureWithSpecialChars}`);
      expect(result).toContain("+");
      expect(result).toContain("/");
      expect(result).toContain("==");
    });

    it("should handle signatures with all base64 special characters", () => {
      const result = createSignedFileHash(ALL_BASE64_CHARS_SIGNATURE);

      expect(result).toBe(`sig:${ALL_BASE64_CHARS_SIGNATURE}`);
    });

    it("should handle very long signatures", () => {
      const result = createSignedFileHash(LONG_SIGNATURE);

      expect(result).toBe(`sig:${LONG_SIGNATURE}`);
      expect(result.length).toBeGreaterThan(500);
    });

    it("should throw SignedHashFormatError for empty signature", () => {
      expect(() => createSignedFileHash("")).toThrow(SignedHashFormatError);
      expect(() => createSignedFileHash("")).toThrow(
        /signature cannot be empty/,
      );
    });

    it("should throw SignedHashFormatError for whitespace-only signature", () => {
      expect(() => createSignedFileHash("   ")).toThrow(SignedHashFormatError);
      expect(() => createSignedFileHash("\t\n")).toThrow(SignedHashFormatError);
    });
  });

  describe("isSignedFileHash", () => {
    it("should return true for signed format", () => {
      expect(isSignedFileHash(SIGNED_FORMAT)).toBe(true);
    });

    it("should return true for any string starting with sig:", () => {
      expect(isSignedFileHash("sig:anything")).toBe(true);
      expect(isSignedFileHash("sig:")).toBe(true);
    });

    it("should return false for plain hash", () => {
      expect(isSignedFileHash(SAMPLE_HASH)).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isSignedFileHash("")).toBe(false);
    });

    it("should return false for null-ish values", () => {
      expect(isSignedFileHash(null as unknown as string)).toBe(false);
      expect(isSignedFileHash(undefined as unknown as string)).toBe(false);
    });

    it("should return false for string that contains but does not start with sig:", () => {
      expect(isSignedFileHash("prefix-sig:abc")).toBe(false);
      expect(isSignedFileHash("notsig:abc")).toBe(false);
    });

    it("should be case-sensitive for prefix", () => {
      expect(isSignedFileHash("SIG:abc")).toBe(false);
      expect(isSignedFileHash("Sig:abc")).toBe(false);
    });
  });

  describe("extractSignature", () => {
    it("should extract signature from signed format", () => {
      const result = extractSignature(SIGNED_FORMAT);

      expect(result).toBe(SAMPLE_SIGNATURE);
    });

    it("should extract signature with special characters", () => {
      const signatureWithSpecialChars = "MEUCIQDKZokq+Test/Value==";
      const result = extractSignature(`sig:${signatureWithSpecialChars}`);

      expect(result).toBe(signatureWithSpecialChars);
    });

    it("should extract very long signatures", () => {
      const result = extractSignature(`sig:${LONG_SIGNATURE}`);

      expect(result).toBe(LONG_SIGNATURE);
    });

    it("should return null for plain hash", () => {
      const result = extractSignature(SAMPLE_HASH);

      expect(result).toBeNull();
    });

    it("should return null for empty string", () => {
      const result = extractSignature("");

      expect(result).toBeNull();
    });

    it("should return null for null-ish values", () => {
      expect(extractSignature(null as unknown as string)).toBeNull();
      expect(extractSignature(undefined as unknown as string)).toBeNull();
    });

    it("should return empty string for sig: with no signature", () => {
      const result = extractSignature("sig:");

      expect(result).toBe("");
    });
  });

  describe("Round-trip tests", () => {
    it("should preserve signature through create and extract cycle", () => {
      const signed = createSignedFileHash(SAMPLE_SIGNATURE);
      const extracted = extractSignature(signed);

      expect(extracted).toBe(SAMPLE_SIGNATURE);
    });

    it("should round-trip with various signature types", () => {
      const testSignatures = [
        SIMPLE_SIGNATURE,
        SAMPLE_SIGNATURE,
        ALL_BASE64_CHARS_SIGNATURE,
        LONG_SIGNATURE,
        "a",
        "ab",
      ];

      for (const signature of testSignatures) {
        const signed = createSignedFileHash(signature);
        const extracted = extractSignature(signed);

        expect(extracted).toBe(signature);
      }
    });
  });

  describe("SignedHashFormatError", () => {
    it("should be an instance of Error", () => {
      const error = new SignedHashFormatError("test message", "test input");

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SignedHashFormatError);
    });

    it("should have correct name property", () => {
      const error = new SignedHashFormatError("test message", "test input");

      expect(error.name).toBe("SignedHashFormatError");
    });

    it("should store message and input correctly", () => {
      const error = new SignedHashFormatError("test message", "test input");

      expect(error.message).toBe("test message");
      expect(error.input).toBe("test input");
    });
  });

  describe("Format documentation", () => {
    it("signed format should be sig:<signature>", () => {
      const signature = "SGVsbG8=";
      const result = createSignedFileHash(signature);

      expect(result).toBe(`sig:${signature}`);
      expect(result.startsWith("sig:")).toBe(true);
      expect(result).not.toContain("sha256:");
      expect(result).not.toContain(";");
    });

    it("unsigned format is just plain hex hash (not handled by createSignedFileHash)", () => {
      // Unsigned hashes are just plain hex strings, no special formatting needed
      const plainHash = SAMPLE_HASH;
      expect(isSignedFileHash(plainHash)).toBe(false);
      expect(extractSignature(plainHash)).toBeNull();
    });
  });
});
