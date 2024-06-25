import crypto from "node:crypto";
import { isObject } from "./isObject";

export const encryptJson = (
  jsonData: Record<string, any>,
  secretKey: string,
) => {
  if (isObject(jsonData) === false) {
    throw new Error("jsonData must be an object");
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(secretKey, "hex"),
    iv,
  );
  let encrypted = cipher.update(JSON.stringify(jsonData));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return [iv.toString("hex"), encrypted.toString("hex")].join(":");
};

export const decryptJson = <T>(encryptedData: string, secretKey: string) => {
  const parts = encryptedData.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const encryptedText = Buffer.from(parts[1], "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(secretKey, "hex"),
    iv,
  );
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString()) as T;
};
