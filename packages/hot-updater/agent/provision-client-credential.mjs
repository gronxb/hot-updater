import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

// The server definition reads process.env when it loads, so the settings go
// first; a static import would load it before them.
if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}
const { hotUpdater } = await import("./hotUpdater.ts");
if (
  typeof hotUpdater !== "object" ||
  hotUpdater === null ||
  typeof hotUpdater.database !== "object" ||
  !Array.isArray(hotUpdater.plugins) ||
  typeof hotUpdater.api !== "object"
) {
  throw new Error(
    "hotUpdater.ts must export `hotUpdater`, the server createHotUpdater from @hot-updater/server returns.",
  );
}
const { api, clientAuth, database, plugins } = hotUpdater;

const credentialPath = new URL("./client-credential.local", import.meta.url);
// Providers without migration tooling (Firestore) ship migrate.ts.
const migrationPath = new URL("./migrate.ts", import.meta.url);
try {
  // The plugin that protects the deployed server's client routes, if any,
  // and the credential an app sends it.
  const clientCredential =
    clientAuth === undefined
      ? undefined
      : plugins.find(({ id }) => id === clientAuth.plugin)?.cli
          ?.clientCredential;
  if (
    clientAuth !== undefined &&
    (typeof clientCredential !== "object" ||
      clientCredential === null ||
      typeof clientCredential.label !== "string" ||
      typeof clientCredential.header !== "string" ||
      typeof clientCredential.env !== "string" ||
      typeof clientCredential.generate !== "function" ||
      typeof clientCredential.provision !== "function")
  ) {
    throw new Error(
      `Plugin "${clientAuth.plugin}" provides clientAuth but no cli.clientCredential with a label, header, env, generate, and provision, so the app cannot get its credential.`,
    );
  }
  let credential;
  if (clientCredential !== undefined) {
    const { env, label } = clientCredential;
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
      credential = existing || clientCredential.generate();
      await writeFile(credentialPath, credential, { flag: "wx", mode: 0o600 });
    }
  }
  if (existsSync(migrationPath)) {
    // It writes the schema settings of core and the deployed server's
    // plugins, which the database checks before its first read.
    const { migrate } = await import(migrationPath.href);
    await migrate(hotUpdater);
  }
  if (clientCredential === undefined) {
    console.log("Client routes are public: there is no client credential.");
  } else {
    // Registered again rather than replaced, through that plugin, on the
    // tables the deployed server reads.
    await clientCredential.provision(api[clientAuth.plugin], {
      existing: credential.trim(),
      name: "Agent infrastructure setup",
    });
    console.log(
      `Client ${clientCredential.label} registered. It is saved in client-credential.local.`,
    );
  }
} finally {
  await database.dispose?.();
}
