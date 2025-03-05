import path from "path";
import { initFirebaseUser } from "@/commands/init/firebase/select";
import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import * as p from "@clack/prompts";
import { copyDirToTmp } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs/promises";

const firebaseDir = path.join(
  "node_modules",
  "@hot-updater",
  "firebase",
  "firebase",
);

const rootDir = process.cwd();
const hotUpdaterDir = path.resolve(".hot-updater");

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

async function setupFirebaseEnv(webAppId: string) {
  try {
    const { stdout } = await execa(
      "firebase",
      ["apps:sdkconfig", "WEB", webAppId],
      { cwd: hotUpdaterDir },
    );

    const firebaseConfig = JSON.parse(stdout);

    const newEnvVars = {
      HOT_UPDATER_FIREBASE_API_KEY: firebaseConfig.apiKey,
      HOT_UPDATER_FIREBASE_PROJECT_ID: firebaseConfig.projectId,
      HOT_UPDATER_FIREBASE_STORAGE_BUCKET: firebaseConfig.storageBucket,
    };

    await makeEnv(newEnvVars, path.join(rootDir, ".env"));
  } catch (error) {
    console.error("error in firebase apps:sdkconfig", error);
  }
}

export const initFirebase = async () => {
  const initializeVariable = await initFirebaseUser();

  const { tmpDir, removeTmpDir } = await copyDirToTmp(firebaseDir);
  const functionsDir = path.join(tmpDir, "functions");
  const oldPackagePath = path.join(functionsDir, "_package.json");
  const newPackagePath = path.join(functionsDir, "package.json");

  try {
    await fs.rename(oldPackagePath, newPackagePath);
  } catch (error) {
    console.error("error in changing file name:", error);
  }

  try {
    await execa("npm", ["install"], { cwd: functionsDir, stdio: "inherit" });
  } catch (error) {
    console.error("error in npm install", error);
  }

  try {
    await execa("firebase", ["use", "--add", initializeVariable.projectId], {
      cwd: hotUpdaterDir,
    });
  } catch (error) {
    console.error("error in firebase use --add:", error);
  }

  setupFirebaseEnv(initializeVariable.webAppId);

  await execa("firebase", ["deploy"], {
    cwd: hotUpdaterDir,
    stdio: "inherit",
  });

  await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);

  await removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
