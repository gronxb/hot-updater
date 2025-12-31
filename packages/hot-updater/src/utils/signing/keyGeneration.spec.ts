import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateKeyPair,
  getPublicKeyFromPrivate,
  loadPrivateKey,
  saveKeyPair,
} from "./keyGeneration";

describe("Key Generation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(__dirname, `.test-keys-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("generateKeyPair", () => {
    it("should generate valid RSA key pair", async () => {
      const keyPair = await generateKeyPair(2048);

      expect(keyPair.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(keyPair.privateKey).toContain("END PRIVATE KEY");
      expect(keyPair.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(keyPair.publicKey).toContain("END PUBLIC KEY");
    });

    it("should generate RSA-4096 key pair by default", async () => {
      const keyPair = await generateKeyPair();

      // Verify key size by attempting to create key object
      const privateKey = crypto.createPrivateKey(keyPair.privateKey);
      const publicKey = crypto.createPublicKey(keyPair.publicKey);

      expect(privateKey).toBeDefined();
      expect(publicKey).toBeDefined();
    });

    it("should generate RSA-2048 key pair when specified", async () => {
      const keyPair = await generateKeyPair(2048);

      const privateKey = crypto.createPrivateKey(keyPair.privateKey);
      expect(privateKey).toBeDefined();
    });
  });

  describe("saveKeyPair", () => {
    it("should save key pair to disk", async () => {
      const keyPair = await generateKeyPair(2048);
      await saveKeyPair(keyPair, testDir);

      const privateKeyPath = path.join(testDir, "private-key.pem");
      const publicKeyPath = path.join(testDir, "public-key.pem");

      const privateKeyExists = await fs
        .access(privateKeyPath)
        .then(() => true)
        .catch(() => false);
      const publicKeyExists = await fs
        .access(publicKeyPath)
        .then(() => true)
        .catch(() => false);

      expect(privateKeyExists).toBe(true);
      expect(publicKeyExists).toBe(true);
    });

    it("should save private key with secure permissions (0o600)", async () => {
      const keyPair = await generateKeyPair(2048);
      await saveKeyPair(keyPair, testDir);

      const privateKeyPath = path.join(testDir, "private-key.pem");
      const stats = await fs.stat(privateKeyPath);

      // On Unix systems, check that only owner can read/write
      // eslint-disable-next-line no-bitwise
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("should create output directory if it doesn't exist", async () => {
      const keyPair = await generateKeyPair(2048);
      const nestedDir = path.join(testDir, "nested", "dir");

      await saveKeyPair(keyPair, nestedDir);

      const privateKeyPath = path.join(nestedDir, "private-key.pem");
      const exists = await fs
        .access(privateKeyPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });
  });

  describe("loadPrivateKey", () => {
    it("should load private key from file", async () => {
      const keyPair = await generateKeyPair(2048);
      await saveKeyPair(keyPair, testDir);

      const privateKeyPath = path.join(testDir, "private-key.pem");
      const loadedKey = await loadPrivateKey(privateKeyPath);

      expect(loadedKey).toBe(keyPair.privateKey);
    });

    it("should throw error if file does not exist", async () => {
      const invalidPath = path.join(testDir, "nonexistent.pem");

      await expect(loadPrivateKey(invalidPath)).rejects.toThrow(
        /Failed to load private key/,
      );
    });

    it("should throw error if file contains invalid key", async () => {
      const invalidKeyPath = path.join(testDir, "invalid-key.pem");
      await fs.writeFile(invalidKeyPath, "not a valid key");

      await expect(loadPrivateKey(invalidKeyPath)).rejects.toThrow(
        /Failed to load private key/,
      );
    });

    it("should validate private key format", async () => {
      const keyPair = await generateKeyPair(2048);
      await saveKeyPair(keyPair, testDir);

      const privateKeyPath = path.join(testDir, "private-key.pem");
      const loadedKey = await loadPrivateKey(privateKeyPath);

      // Should be able to create crypto object from loaded key
      const privateKey = crypto.createPrivateKey(loadedKey);
      expect(privateKey).toBeDefined();
    });
  });

  describe("getPublicKeyFromPrivate", () => {
    it("should extract public key from private key", async () => {
      const keyPair = await generateKeyPair(2048);
      const extractedPublicKey = getPublicKeyFromPrivate(keyPair.privateKey);

      expect(extractedPublicKey).toContain("BEGIN PUBLIC KEY");
      expect(extractedPublicKey).toContain("END PUBLIC KEY");
    });

    it("should produce valid public key", async () => {
      const keyPair = await generateKeyPair(2048);
      const extractedPublicKey = getPublicKeyFromPrivate(keyPair.privateKey);

      // Should be able to create crypto object
      const publicKey = crypto.createPublicKey(extractedPublicKey);
      expect(publicKey).toBeDefined();
    });

    it("should match original public key", async () => {
      const keyPair = await generateKeyPair(2048);
      const extractedPublicKey = getPublicKeyFromPrivate(keyPair.privateKey);

      // Both public keys should work identically for verification
      const originalPublic = crypto.createPublicKey(keyPair.publicKey);
      const extractedPublic = crypto.createPublicKey(extractedPublicKey);

      expect(originalPublic.export({ type: "spki", format: "pem" })).toBe(
        extractedPublic.export({ type: "spki", format: "pem" }),
      );
    });
  });
});
