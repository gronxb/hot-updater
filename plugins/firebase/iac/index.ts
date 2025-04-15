import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import {
  copyDirToTmp,
  link,
  transformEnv,
  transformTemplate,
} from "@hot-updater/plugin-core";
import { isEqual, merge, sortBy, uniqWith } from "es-toolkit";
import { ExecaError, execa } from "execa";
import { initFirebaseUser } from "./select";

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

type FirebaseIndex = {
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order: string }[];
};

function normalizeIndex(index: FirebaseIndex) {
  return {
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: sortBy(index.fields, ["fieldPath", "order"]),
  };
}

const mergeIndexes = (
  originalIndexes: { indexes: FirebaseIndex[]; fieldOverrides: any[] },
  newIndexes: { indexes: FirebaseIndex[]; fieldOverrides: any[] },
) => {
  const mergedIndexes = originalIndexes.indexes.concat(newIndexes.indexes);
  const uniqueIndexes = uniqWith(mergedIndexes, (a, b) =>
    isEqual(normalizeIndex(a), normalizeIndex(b)),
  );
  return {
    indexes: uniqueIndexes,
    fieldOverrides: merge(
      originalIndexes.fieldOverrides,
      newIndexes.fieldOverrides,
    ),
  };
};

const deployFirestore = async (cwd: string) => {
  const original = await execa("npx", ["firebase", "firestore:indexes"], {
    cwd,
  });

  let originalIndexes = [];
  try {
    const originalStdout = JSON.parse(original.stdout);
    originalIndexes = originalStdout ?? [];
  } catch {}

  const newIndexes = JSON.parse(
    await fs.promises.readFile(
      path.join(cwd, "firestore.indexes.json"),
      "utf-8",
    ),
  );

  const mergedIndexes = mergeIndexes(originalIndexes, newIndexes);

  await fs.promises.writeFile(
    path.join(cwd, "firestore.indexes.json"),
    JSON.stringify(mergedIndexes, null, 2),
  );

  try {
    await execa("npx", ["firebase", "deploy", "--only", "firestore"], {
      cwd,
      stdio: "inherit",
    });
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};

const deployFunctions = async (cwd: string) => {
  try {
    await execa("npx", ["firebase", "deploy", "--only", "functions"], {
      cwd,
      stdio: "inherit",
    });
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};

const printTemplate = async (cwd: string) => {
  let functionUrl = "";
  try {
    const { stdout } = await execa(
      "npx",
      ["firebase", "functions:list", "--json"],
      {
        cwd,
      },
    );

    const parsedData = JSON.parse(stdout);
    const functionsData = parsedData.result || [];

    const hotUpdater = functionsData.find(
      (fn: FirebaseFunction) => fn.id === "hot-updater",
    );

    functionUrl = `${hotUpdater?.uri}/api/check-update` || "";
  } catch (error) {
    if (error instanceof ExecaError) {
      p.log.error(error.stderr || error.stdout || error.message);
    } else if (error instanceof Error) {
      p.log.error(error.message);
    }
    process.exit(1);
  }

  p.note(
    transformTemplate(SOURCE_TEMPLATE, {
      source: functionUrl,
    }),
  );
};

const checkIfGcloudCliInstalled = async () => {
  try {
    await execa("gcloud", ["--version"]);
    return true;
  } catch (error) {
    return false;
  }
};

export const runInit = async () => {
  const isGcloudCliInstalled = await checkIfGcloudCliInstalled();
  if (!isGcloudCliInstalled) {
    p.log.error("gcloud CLI is not installed");
    p.log.step("Please go to the following link to install the gcloud CLI");
    p.log.step(link("https://cloud.google.com/sdk/docs/install"));
    process.exit(1);
  }

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

  await fs.promises.copyFile(indexFile, destPath);
  await fs.promises.rename(oldPackagePath, newPackagePath);
  const indexTsPath = path.join(functionsDir, "index.ts");
  const tsconfigPath = path.join(functionsDir, "tsconfig.json");

  try {
    await fs.promises.rm(indexTsPath);
  } catch (error) {
    p.log.error(`Error deleting ${indexTsPath}:`);
  }

  try {
    await fs.promises.rm(tsconfigPath);
  } catch (error) {
    p.log.error(`Error deleting ${tsconfigPath}`);
  }

  await p.tasks([
    {
      title: "Installing dependencies...",
      task: async () => {
        try {
          await execa("npm", ["install"], {
            cwd: functionsDir,
          });
        } catch (error) {
          if (error instanceof ExecaError) {
            p.log.error(error.stderr || error.stdout || error.message);
          } else if (error instanceof Error) {
            p.log.error(error.message);
          }
          process.exit(1);
        }
      },
    },
    {
      title: `Select Firebase project (${initializeVariable.projectId})...`,
      task: async () => {
        try {
          await execa(
            "npx",
            ["firebase", "use", "--add", initializeVariable.projectId],
            {
              cwd: tmpDir,
            },
          );
        } catch (error) {
          if (error instanceof ExecaError) {
            p.log.error(error.stderr || error.stdout || error.message);
          } else if (error instanceof Error) {
            p.log.error(error.message);
          }
          process.exit(1);
        }
      },
    },
    {
      title: "Checking existing functions and setting region",
      task: async () => {
        let currentRegion = "us-central1";

        try {
          const { stdout } = await execa(
            "npx",
            ["firebase", "functions:list", "--json"],
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
            p.log.message(
              `Found existing functions in region: ${currentRegion}`,
            );
          }
        } catch (error) {
          if (error instanceof ExecaError) {
            p.log.error(error.stderr || error.stdout || error.message);
          } else if (error instanceof Error) {
            p.log.error(error.message);
          }
          process.exit(1);
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
          p.log.message(`Using existing region: ${currentRegion}`);
        }

        const code = await transformEnv(
          await fs.promises.readFile(
            path.join(functionsDir, "index.cjs"),
            "utf-8",
          ),
          {
            REGION: selectedRegion,
          },
        );
        await fs.promises.writeFile(path.join(functionsDir, "index.cjs"), code);
      },
    },
  ]);

  await deployFirestore(tmpDir);
  await deployFunctions(tmpDir);
  await printTemplate(tmpDir);

  void removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
