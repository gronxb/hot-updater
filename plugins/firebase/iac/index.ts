import crypto from "crypto";
import {} from "fs";
import path from "path";
import * as p from "@clack/prompts";
import {
  copyDirToTmp,
  getCwd,
  link,
  makeEnv,
  transformEnv,
  transformTemplate,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs/promises";
import { initFirebaseUser } from "./select";

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

// Template file: Example code to add to App.tsx
const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: "%%source%%",
})(App);`;

const REGIONS = [
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

interface FirebaseFunction {
  platform: string;
  id: string;
  project: string;
  region: string;
  httpsTrigger: Record<string, any>;
  entryPoint: string;
  runtime: string;
  source: Record<string, any>;
  ingressSettings: string;
  environmentVariables: Record<string, any>;
  timeoutSeconds: number;
  uri: string;
  serviceAccount: string;
  availableMemoryMb: number;
  cpu: number;
  maxInstances: number;
  concurrency: number;
  labels: Record<string, any>;
  runServiceId: string;
  codebase: string;
  hash: string;
}

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

export const runInit = async () => {
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
  let isFunctionsExist = false;

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
      title: "Checking existing functions and setting region",
      task: async () => {
        let currentRegion = "us-central1";

        try {
          const { stdout } = await execa(
            "pnpm",
            [
              "firebase",
              "functions:list",
              "--json",
              "--config",
              "./.hot-updater/firebase.json",
            ],
            {
              cwd: tmpDir,
            },
          );

          const parsedData = JSON.parse(stdout);
          const functionsData = parsedData.result || [];

          const hotUpdater = functionsData.find(
            (fn: FirebaseFunction) => fn.id === "hot-updater",
          );

          if (hotUpdater?.region) {
            currentRegion = hotUpdater.region;
            isFunctionsExist = true;
          }

          if (hotUpdater) {
            console.log(`Found existing functions in region: ${currentRegion}`);
          }
        } catch (error) {
          console.log(
            "Could not retrieve existing functions, will use default region",
          );
        }

        let selectedRegion = currentRegion;

        if (!isFunctionsExist) {
          const selectRegion = await p.select({
            message: "Select Region",
            options: REGIONS,
            initialValue: currentRegion,
          });

          if (p.isCancel(selectRegion)) {
            p.cancel("Operation cancelled.");
            throw new Error("Region selection cancelled");
          }
          selectedRegion = selectRegion as string;
        } else {
          console.log(`Using existing region: ${currentRegion}`);
        }
        const jwtSecret = crypto.randomBytes(48).toString("hex");

        const code = await transformEnv(
          await fs.readFile(path.join(functionsDir, "index.cjs"), "utf-8"),
          {
            REGION: selectedRegion,
            JWT_SECRET: jwtSecret,
          },
        );
        await fs.writeFile(path.join(functionsDir, "index.cjs"), code);
      },
    },
    {
      title: "1. Deploy Firebase Storage Rules",
      task: async () => {
        if (isFunctionsExist) return;

        try {
          await execa(
            "pnpm",
            [
              "firebase",
              "deploy",
              "--only",
              "storage",
              "--config",
              "./.hot-updater/firebase.json",
            ],
            {
              cwd: tmpDir,
            },
          );
        } catch (error) {
          console.error("Error deploying a Firebase Storage rule:", error);
          throw error;
        }
      },
    },
    {
      title: "2. Deploy Firestore Indexes",
      task: async () => {
        if (isFunctionsExist) return;

        try {
          await execa(
            "pnpm",
            [
              "firebase",
              "deploy",
              "--only",
              "firestore:indexes",
              "--config",
              "./.hot-updater/firebase.json",
            ],
            {
              cwd: tmpDir,
            },
          );
        } catch (error) {
          console.log("Index deployment failed, proceed to the next step.");
        }
      },
    },
    {
      title: "3. Deploy Firestore Rules",
      task: async () => {
        if (isFunctionsExist) return;

        try {
          await execa(
            "pnpm",
            [
              "firebase",
              "deploy",
              "--only",
              "firestore:rules",
              "--config",
              "./.hot-updater/firebase.json",
            ],
            {
              cwd: tmpDir,
            },
          );
        } catch (error) {
          console.error("Error deploying a Firestore rule:", error);
          throw error;
        }
      },
    },
    {
      title: "4. Deploy Firebase Functions",
      task: async () => {
        try {
          const deployArgs = [
            "firebase",
            "deploy",
            "--only",
            "functions",
            "--force",
            "--config",
            "./.hot-updater/firebase.json",
          ];

          await execa("pnpm", deployArgs, { cwd: tmpDir });
        } catch (error) {
          console.error("Error deploying functions:", error);
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
      title: "Getting function URL",
      task: async () => {
        let functionUrl = "";
        try {
          const { stdout } = await execa(
            "pnpm",
            [
              "firebase",
              "functions:list",
              "--json",
              "--config",
              "./.hot-updater/firebase.json",
            ],
            {
              cwd: tmpDir,
            },
          );

          const parsedData = JSON.parse(stdout);
          const functionsData = parsedData.result || [];

          const hotUpdater = functionsData.find(
            (fn: FirebaseFunction) => fn.id === "hot-updater",
          );

          functionUrl = `${hotUpdater?.uri}/api/check-update` || "";
        } catch (error) {
          console.error("Error getting function URL:", error);
        }

        p.note(
          transformTemplate(SOURCE_TEMPLATE, {
            source: functionUrl,
          }),
        );
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
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
