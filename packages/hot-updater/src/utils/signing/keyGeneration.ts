import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface KeyPair {
  privateKey: string; // PEM format (PKCS#8)
  publicKey: string; // PEM format (SubjectPublicKeyInfo)
}

export function getPrivateKeyGitignorePath(
  cwd: string,
  outputDir: string,
): string | null {
  const relativePath = path.relative(
    cwd,
    path.join(outputDir, "private-key.pem"),
  );
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join("/");
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
  let privateKeyFile: Awaited<ReturnType<typeof fs.open>> | undefined;
  let publicKeyFile: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    privateKeyFile = await fs.open(privateKeyPath, "wx", 0o600);
    publicKeyFile = await fs.open(publicKeyPath, "wx", 0o644);

    await Promise.all([
      privateKeyFile.writeFile(keyPair.privateKey),
      publicKeyFile.writeFile(keyPair.publicKey),
    ]);
  } catch (error) {
    await Promise.allSettled([privateKeyFile?.close(), publicKeyFile?.close()]);
    await Promise.allSettled([
      privateKeyFile && fs.rm(privateKeyPath, { force: true }),
      publicKeyFile && fs.rm(publicKeyPath, { force: true }),
    ]);

    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Signing keys already exist in ${outputDir}. Move them before generating a new key pair.`,
      );
    }
    throw error;
  }

  await Promise.all([privateKeyFile.close(), publicKeyFile.close()]);
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
