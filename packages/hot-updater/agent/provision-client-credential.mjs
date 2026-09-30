import { readFile, writeFile } from "node:fs/promises";

import {
  clientAuthOf,
  generateClientCredential,
  provisionClientCredential,
} from "@hot-updater/server/db";

import * as target from "./database.config.ts";
import { plugins } from "./hotUpdater.plugins.ts";

const { database } = target;

const credentialPath = new URL("./client-credential.local", import.meta.url);
try {
  // The plugin that protects the deployed server's client routes, if any.
  const clientAuth = clientAuthOf(plugins);
  let credential;
  if (clientAuth !== undefined) {
    const { env, label } = clientAuth.credential;
    credential = await readFile(credentialPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const existing = process.env[env]?.trim();
    if (credential && existing && credential.trim() !== existing) {
      throw new Error(
        `Saved client credentials differ. Resolve the target ${label} before provisioning.`,
      );
    }
    if (!credential) {
      credential = existing || generateClientCredential(plugins);
      await writeFile(credentialPath, credential, { flag: "wx", mode: 0o600 });
    }
  }
  // Providers without migration tooling (Firestore) write their schema settings here.
  await target.migrate?.();
  if (clientAuth === undefined) {
    console.log("Client routes are public: there is no client credential.");
  } else {
    // Registered through that plugin, on the tables the deployed server reads.
    await provisionClientCredential(database, plugins, {
      env: { [clientAuth.credential.env]: credential.trim() },
      name: "Agent infrastructure setup",
    });
    console.log(
      `Client ${clientAuth.credential.label} registered. It is saved in client-credential.local.`,
    );
  }
} finally {
  await database.dispose?.();
}
