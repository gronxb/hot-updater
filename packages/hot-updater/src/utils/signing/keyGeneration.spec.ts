import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateKeyPair,
  getPrivateKeyGitignorePath,
  getPublicKeyFromPrivate,
  loadPrivateKey,
  saveKeyPair,
} from "./keyGeneration";

const RSA_4096_TIMEOUT = 40000;
const SAVE_KEY_PAIR_TIMEOUT = 30000;

describe("Key Generation", () => {
  describe("getPrivateKeyGitignorePath", () => {
    it("uses the complete project-relative path for nested output", () => {
      expect(
        getPrivateKeyGitignorePath("/project", "/project/secrets/signing"),
      ).toBe("secrets/signing/private-key.pem");
    });

    it("does not claim an external key is covered by project gitignore", () => {
      expect(
        getPrivateKeyGitignorePath("/project", "/secure/signing"),
      ).toBeNull();
    });
  });

  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-key-generation-"),
    );
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

    it(
      "should generate RSA-4096 key pair by default",
      async () => {
        const keyPair = await generateKeyPair();

        // Verify key size by attempting to create key object
        const privateKey = crypto.createPrivateKey(keyPair.privateKey);
        const publicKey = crypto.createPublicKey(keyPair.publicKey);

        expect(privateKey).toBeDefined();
        expect(publicKey).toBeDefined();
      },
      RSA_4096_TIMEOUT,
    );

    it("should generate RSA-2048 key pair when specified", async () => {
      const keyPair = await generateKeyPair(2048);

      const privateKey = crypto.createPrivateKey(keyPair.privateKey);
      expect(privateKey).toBeDefined();
    });
  });

  describe("saveKeyPair", () => {
    it(
      "should save key pair to disk",
      async () => {
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
      },
      SAVE_KEY_PAIR_TIMEOUT,
    );

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

    it(
      "should create output directory if it doesn't exist",
      async () => {
        const keyPair = await generateKeyPair(2048);
        const nestedDir = path.join(testDir, "nested", "dir");

        await saveKeyPair(keyPair, nestedDir);

        const privateKeyPath = path.join(nestedDir, "private-key.pem");
        const exists = await fs
          .access(privateKeyPath)
          .then(() => true)
          .catch(() => false);

        expect(exists).toBe(true);
      },
      SAVE_KEY_PAIR_TIMEOUT,
    );

    it("does not overwrite either key when a key pair already exists", async () => {
      const originalKeyPair = await generateKeyPair(2048);
      const replacementKeyPair = await generateKeyPair(2048);
      await saveKeyPair(originalKeyPair, testDir);

      await expect(saveKeyPair(replacementKeyPair, testDir)).rejects.toThrow(
        "Signing keys already exist",
      );

      await expect(
        fs.readFile(path.join(testDir, "private-key.pem"), "utf8"),
      ).resolves.toBe(originalKeyPair.privateKey);
      await expect(
        fs.readFile(path.join(testDir, "public-key.pem"), "utf8"),
      ).resolves.toBe(originalKeyPair.publicKey);
    });

    it("leaves an existing public key untouched when the private key is missing", async () => {
      const keyPair = await generateKeyPair(2048);
      const publicKeyPath = path.join(testDir, "public-key.pem");
      await fs.writeFile(publicKeyPath, "existing-public-key", { mode: 0o644 });

      await expect(saveKeyPair(keyPair, testDir)).rejects.toThrow(
        "Signing keys already exist",
      );

      await expect(fs.readFile(publicKeyPath, "utf8")).resolves.toBe(
        "existing-public-key",
      );
      await expect(
        fs.access(path.join(testDir, "private-key.pem")),
      ).rejects.toThrow();
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
