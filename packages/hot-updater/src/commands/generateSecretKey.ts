import crypto from "crypto";
import { text } from "@clack/prompts";

export const generateSecretKey = async () => {
  const secretKey = crypto.randomBytes(32).toString("hex");

  await text({
    message: "Secret Key: ",
    initialValue: secretKey,
  });
};
