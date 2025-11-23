import { describe, expect, it } from "vitest";
import {
  createSignedFileHash,
  isSignedFileHash,
  type ParsedFileHash,
  parseFileHash,
  parseFileHashSafe,
  SHA256_PREFIX,
  SIGNED_HASH_PREFIX,
  SIGNED_HASH_SEPARATOR,
  SignedHashFormatError,
} from "./signedHashUtils";

// Test data constants
const SAMPLE_HASH =
  "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
const SAMPLE_SIGNATURE = "MEUCIQDKZokqTesting+Base64/Signature==";
const SIGNED_FORMAT = `sig:${SAMPLE_SIGNATURE};sha256:${SAMPLE_HASH}`;

// Additional test data
const UPPERCASE_HASH =
  "A1B2C3D4E5F6789012345678901234567890123456789012345678901234ABCD";
const MIXED_CASE_HASH =
  "a1B2c3D4e5F6789012345678901234567890123456789012345678901234AbCd";
const SHORT_HASH = "abc123";
const SIMPLE_SIGNATURE = "dGVzdA==";
const ALL_BASE64_CHARS_SIGNATURE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==";
const LONG_SIGNATURE = `${"A".repeat(500)}==`;

describe("signedHashUtils", () => {
  describe("Constants", () => {
    it("should export correct prefix constants", () => {
      expect(SIGNED_HASH_PREFIX).toBe("sig:");
      expect(SHA256_PREFIX).toBe("sha256:");
      expect(SIGNED_HASH_SEPARATOR).toBe(";");
    });
  });

  describe("createSignedFileHash", () => {
    it("should create correct signed hash format", () => {
      const result = createSignedFileHash(SAMPLE_HASH, SAMPLE_SIGNATURE);

      expect(result).toBe(SIGNED_FORMAT);
      expect(result).toMatch(/^sig:.+;sha256:[a-fA-F0-9]+$/);
    });

    it("should create correct format with simple signature", () => {
      const result = createSignedFileHash(SAMPLE_HASH, SIMPLE_SIGNATURE);

      expect(result).toBe(`sig:${SIMPLE_SIGNATURE};sha256:${SAMPLE_HASH}`);
    });

    it("should handle signatures with base64 special characters (+, /, =)", () => {
      const signatureWithSpecialChars = "MEUCIQDKZokq+Test/Value==";
      const result = createSignedFileHash(
        SAMPLE_HASH,
        signatureWithSpecialChars,
      );

      expect(result).toBe(
        `sig:${signatureWithSpecialChars};sha256:${SAMPLE_HASH}`,
      );
      expect(result).toContain("+");
      expect(result).toContain("/");
      expect(result).toContain("==");
    });

    it("should handle signatures with all base64 special characters", () => {
      const result = createSignedFileHash(
        SAMPLE_HASH,
        ALL_BASE64_CHARS_SIGNATURE,
      );

      expect(result).toBe(
        `sig:${ALL_BASE64_CHARS_SIGNATURE};sha256:${SAMPLE_HASH}`,
      );
    });

    it("should handle very long signatures", () => {
      const result = createSignedFileHash(SAMPLE_HASH, LONG_SIGNATURE);

      expect(result).toBe(`sig:${LONG_SIGNATURE};sha256:${SAMPLE_HASH}`);
      expect(result.length).toBeGreaterThan(500);
    });

    it("should handle uppercase hash", () => {
      const result = createSignedFileHash(UPPERCASE_HASH, SAMPLE_SIGNATURE);

      expect(result).toBe(`sig:${SAMPLE_SIGNATURE};sha256:${UPPERCASE_HASH}`);
    });

    it("should handle mixed case hash", () => {
      const result = createSignedFileHash(MIXED_CASE_HASH, SAMPLE_SIGNATURE);

      expect(result).toBe(`sig:${SAMPLE_SIGNATURE};sha256:${MIXED_CASE_HASH}`);
    });

    it("should handle short hash", () => {
      const result = createSignedFileHash(SHORT_HASH, SAMPLE_SIGNATURE);

      expect(result).toBe(`sig:${SAMPLE_SIGNATURE};sha256:${SHORT_HASH}`);
    });

    it("should throw SignedHashFormatError for empty hash", () => {
      expect(() => createSignedFileHash("", SAMPLE_SIGNATURE)).toThrow(
        SignedHashFormatError,
      );
      expect(() => createSignedFileHash("", SAMPLE_SIGNATURE)).toThrow(
        /Invalid hash format/,
      );
    });

    it("should throw SignedHashFormatError for non-hex hash", () => {
      expect(() =>
        createSignedFileHash("not-a-hex-hash!", SAMPLE_SIGNATURE),
      ).toThrow(SignedHashFormatError);
      expect(() => createSignedFileHash("ghijklmn", SAMPLE_SIGNATURE)).toThrow(
        /Invalid hash format/,
      );
    });

    it("should throw SignedHashFormatError for hash with spaces", () => {
      expect(() => createSignedFileHash("abc 123", SAMPLE_SIGNATURE)).toThrow(
        SignedHashFormatError,
      );
    });

    it("should throw SignedHashFormatError for empty signature", () => {
      expect(() => createSignedFileHash(SAMPLE_HASH, "")).toThrow(
        SignedHashFormatError,
      );
      expect(() => createSignedFileHash(SAMPLE_HASH, "")).toThrow(
        /signature cannot be empty/,
      );
    });

    it("should throw SignedHashFormatError for whitespace-only signature", () => {
      expect(() => createSignedFileHash(SAMPLE_HASH, "   ")).toThrow(
        SignedHashFormatError,
      );
      expect(() => createSignedFileHash(SAMPLE_HASH, "\t\n")).toThrow(
        SignedHashFormatError,
      );
    });

    it("should include input in SignedHashFormatError for invalid hash", () => {
      const invalidHash = "invalid!hash";
      try {
        createSignedFileHash(invalidHash, SAMPLE_SIGNATURE);
        expect.fail("Should have thrown SignedHashFormatError");
      } catch (error) {
        expect(error).toBeInstanceOf(SignedHashFormatError);
        expect((error as SignedHashFormatError).input).toBe(invalidHash);
      }
    });
  });

  describe("parseFileHash", () => {
    describe("signed format parsing", () => {
      it("should parse new signed format correctly", () => {
        const result = parseFileHash(SIGNED_FORMAT);

        expect(result).toEqual({
          hash: SAMPLE_HASH,
          signature: SAMPLE_SIGNATURE,
          isSigned: true,
        });
      });

      it("should extract hash correctly from signed format", () => {
        const result = parseFileHash(SIGNED_FORMAT);

        expect(result.hash).toBe(SAMPLE_HASH);
      });

      it("should extract signature correctly from signed format", () => {
        const result = parseFileHash(SIGNED_FORMAT);

        expect(result.signature).toBe(SAMPLE_SIGNATURE);
      });

      it("should set isSigned to true for signed format", () => {
        const result = parseFileHash(SIGNED_FORMAT);

        expect(result.isSigned).toBe(true);
      });

      it("should preserve original hash exactly (case-sensitive)", () => {
        const signedWithUppercase = `sig:${SAMPLE_SIGNATURE};sha256:${UPPERCASE_HASH}`;
        const result = parseFileHash(signedWithUppercase);

        expect(result.hash).toBe(UPPERCASE_HASH);
      });

      it("should preserve signature exactly (special chars)", () => {
        const specialSig = "MEUCIQDKZokq+Test/Value==";
        const signed = `sig:${specialSig};sha256:${SAMPLE_HASH}`;
        const result = parseFileHash(signed);

        expect(result.signature).toBe(specialSig);
      });

      it("should handle very long signatures", () => {
        const signed = `sig:${LONG_SIGNATURE};sha256:${SAMPLE_HASH}`;
        const result = parseFileHash(signed);

        expect(result.signature).toBe(LONG_SIGNATURE);
        expect(result.hash).toBe(SAMPLE_HASH);
      });

      it("should handle signatures with all base64 special characters", () => {
        const signed = `sig:${ALL_BASE64_CHARS_SIGNATURE};sha256:${SAMPLE_HASH}`;
        const result = parseFileHash(signed);

        expect(result.signature).toBe(ALL_BASE64_CHARS_SIGNATURE);
      });
    });

    describe("legacy unsigned format parsing", () => {
      it("should parse legacy unsigned format correctly", () => {
        const result = parseFileHash(SAMPLE_HASH);

        expect(result).toEqual({
          hash: SAMPLE_HASH,
          signature: null,
          isSigned: false,
        });
      });

      it("should return hash with signature null for plain hash", () => {
        const result = parseFileHash(SAMPLE_HASH);

        expect(result.signature).toBeNull();
      });

      it("should return isSigned false for plain hash", () => {
        const result = parseFileHash(SAMPLE_HASH);

        expect(result.isSigned).toBe(false);
      });

      it("should handle uppercase plain hash", () => {
        const result = parseFileHash(UPPERCASE_HASH);

        expect(result.hash).toBe(UPPERCASE_HASH);
        expect(result.isSigned).toBe(false);
      });

      it("should handle mixed case plain hash", () => {
        const result = parseFileHash(MIXED_CASE_HASH);

        expect(result.hash).toBe(MIXED_CASE_HASH);
      });

      it("should handle short plain hash", () => {
        const result = parseFileHash(SHORT_HASH);

        expect(result.hash).toBe(SHORT_HASH);
      });

      it("should trim whitespace from plain hash", () => {
        const result = parseFileHash(`  ${SAMPLE_HASH}  `);

        expect(result.hash).toBe(SAMPLE_HASH);
      });
    });

    describe("error handling", () => {
      it("should throw SignedHashFormatError for malformed input (has sig: but no ;sha256:)", () => {
        const malformed = "sig:somesignature-without-hash-section";

        expect(() => parseFileHash(malformed)).toThrow(SignedHashFormatError);
        expect(() => parseFileHash(malformed)).toThrow(
          /Malformed signed hash format/,
        );
      });

      it("should throw SignedHashFormatError for sig: without proper structure", () => {
        const malformed = "sig:onlysignature";

        expect(() => parseFileHash(malformed)).toThrow(SignedHashFormatError);
      });

      it("should throw SignedHashFormatError for ;sha256: without sig:", () => {
        const malformed = ";sha256:abc123";

        expect(() => parseFileHash(malformed)).toThrow(SignedHashFormatError);
        expect(() => parseFileHash(malformed)).toThrow(/Invalid hash format/);
      });

      it("should throw SignedHashFormatError for empty string", () => {
        expect(() => parseFileHash("")).toThrow(SignedHashFormatError);
        expect(() => parseFileHash("")).toThrow(/cannot be empty/);
      });

      it("should throw SignedHashFormatError for whitespace-only string", () => {
        expect(() => parseFileHash("   ")).toThrow(SignedHashFormatError);
        expect(() => parseFileHash("\t\n")).toThrow(SignedHashFormatError);
      });

      it("should throw SignedHashFormatError for non-hex plain hash", () => {
        expect(() => parseFileHash("not-a-hex-hash!")).toThrow(
          SignedHashFormatError,
        );
        expect(() => parseFileHash("ghijklmn")).toThrow(/Invalid hash format/);
      });

      it("should throw SignedHashFormatError for plain hash with spaces", () => {
        expect(() => parseFileHash("abc 123")).toThrow(SignedHashFormatError);
      });

      it("should throw for input that looks like signed but is not quite right", () => {
        // Missing semicolon
        expect(() => parseFileHash("sig:abcsha256:def")).toThrow(
          SignedHashFormatError,
        );

        // Extra characters after hash
        expect(() => parseFileHash("sig:abc;sha256:def123;extra")).toThrow(
          SignedHashFormatError,
        );

        // Wrong prefix order
        expect(() => parseFileHash("sha256:abc;sig:def")).toThrow(
          SignedHashFormatError,
        );

        // Missing signature value
        expect(() => parseFileHash("sig:;sha256:abc123")).toThrow(
          SignedHashFormatError,
        );
      });

      it("should throw for sig: with non-hex hash part", () => {
        expect(() => parseFileHash("sig:signature;sha256:not-hex!")).toThrow(
          SignedHashFormatError,
        );
      });

      it("should include input in SignedHashFormatError for malformed signed format", () => {
        const malformed = "sig:bad-format";
        try {
          parseFileHash(malformed);
          expect.fail("Should have thrown SignedHashFormatError");
        } catch (error) {
          expect(error).toBeInstanceOf(SignedHashFormatError);
          expect((error as SignedHashFormatError).input).toBe(malformed);
        }
      });

      it("should truncate long input in error message", () => {
        const veryLongInput = `sig:${"x".repeat(100)}`;
        try {
          parseFileHash(veryLongInput);
          expect.fail("Should have thrown SignedHashFormatError");
        } catch (error) {
          expect(error).toBeInstanceOf(SignedHashFormatError);
          expect((error as SignedHashFormatError).message).toContain("...");
        }
      });
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
      // TypeScript would normally prevent these, but testing runtime behavior
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

    it("should return true even for malformed signed format (quick check only)", () => {
      // isSignedFileHash is a quick check, not full validation
      expect(isSignedFileHash("sig:malformed-no-hash")).toBe(true);
    });
  });

  describe("parseFileHashSafe", () => {
    it("should return parsed result for valid signed input", () => {
      const result = parseFileHashSafe(SIGNED_FORMAT);

      expect(result).not.toBeNull();
      expect(result).toEqual({
        hash: SAMPLE_HASH,
        signature: SAMPLE_SIGNATURE,
        isSigned: true,
      });
    });

    it("should return parsed result for valid plain hash input", () => {
      const result = parseFileHashSafe(SAMPLE_HASH);

      expect(result).not.toBeNull();
      expect(result).toEqual({
        hash: SAMPLE_HASH,
        signature: null,
        isSigned: false,
      });
    });

    it("should return null for null input", () => {
      expect(parseFileHashSafe(null)).toBeNull();
    });

    it("should return null for undefined input", () => {
      expect(parseFileHashSafe(undefined)).toBeNull();
    });

    it("should return null for empty string input", () => {
      expect(parseFileHashSafe("")).toBeNull();
    });

    it("should return null (not throw) for malformed input", () => {
      expect(parseFileHashSafe("sig:malformed")).toBeNull();
      expect(parseFileHashSafe("not-hex-hash!")).toBeNull();
      expect(parseFileHashSafe("sig:;sha256:")).toBeNull();
    });

    it("should return null for invalid non-hex plain hash", () => {
      expect(parseFileHashSafe("ghijklmn")).toBeNull();
    });

    it("should handle whitespace gracefully", () => {
      // Valid input with whitespace
      const result = parseFileHashSafe(`  ${SAMPLE_HASH}  `);
      expect(result).not.toBeNull();
      expect(result?.hash).toBe(SAMPLE_HASH);

      // Whitespace only
      expect(parseFileHashSafe("   ")).toBeNull();
    });
  });

  describe("Round-trip tests", () => {
    it("should preserve hash and signature through create and parse cycle", () => {
      const original = {
        hash: SAMPLE_HASH,
        signature: SAMPLE_SIGNATURE,
      };

      const signed = createSignedFileHash(original.hash, original.signature);
      const parsed = parseFileHash(signed);

      expect(parsed.hash).toBe(original.hash);
      expect(parsed.signature).toBe(original.signature);
      expect(parsed.isSigned).toBe(true);
    });

    it("should round-trip with various hash lengths", () => {
      const testHashes = [
        "a1b2", // Very short
        "a1b2c3d4e5f6", // Short
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", // 32 chars (MD5 length)
        SAMPLE_HASH, // 64 chars (SHA256 length)
        "a".repeat(128), // 128 chars (SHA512 length)
      ];

      for (const hash of testHashes) {
        const signed = createSignedFileHash(hash, SAMPLE_SIGNATURE);
        const parsed = parseFileHash(signed);

        expect(parsed.hash).toBe(hash);
        expect(parsed.signature).toBe(SAMPLE_SIGNATURE);
      }
    });

    it("should round-trip with various signature types", () => {
      const testSignatures = [
        SIMPLE_SIGNATURE, // Simple
        SAMPLE_SIGNATURE, // With special chars
        ALL_BASE64_CHARS_SIGNATURE, // All base64 chars
        LONG_SIGNATURE, // Very long
        "a", // Single character
        "ab", // Two characters
      ];

      for (const signature of testSignatures) {
        const signed = createSignedFileHash(SAMPLE_HASH, signature);
        const parsed = parseFileHash(signed);

        expect(parsed.signature).toBe(signature);
        expect(parsed.hash).toBe(SAMPLE_HASH);
      }
    });

    it("should maintain exact case through round-trip", () => {
      const hashes = [SAMPLE_HASH, UPPERCASE_HASH, MIXED_CASE_HASH];

      for (const hash of hashes) {
        const signed = createSignedFileHash(hash, SAMPLE_SIGNATURE);
        const parsed = parseFileHash(signed);

        expect(parsed.hash).toBe(hash);
      }
    });
  });

  describe("ParsedFileHash interface", () => {
    it("should have correct structure for signed hash", () => {
      const result: ParsedFileHash = parseFileHash(SIGNED_FORMAT);

      expect(typeof result.hash).toBe("string");
      expect(typeof result.signature).toBe("string");
      expect(typeof result.isSigned).toBe("boolean");
      expect(result.isSigned).toBe(true);
    });

    it("should have correct structure for unsigned hash", () => {
      const result: ParsedFileHash = parseFileHash(SAMPLE_HASH);

      expect(typeof result.hash).toBe("string");
      expect(result.signature).toBeNull();
      expect(typeof result.isSigned).toBe("boolean");
      expect(result.isSigned).toBe(false);
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

    it("should have readonly input property", () => {
      const error = new SignedHashFormatError("test message", "test input");

      // TypeScript enforces readonly, but verify the value is preserved
      expect(error.input).toBe("test input");
    });
  });

  describe("Edge cases", () => {
    it("should handle hash that is all zeros", () => {
      const zeroHash = "0".repeat(64);
      const signed = createSignedFileHash(zeroHash, SAMPLE_SIGNATURE);
      const parsed = parseFileHash(signed);

      expect(parsed.hash).toBe(zeroHash);
    });

    it("should handle hash that is all f's", () => {
      const fHash = "f".repeat(64);
      const signed = createSignedFileHash(fHash, SAMPLE_SIGNATURE);
      const parsed = parseFileHash(signed);

      expect(parsed.hash).toBe(fHash);
    });

    it("should handle signature that looks like hash format", () => {
      // Signature that contains sha256: inside it
      const trickySignature = "sha256:notarealfaketest==";
      const signed = createSignedFileHash(SAMPLE_HASH, trickySignature);
      const parsed = parseFileHash(signed);

      expect(parsed.signature).toBe(trickySignature);
      expect(parsed.hash).toBe(SAMPLE_HASH);
    });

    it("should reject signature with semicolon characters", () => {
      // Semicolons in the signature break the format because the regex expects
      // the signature to not contain semicolons (;sha256: is the delimiter).
      // This is expected behavior since base64 doesn't include semicolons anyway.
      const signatureWithSemicolon = "part1;part2==";
      const signed = `sig:${signatureWithSemicolon};sha256:${SAMPLE_HASH}`;

      // The regex fails to match because of the extra semicolon
      expect(() => parseFileHash(signed)).toThrow(SignedHashFormatError);
      expect(() => parseFileHash(signed)).toThrow(
        /Malformed signed hash format/,
      );
    });

    it("should correctly identify format after parsing various inputs", () => {
      const testCases: Array<{ input: string; expectedSigned: boolean }> = [
        { input: SIGNED_FORMAT, expectedSigned: true },
        { input: SAMPLE_HASH, expectedSigned: false },
        { input: `sig:x;sha256:abc`, expectedSigned: true },
        { input: "deadbeef", expectedSigned: false },
      ];

      for (const { input, expectedSigned } of testCases) {
        const parsed = parseFileHash(input);
        expect(parsed.isSigned).toBe(expectedSigned);
        expect(isSignedFileHash(input)).toBe(
          expectedSigned || input.startsWith("sig:"),
        );
      }
    });
  });

  describe("Acceptance criteria from SIGNATURE_FIELD_REFACTORING_PLAN.md", () => {
    it('createSignedFileHash("abc123...", "SGVsbG8=") returns correct format', () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234";
      const signature = "SGVsbG8=";

      const result = createSignedFileHash(hash, signature);

      expect(result).toBe(`sig:${signature};sha256:${hash}`);
    });

    it("parseFileHash signed format returns correct object", () => {
      const hash =
        "def123456789012345678901234567890123456789012345678901234567";
      const signature = "SGVsbG8=";
      const input = `sig:${signature};sha256:${hash}`;

      const result = parseFileHash(input);

      expect(result).toEqual({
        hash: hash,
        signature: signature,
        isSigned: true,
      });
    });

    it("parseFileHash unsigned format returns correct object", () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234";

      const result = parseFileHash(hash);

      expect(result).toEqual({
        hash: hash,
        signature: null,
        isSigned: false,
      });
    });

    it('isSignedFileHash("sig:...;sha256:...") returns true', () => {
      expect(isSignedFileHash("sig:abc;sha256:def123")).toBe(true);
    });

    it('isSignedFileHash("abc123...") returns false', () => {
      expect(isSignedFileHash("abc123def456")).toBe(false);
    });
  });
});
