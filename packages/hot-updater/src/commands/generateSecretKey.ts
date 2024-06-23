import crypto from "node:crypto";
import { log } from "@/utils/log";

export const generateSecretKey = () => {
  const secretKey = crypto.randomBytes(32).toString("hex");

  log.normal("SecretKey: ");
  log.info(secretKey);
};
