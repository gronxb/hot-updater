import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import {
  type BuildType,
  copyDirToTmp,
  link,
  transformEnv,
  transformTemplate,
} from "@hot-updater/plugin-core";
import { isEqual, merge, sortBy, uniqWith } from "es-toolkit";
import { ExecaError, execa } from "execa";
import { initFirebaseUser, setEnv } from "./select";

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater, getUpdateSource } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: getUpdateSource("%%source%%", {
    updateStrategy: "fingerprint", // or "appVersion"
  }),
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
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: {
    fieldPath: string;
    order?: "ASCENDING" | "DESCENDING";
    arrayConfig?: "CONTAINS";
    vectorConfig?: {
      dimension: number;
      flat: Record<string, never>;
    };
  }[];
};

type FieldOverride = {
  collectionGroup: string;
  fieldPath: string;
  indexes: Array<{
    queryScope: "COLLECTION" | "COLLECTION_GROUP";
    order?: "ASCENDING" | "DESCENDING";
    arrayConfig?: "CONTAINS";
  }>;
  ttl?: boolean;
};

function normalizeIndex(index: FirebaseIndex) {
  return {
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: sortBy(index.fields, ["fieldPath", "order"]),
  };
}

const mergeIndexes = (
  originalIndexes: {
    indexes: FirebaseIndex[];
    fieldOverrides: FieldOverride[];
  },
  newIndexes: { indexes: FirebaseIndex[]; fieldOverrides: FieldOverride[] },
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
    shell: true,
  });

  let originalIndexes: {
    indexes: FirebaseIndex[];
    fieldOverrides: FieldOverride[];
  } = {
    indexes: [],
    fieldOverrides: [],
  };
  try {
    const originalStdout = JSON.parse(original.stdout);
    originalIndexes = originalStdout ?? { indexes: [], fieldOverrides: [] };
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
      shell: true,
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
      shell: true,
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
  try {
    const { stdout } = await execa(
      "gcloud",
      [
        "functions",
        "describe",
        "hot-updater",
        "--project",
        projectId,
        "--region",
        region,
        "--format=json",
      ],
      {
        shell: true,
      },
    );
    const parsedData = JSON.parse(stdout);
    const url = parsedData?.serviceConfig?.uri ?? parsedData.url;

    const functionUrl = `${url}/api/check-update`;

    p.note(
      transformTemplate(SOURCE_TEMPLATE, {
        source: functionUrl,
      }),
    );
  } catch (error) {
    if (error instanceof ExecaError) {
      p.log.error(error.stderr || error.stdout || error.message);
    } else if (error instanceof Error) {
      p.log.error(error.message);
    }
    process.exit(1);
  }
};

const checkIfGcloudCliInstalled = async () => {
  try {
    await execa("gcloud", ["--version"], {
      shell: true,
    });
    return true;
  } catch (error) {
    return false;
  }
};

export const runInit = async ({ build }: { build: BuildType }) => {
  const isGcloudCliInstalled = await checkIfGcloudCliInstalled();
  if (!isGcloudCliInstalled) {
    p.log.error("gcloud CLI is not installed");
    p.log.step("Please go to the following link to install the gcloud CLI");
    p.log.step(link("https://cloud.google.com/sdk/docs/install"));
    process.exit(1);
  }

  const firebaseDir = path.dirname(
    path.dirname(require.resolve("@hot-updater/firebase/functions")),
  );

  const { tmpDir, removeTmpDir } = await copyDirToTmp(firebaseDir);

  const functionsDir = path.join(tmpDir, "functions");
  const functionsIndexPath = path.join(functionsDir, "index.cjs");
  await fs.promises.rename(
    path.join(functionsDir, "_package.json"),
    path.join(functionsDir, "package.json"),
  );

  const initializeVariable = await initFirebaseUser(tmpDir);

  let currentRegion: string | undefined;

  await setEnv({
    projectId: initializeVariable.projectId,
    storageBucket: initializeVariable.storageBucket,
    build,
  });

  await p.tasks([
    {
      title: "Installing dependencies...",
      task: async () => {
        try {
          await execa("npm", ["install"], {
            cwd: functionsDir,
            shell: true,
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
              shell: true,
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
        } catch {
          // no-op
        }

        if (!isFunctionsExist) {
          const selectedRegion = await p.select({
            message: "Select Region",
            options: REGIONS,
            initialValue: REGIONS[0].value,
          });
          if (p.isCancel(selectedRegion)) {
            p.cancel("Operation cancelled.");
            process.exit(1);
          }
          currentRegion = selectedRegion;
        }

        if (!currentRegion) {
          p.log.error("Region is not set");
          await removeTmpDir();
          process.exit(1);
        }

        const code = transformEnv(functionsIndexPath, {
          REGION: currentRegion,
        });
        await fs.promises.writeFile(functionsIndexPath, code);
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
            shell: true,
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

        const checkIam = await execa(
          "gcloud",
          [
            "projects",
            "get-iam-policy",
            initializeVariable.projectId,
            "--format=json",
          ],
          {
            shell: true,
          },
        );
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

  if (!currentRegion) {
    p.log.error("Region is not set");
    await removeTmpDir();
    process.exit(1);
  }
  await printTemplate(initializeVariable.projectId, currentRegion);
  await removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/guide/providers/4_firebase.html#step-3-generated-configurations",
    )}`,
  );
  p.log.message(
    "Next step: Change GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json in .env file",
  );
  p.log.success("Done! 🎉");
};
