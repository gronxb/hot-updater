import {} from "fs";
import path from "path";
import { initFirebaseUser } from "@/commands/init/firebase/select";
import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import { transformEnv } from "@/utils/transformEnv";
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

  await p.tasks([
    {
      title: "Renaming files...",
      task: async () => {
        try {
          await fs.rename(oldPackagePath, newPackagePath);
        } catch (error) {
          console.error("error in changing file name:", error);
          throw error;
        }
      },
    },
    {
      title: "Removing unnecessary files...",
      task: async () => {
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
      },
    },
    {
      title: "Installing dependencies...",
      task: async () => {
        try {
          await execa("npm", ["install"], {
            cwd: functionsDir,
          });
        } catch (error) {
          console.error("error in npm install:", error);
          throw error;
        }
      },
    },
    {
      title: `Setting up Firebase project (${initializeVariable.projectId})...`,
      task: async () => {
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
        } catch (error) {
          console.error("error in firebase use --add:", error);
          throw error;
        }
      },
    },
    {
      title: "Configuring environment variables...",
      task: async () => {
        await setupFirebaseEnv(initializeVariable.webAppId, tmpDir);
      },
    },
    {
      title: "Select Firebase Region",
      task: async () => {
        const regions = [
          { value: "us-central1", label: "US Central (Iowa)" },
          { value: "us-east1", label: "US East (South Carolina)" },
          { value: "us-east4", label: "US East (Northern Virginia)" },
          { value: "us-west1", label: "US West (Oregon)" },
          { value: "us-west2", label: "US West (Los Angeles)" },
          { value: "us-west3", label: "US West (Salt Lake City)" },
          { value: "us-west4", label: "US West (Las Vegas)" },
          { value: "europe-west1", label: "Europe West (Belgium)" },
          { value: "europe-west2", label: "Europe West (London)" },
          { value: "europe-west3", label: "Europe West (Frankfurt)" },
          { value: "europe-west6", label: "Europe West (Zurich)" },
          { value: "asia-east1", label: "Asia East (Taiwan)" },
          { value: "asia-east2", label: "Asia East (Hong Kong)" },
          { value: "asia-northeast1", label: "Asia Northeast (Tokyo)" },
          { value: "asia-northeast2", label: "Asia Northeast (Osaka)" },
          { value: "asia-northeast3", label: "Asia Northeast (Seoul)" },
          { value: "asia-south1", label: "Asia South (Mumbai)" },
          { value: "asia-southeast1", label: "Asia Southeast (Singapore)" },
          { value: "asia-southeast2", label: "Asia Southeast (Jakarta)" },
          {
            value: "australia-southeast1",
            label: "Australia Southeast (Sydney)",
          },
        ];

        const selectedRegion = await p.select({
          message: "Select a region for your Firebase Functions:",
          options: regions,
          initialValue: "us-central1",
        });

        if (p.isCancel(selectedRegion)) {
          p.cancel("Operation cancelled.");
          throw new Error("Region selection cancelled");
        }

        const code = await transformEnv(
          await fs.readFile(path.join(functionsDir, "index.cjs"), "utf-8"),
          {
            REGION: selectedRegion,
          },
        );
        await fs.writeFile(path.join(functionsDir, "index.cjs"), code);

        console.log(
          `Selected region '${selectedRegion}' has been added to firebase.json`,
        );
      },
    },
    {
      title: "Deploy to Firebase",
      task: async () => {
        try {
          await execa(
            "pnpm",
            ["firebase", "deploy", "--config", "./.hot-updater/firebase.json"],
            {
              cwd: tmpDir,
            },
          );
        } catch (error) {
          console.error("Error in Firebase deployment:", error);
          throw error;
        }
      },
    },
    {
      title: "Creating configuration file...",
      task: async () => {
        await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);
      },
    },
    {
      title: "Cleaning up temporary directory...",
      task: async () => {
        await removeTmpDir();
      },
    },
  ]);

  p.log.message(
    // biome-ignore lint/style/useTemplate: <explanation>
    `1. Click this link ${link(`https://console.firebase.google.com/project/${initializeVariable.projectId}/functions\n`)}` +
      "2. Click Detailed usage stats of updateInfoFunction\n" +
      "3. Click SECURITY and Allow unauthenticated invocations or you want",
  );

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
