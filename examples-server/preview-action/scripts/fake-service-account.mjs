// A Play service account key no store ever sees: fake-play.mjs answers its token.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.stdout.write(
  JSON.stringify({
    type: "service_account",
    project_id: "hot-updater-proof",
    client_email: "uploader@hot-updater-proof.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
);
