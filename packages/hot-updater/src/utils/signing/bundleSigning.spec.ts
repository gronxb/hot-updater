import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signBundle, verifySignature } from "./bundleSigning";
import { generateKeyPair, saveKeyPair } from "./keyGeneration";

describe("Bundle Signing", () => {
  let testDir: string;
  let privateKeyPath: string;
  let publicKeyPEM: string;

  beforeEach(async () => {
    testDir = path.join(__dirname, `.test-keys-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Generate test key pair (2048 for faster tests)
    const keyPair = await generateKeyPair(2048);
    await saveKeyPair(keyPair, testDir);

    privateKeyPath = path.join(testDir, "private-key.pem");
    publicKeyPEM = keyPair.publicKey;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("signBundle", () => {
    it("should sign bundle fileHash and return base64 signature", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");

      const signature = await signBundle(testHash, privateKeyPath);

      expect(signature).toBeTruthy();
      expect(signature.length).toBeGreaterThan(0);
      expect(typeof signature).toBe("string");

      // Verify it's valid base64
      expect(() => Buffer.from(signature, "base64")).not.toThrow();
    });

    it("should produce consistent signatures for same input", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");

      const signature1 = await signBundle(testHash, privateKeyPath);
      const signature2 = await signBundle(testHash, privateKeyPath);

      expect(signature1).toBe(signature2);
    });

    it("should produce different signatures for different inputs", async () => {
      const hash1 = crypto
        .createHash("sha256")
        .update("test bundle 1")
        .digest("hex");
      const hash2 = crypto
        .createHash("sha256")
        .update("test bundle 2")
        .digest("hex");

      const signature1 = await signBundle(hash1, privateKeyPath);
      const signature2 = await signBundle(hash2, privateKeyPath);

      expect(signature1).not.toBe(signature2);
    });

    it("should throw error for invalid private key path", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const invalidPath = path.join(testDir, "nonexistent.pem");

      await expect(signBundle(testHash, invalidPath)).rejects.toThrow(
        /Failed to load private key/,
      );
    });
  });

  describe("verifySignature", () => {
    it("should verify valid signature", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const signature = await signBundle(testHash, privateKeyPath);

      const isValid = verifySignature(testHash, signature, publicKeyPEM);

      expect(isValid).toBe(true);
    });

    it("should reject invalid signature", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const invalidSignature = "invalid-signature-base64";

      const isValid = verifySignature(testHash, invalidSignature, publicKeyPEM);

      expect(isValid).toBe(false);
    });

    it("should reject signature with tampered fileHash", async () => {
      const originalHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const signature = await signBundle(originalHash, privateKeyPath);

      const tamperedHash = crypto
        .createHash("sha256")
        .update("tampered bundle")
        .digest("hex");

      const isValid = verifySignature(tamperedHash, signature, publicKeyPEM);

      expect(isValid).toBe(false);
    });

    it("should reject signature with wrong public key", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const signature = await signBundle(testHash, privateKeyPath);

      // Generate different key pair
      const differentKeyPair = await generateKeyPair(2048);

      const isValid = verifySignature(
        testHash,
        signature,
        differentKeyPair.publicKey,
      );

      expect(isValid).toBe(false);
    });

    it("should handle corrupted signature gracefully", async () => {
      const testHash = crypto
        .createHash("sha256")
        .update("test bundle")
        .digest("hex");
      const signature = await signBundle(testHash, privateKeyPath);

      // Corrupt the signature
      const corruptedSignature = `${signature.slice(0, -5)}XXXXX`;

      const isValid = verifySignature(
        testHash,
        corruptedSignature,
        publicKeyPEM,
      );

      expect(isValid).toBe(false);
    });

    it("should verify round-trip signing and verification", async () => {
      // Test with multiple hashes
      const testCases = [
        "test bundle 1",
        "test bundle 2",
        "a".repeat(1000), // Large content
        "", // Empty
      ];

      for (const content of testCases) {
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        const signature = await signBundle(hash, privateKeyPath);
        const isValid = verifySignature(hash, signature, publicKeyPEM);

        expect(isValid).toBe(true);
      }
    });
  });

  describe("Integration: Sign and Verify", () => {
    it("should successfully sign and verify real bundle scenario", async () => {
      // Simulate real bundle deployment
      const bundleContent = "React Native bundle content...";
      const fileHash = crypto
        .createHash("sha256")
        .update(bundleContent)
        .digest("hex");

      // Deploy: Sign the bundle
      const signature = await signBundle(fileHash, privateKeyPath);
      expect(signature).toBeTruthy();

      // Client: Download and verify
      const downloadedHash = crypto
        .createHash("sha256")
        .update(bundleContent)
        .digest("hex");

      const isValid = verifySignature(downloadedHash, signature, publicKeyPEM);
      expect(isValid).toBe(true);
    });

    it("should detect tampered bundle", async () => {
      const originalContent = "Original bundle content";
      const originalHash = crypto
        .createHash("sha256")
        .update(originalContent)
        .digest("hex");

      const signature = await signBundle(originalHash, privateKeyPath);

      // Attacker tampers with bundle
      const tamperedContent = "Malicious bundle content";
      const tamperedHash = crypto
        .createHash("sha256")
        .update(tamperedContent)
        .digest("hex");

      const isValid = verifySignature(tamperedHash, signature, publicKeyPEM);
      expect(isValid).toBe(false);
    });
  });
});
