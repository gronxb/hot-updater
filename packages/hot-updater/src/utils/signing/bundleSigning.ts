import crypto from "node:crypto";
import { loadPrivateKey } from "./keyGeneration";

/**
 * Sign bundle fileHash with private key.
 * @param fileHash SHA-256 hash of bundle (hex string)
 * @param privateKeyPath Path to private key file
 * @returns Base64-encoded RSA-SHA256 signature
 */
export async function signBundle(
  fileHash: string,
  privateKeyPath: string,
): Promise<string> {
  const privateKeyPEM = await loadPrivateKey(privateKeyPath);

  // Convert hex fileHash to buffer
  const fileHashBuffer = Buffer.from(fileHash, "hex");

  // Create RSA-SHA256 signature
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(fileHashBuffer);
  sign.end();

  const signature = sign.sign(privateKeyPEM);

  // Return base64-encoded signature
  return signature.toString("base64");
}

/**
 * Verify bundle signature (for testing).
 * @param fileHash SHA-256 hash of bundle (hex string)
 * @param signature Base64-encoded signature
 * @param publicKeyPEM Public key in PEM format
 * @returns true if signature valid, false otherwise
 */
export function verifySignature(
  fileHash: string,
  signature: string,
  publicKeyPEM: string,
): boolean {
  try {
    const fileHashBuffer = Buffer.from(fileHash, "hex");
    const signatureBuffer = Buffer.from(signature, "base64");

    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(fileHashBuffer);
    verify.end();

    return verify.verify(publicKeyPEM, signatureBuffer);
  } catch {
    return false;
  }
}
