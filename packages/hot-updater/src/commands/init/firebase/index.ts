import {} from "fs";
import path from "path";
import { initFirebaseUser } from "@/commands/init/firebase/select";
import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import * as p from "@clack/prompts";
import { copyDirToTmp, getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs/promises";

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { firebaseStorage, firebaseDatabase } from "@hot-updater/firebase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: metro({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    apiKey: process.env.HOT_UPDATER_FIREBASE_API_KEY,
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET,
  }),
  database: firebaseDatabase({
    apiKey: process.env.HOT_UPDATER_FIREBASE_API_KEY,
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
  }),
});
`;

async function setupFirebaseEnv(webAppId: string, tmpDir: string) {
  try {
    const { stdout } = await execa(
      "pnpm",
      [
        "firebase",
        "apps:sdkconfig",
        "WEB",
        webAppId,
        "--config",
        "./.hot-updater/firebase.json",
      ],
      { cwd: tmpDir },
    );

    const firebaseConfig = JSON.parse(stdout);

    const newEnvVars = {
      HOT_UPDATER_FIREBASE_API_KEY: firebaseConfig.apiKey,
      HOT_UPDATER_FIREBASE_PROJECT_ID: firebaseConfig.projectId,
      HOT_UPDATER_FIREBASE_STORAGE_BUCKET: firebaseConfig.storageBucket,
    };

    await makeEnv(newEnvVars, path.join(getCwd(), ".env"));
  } catch (error) {
    console.error("error in firebase apps:sdkconfig", error);
  }
}

export const initFirebase = async () => {
  const initializeVariable = await initFirebaseUser();

  const firebaseDir = path.join(
    path.dirname(path.dirname(require.resolve("@hot-updater/firebase"))),
    "firebase",
  );
  const { tmpDir, removeTmpDir } = await copyDirToTmp(firebaseDir);
  const functionsDir = path.join(tmpDir, "functions");
  const oldPackagePath = path.join(functionsDir, "_package.json");
  const newPackagePath = path.join(functionsDir, "package.json");
  const indexFile = require.resolve("@hot-updater/firebase/functions");
  const destPath = path.join(functionsDir, path.basename(indexFile));

  await fs.copyFile(indexFile, destPath);
  const spin = p.spinner();

  try {
    await fs.rename(oldPackagePath, newPackagePath);
  } catch (error) {
    console.error("error in changing file name:", error);
  }

  const indexTsPath = path.join(functionsDir, "index.ts");
  const tsconfigPath = path.join(functionsDir, "tsconfig.json");

  try {
    await fs.rm(indexTsPath);
  } catch (error) {
    console.error(`Error deleting ${indexTsPath}:`, error);
  }

  try {
    await fs.rm(tsconfigPath);
  } catch (error) {
    console.error(`Error deleting ${tsconfigPath}:`, error);
  }

  spin.start("installing dependencies...");
  try {
    await execa("npm", ["install"], {
      cwd: functionsDir,
    });
    spin.stop("Done!");
  } catch (error) {
    console.error("error in firebase use --add:", error);
  }

  spin.start(`firebase use --add ${initializeVariable.projectId}:`);
  try {
    await execa(
      "pnpm",
      [
        "firebase",
        "use",
        "--add",
        initializeVariable.projectId,
        "--config",
        "./.hot-updater/firebase.json",
      ],
      {
        cwd: tmpDir,
      },
    );
    spin.stop("Done!");
  } catch (error) {
    console.error("error in firebase use --add:", error);
  }

  setupFirebaseEnv(initializeVariable.webAppId, tmpDir);

  await execa(
    "pnpm",
    ["firebase", "deploy", "--config", "./.hot-updater/firebase.json"],
    {
      cwd: getCwd(),
      stdio: "inherit",
    },
  );

  await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);

  await removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
