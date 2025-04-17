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
import { initFirebaseUser, setEnv } from "./select";

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

const printTemplate = async (projectId: string, region: string) => {
  let functionUrl = "";
  try {
    const { stdout } = await execa("gcloud", [
      "functions",
      "describe",
      "hot-updater",
      "--project",
      projectId,
      "--region",
      region,
      "--format=json",
    ]);
    const parsedData = JSON.parse(stdout);
    const url = parsedData?.serviceConfig?.uri ?? parsedData.url;

    functionUrl = `${url}/api/check-update`;
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

  const firebaseDir = path.dirname(
    require.resolve("@hot-updater/firebase/functions"),
  );

  const { tmpDir, removeTmpDir } = await copyDirToTmp(firebaseDir);

  const functionsDir = path.join(tmpDir, "functions");
  const functionsIndexPath = path.join(functionsDir, "index.cjs");
  await fs.promises.rename(path.join(tmpDir, "index.cjs"), functionsIndexPath);
  await fs.promises.rename(
    path.join(functionsDir, "_package.json"),
    path.join(functionsDir, "package.json"),
  );

  const initializeVariable = await initFirebaseUser(tmpDir);

  let currentRegion = "us-central1";

  await setEnv({
    projectId: initializeVariable.projectId,
    storageBucket: initializeVariable.storageBucket,
  });

  await p.tasks([
    {
      title: "Installing dependencies...",
      task: async () => {
        try {
          await execa("npm", ["install"], {
            cwd: functionsDir,
          });
          return "Installed dependencies";
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
        let isFunctionsExist = false;

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

          let selectedRegion = currentRegion;
          if (!isFunctionsExist) {
            const selectRegion = await p.select({
              message: "Select Region",
              options: REGIONS,
              initialValue: currentRegion || REGIONS[0],
            });
            if (p.isCancel(selectRegion)) {
              p.cancel("Operation cancelled.");
              process.exit(1);
            }
            selectedRegion = selectRegion as string;
          }
          currentRegion = selectedRegion;

          const code = await transformEnv(
            await fs.promises.readFile(functionsIndexPath, "utf-8"),
            {
              REGION: selectedRegion,
            },
          );
          await fs.promises.writeFile(functionsIndexPath, code);
        } catch (error) {
          if (error instanceof ExecaError) {
            p.log.error(error.stderr || error.stdout || error.message);
          } else if (error instanceof Error) {
            p.log.error(error.message);
          }
          await removeTmpDir();
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
            await removeTmpDir();
            process.exit(1);
          }
          selectedRegion = selectRegion as string;
        }
        return `Using ${isFunctionsExist ? "existing" : "new"} functions in region: ${currentRegion}`;
      },
    },
  ]);

  await deployFirestore(tmpDir);
  await deployFunctions(tmpDir);

  await p.tasks([
    {
      title: "Check IAM policy",
      async task(message) {
        const functionsList = await execa(
          "npx",
          ["firebase", "functions:list", "--json"],
          {
            cwd: tmpDir,
          },
        );
        const functionsListJson = JSON.parse(functionsList.stdout);
        const functionsData = functionsListJson.result || [];
        const hotUpdater = functionsData.find(
          (fn: FirebaseFunction) => fn.id === "hot-updater",
        );
        const account = hotUpdater?.serviceAccount as string | undefined;

        if (!account) {
          p.log.error("hot-updater function not found");
          await removeTmpDir();
          process.exit(1);
        }

        const checkIam = await execa("gcloud", [
          "projects",
          "get-iam-policy",
          initializeVariable.projectId,
          "--format=json",
        ]);
        const iamJson = JSON.parse(checkIam.stdout);
        const hasTokenCreator = iamJson.bindings.some(
          (binding: { role: string; members: string[] }) =>
            binding.role === "roles/iam.serviceAccountTokenCreator" &&
            binding.members.includes(`serviceAccount:${account}`),
        );
        if (!hasTokenCreator) {
          try {
            message(
              "Adding IAM Service Account Token Creator role to the service account",
            );
            await execa(
              "gcloud",
              [
                "projects",
                "add-iam-policy-binding",
                initializeVariable.projectId,
                `--member=serviceAccount:${account}`,
                "--role=roles/iam.serviceAccountTokenCreator",
              ],
              {
                stdio: "inherit",
                shell: true,
              },
            );
            p.log.success(
              "IAM Service Account Token Creator role has been added to the service account",
            );
          } catch (err) {
            p.log.error(
              "Please go to the following link to add the IAM Service Account Token Creator role to the service account",
            );
            p.log.step(
              link(
                `https://console.cloud.google.com/iam-admin/iam/project/${initializeVariable.projectId}/serviceaccounts/${account}/edit?inv=1`,
              ),
            );
            await removeTmpDir();
            process.exit(1);
          }
        }
        return "Added IAM Service Account Token Creator role to the service account";
      },
    },
  ]);

  await printTemplate(initializeVariable.projectId, currentRegion);

  await removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
