import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface KeyPair {
  privateKey: string; // PEM format (PKCS#8)
  publicKey: string; // PEM format (SubjectPublicKeyInfo)
}

/**
 * Generate RSA key pair for bundle signing.
 * @param keySize Key size in bits (2048 or 4096)
 * @returns Promise resolving to key pair in PEM format
 */
export async function generateKeyPair(
  keySize: 2048 | 4096 = 4096,
): Promise<KeyPair> {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "rsa",
      {
        modulusLength: keySize,
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      },
      (err, publicKey, privateKey) => {
        if (err) reject(err);
        else resolve({ privateKey, publicKey });
      },
    );
  });
}

/**
 * Save key pair to disk with secure permissions.
 * @param keyPair Generated key pair
 * @param outputDir Directory to save keys
 */
export async function saveKeyPair(
  keyPair: KeyPair,
  outputDir: string,
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  const privateKeyPath = path.join(outputDir, "private-key.pem");
  const publicKeyPath = path.join(outputDir, "public-key.pem");

  // Write with secure permissions (private key readable only by owner)
  await fs.writeFile(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
  await fs.writeFile(publicKeyPath, keyPair.publicKey, { mode: 0o644 });
}

/**
 * Load private key from PEM file.
 * @param privateKeyPath Path to private key file
 * @returns Private key in PEM format
 * @throws Error if file not found or invalid format
 */
export async function loadPrivateKey(privateKeyPath: string): Promise<string> {
  try {
    const privateKey = await fs.readFile(privateKeyPath, "utf-8");

    // Validate it's a valid private key by attempting to create crypto object
    crypto.createPrivateKey(privateKey);

    return privateKey;
  } catch (error) {
    throw new Error(
      `Failed to load private key from ${privateKeyPath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Extract public key from private key.
 * @param privateKeyPEM Private key in PEM format
 * @returns Public key in PEM format
 */
export function getPublicKeyFromPrivate(privateKeyPEM: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPEM);
  return crypto.createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  }) as string;
}
