import crypto from "node:crypto";
import { log } from "@hot-updater/internal";

export const generateSecretKey = () => {
  const secretKey = crypto.randomBytes(32).toString("hex");

  log.normal("SecretKey: ");
  log.info(secretKey);
};
