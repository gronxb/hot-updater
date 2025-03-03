import crypto from "crypto";

export function generateInternalToken(length = 32): string {
  return crypto.randomBytes(length).toString("hex");
}
