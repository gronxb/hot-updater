import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** A hot-updater.config.ts that holds `text`, in a directory of its own. */
const configWith = async (text: string) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-firebase-config-"),
  );
  tempDirs.push(dir);
  const configPath = path.join(dir, "hot-updater.config.ts");
  await fs.writeFile(configPath, text, "utf8");
  return configPath;
};

/**
 * A config with a credential helper and settings of the project's own, and
 * no plugins.
 */
const PROJECT_CONFIG = `import { bare } from "@hot-updater/bare";
import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import { applicationDefault } from "firebase-admin/app";
import { defineConfig } from "hot-updater";

const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;

// Workload identity on CI.
const credential = applicationDefault();

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
    basePath: providerNamespace,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
  updateStrategy: "fingerprint",
});
`;

describe("Firebase managed config scaffold", () => {
  it("keeps the credential helper its storage and database read when init runs again", async () => {
    const configPath = await configWith(`${getConfigScaffold("bare").text}\n`);

    await writeHotUpdaterConfig(getConfigScaffold("bare"), configPath);
    const updated = await fs.readFile(configPath, "utf8");
    await writeHotUpdaterConfig(getConfigScaffold("bare"), configPath);

    expect(updated.match(/const credential\s*=/gu)).toHaveLength(1);
    expect(updated).toContain("const credential = applicationDefault();");
    expect(updated).toContain(
      'import { applicationDefault } from "firebase-admin/app";',
    );
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(updated);
  });

  it("keeps a project's own credential helper and settings, and lists the plugins", async () => {
    const configPath = await configWith(PROJECT_CONFIG);

    await writeHotUpdaterConfig(getConfigScaffold("bare"), configPath);

    const updated = await fs.readFile(configPath, "utf8");
    expect(updated).toContain(
      "// Workload identity on CI.\nconst credential = applicationDefault();",
    );
    expect(updated).not.toContain("Reuse working application-default");
    expect(updated).toContain("basePath: providerNamespace");
    expect(updated).toContain('updateStrategy: "fingerprint"');
    expect(updated).toContain(
      'import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";',
    );
    expect(updated).toContain(
      'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
    );
    expect(updated).toContain(
      "  plugins: [apiKeys(), insights(), remoteConfig()],\n",
    );
    // The database init set up, which the function also uses.
    expect(updated).toContain(
      "databaseId: process.env.HOT_UPDATER_FIREBASE_DATABASE_ID,",
    );
  });

  it("reads no credential, by process.env or a secret, in init's config or the agent scaffold's", () => {
    for (const { text } of [
      getConfigScaffold("bare", {
        projectId: "demo-project",
        storageBucket: "demo-project.firebasestorage.app",
        databaseId: "(default)",
      }),
      getConfigScaffold("bare"),
    ]) {
      expect(text).not.toMatch(/secretEnv|"secret:|secret\(/u);
      expect(text).toContain("const credential = applicationDefault();");
    }
  });

  it("names the project, bucket, and database init set up, and reads no secret", () => {
    expect(
      getConfigScaffold("bare", {
        projectId: "demo-project",
        storageBucket: "demo-project.firebasestorage.app",
        databaseId: "(default)",
      }).text,
    ).toMatchInlineSnapshot(`
      "import { bare } from "@hot-updater/bare";
      import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
      import { applicationDefault } from "firebase-admin/app";
      import { defineConfig, localSecrets } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      // https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
      // Reuse working application-default credentials (ADC).
      // Only when a credential file is needed, set its private local path in .env.hotupdater:
      // GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
      const credential = applicationDefault();

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: firebaseStorage({
          projectId: "demo-project",
          storageBucket: "demo-project.firebasestorage.app",
          credential,
        }),
        database: firebaseDatabase({
          projectId: "demo-project",
          databaseId: "(default)",
          credential,
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });
});
