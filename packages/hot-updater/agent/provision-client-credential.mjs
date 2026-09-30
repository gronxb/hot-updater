import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  clientAuthOf,
  generateClientCredential,
  provisionClientCredential,
  serverDefinitionOf,
} from "@hot-updater/server/db";

// The server definition reads process.env when it loads, so the settings go
// first; a static import would load it before them.
if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}
const { hotUpdater } = await import("./hotUpdater.ts");
const definition = serverDefinitionOf(hotUpdater);
if (definition === undefined) {
  throw new Error(
    "hotUpdater.ts must export `hotUpdater`, the server createHotUpdater from @hot-updater/server returns.",
  );
}
const { database, plugins } = definition;

const credentialPath = new URL("./client-credential.local", import.meta.url);
// Providers without migration tooling (Firestore) ship migrate.ts.
const migrationPath = new URL("./migrate.ts", import.meta.url);
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
  if (existsSync(migrationPath)) {
    // It writes the schema settings of core and the deployed server's
    // plugins, which the database checks before its first read.
    const { migrate } = await import(migrationPath.href);
    await migrate(plugins);
  }
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
