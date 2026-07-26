import fs from "fs";
import path from "path";

import {
  HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV,
  link,
  p,
  readHotUpdaterInitEnv,
  resolveHotUpdaterServerVersion,
  resolvePackageVersion,
  type RunInitOptions,
  transformEnv,
  transformTemplate,
} from "@hot-updater/cli-tools";
import { isEqual, merge, sortBy, uniqWith } from "es-toolkit";
import { ExecaError, execa } from "execa";

import {
  assertFirebaseNonInteractiveInputs,
  resolveFirebaseInitInputs,
} from "./firebaseInitInputs";
import { resolveFirebaseRegion } from "./firebaseRegion";
import { prepareFirebaseTemplate } from "./prepareTemplate";
import { initFirebaseUser, setEnv } from "./select";

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  baseURL: "%%source%%",
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

const getFirebaseRuntimePackageInfo = () => {
  const firebasePackageRoot = path.dirname(
    require.resolve("@hot-updater/firebase/package.json"),
  );
  const currentPackageVersion = resolvePackageVersion("@hot-updater/firebase");
  const serverPackageVersion = resolveHotUpdaterServerVersion(
    "@hot-updater/firebase",
  );
  const honoVersion = resolvePackageVersion("hono", {
    searchFrom: firebasePackageRoot,
  });

  return {
    currentPackageVersion,
    serverPackageVersion,
    honoVersion,
  };
};

const syncFunctionsPackageJson = async (functionsDir: string) => {
  const runtimePackageInfo = getFirebaseRuntimePackageInfo();
  const packageJsonPath = path.join(functionsDir, "package.json");
  const packageJson = JSON.parse(
    await fs.promises.readFile(packageJsonPath, "utf-8"),
  ) as {
    dependencies?: Record<string, string>;
  };

  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@hot-updater/server": runtimePackageInfo.serverPackageVersion,
    hono: runtimePackageInfo.honoVersion,
  };

  await fs.promises.writeFile(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  return runtimePackageInfo;
};

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

const deployFirestore = async (cwd: string, nonInteractive = false) => {
  const original = await execa(
    "npx",
    [
      "firebase",
      "firestore:indexes",
      ...(nonInteractive ? ["--non-interactive"] : []),
    ],
    {
      cwd,
      shell: true,
    },
  );

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
    await execa(
      "npx",
      [
        "firebase",
        "deploy",
        "--only",
        "firestore",
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      {
        cwd,
        stdio: "inherit",
        shell: true,
      },
    );
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};

const deployFunctions = async (cwd: string, nonInteractive = false) => {
  try {
    await execa(
      "npx",
      [
        "firebase",
        "deploy",
        "--only",
        "functions",
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      {
        cwd,
        stdio: "inherit",
        shell: true,
      },
    );
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
  } catch {
    return false;
  }
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const nonInteractive = envFile !== undefined;
  const { env: existingEnv } = await readHotUpdaterInitEnv(
    process.cwd(),
    envFile,
  );
  const savedInputs = resolveFirebaseInitInputs(existingEnv);
  assertFirebaseNonInteractiveInputs(savedInputs, nonInteractive);

  const isGcloudCliInstalled = await checkIfGcloudCliInstalled();
  if (!isGcloudCliInstalled) {
    p.log.error("gcloud CLI is not installed");
    p.log.step("Please go to the following link to install the gcloud CLI");
    p.log.step(link("https://cloud.google.com/sdk/docs/install"));
    process.exit(1);
  }

  const firebaseRootDir = path.dirname(
    path.dirname(require.resolve("@hot-updater/firebase/functions")),
  );

  const { tmpDir, removeTmpDir, functionsDir } =
    await prepareFirebaseTemplate(firebaseRootDir);
  const functionsIndexPath = path.join(functionsDir, "index.cjs");
  const runtimePackageInfo = await syncFunctionsPackageJson(functionsDir);

  const initializeVariable = await initFirebaseUser(
    tmpDir,
    savedInputs.projectId,
    nonInteractive,
  );

  const currentRegion = await resolveFirebaseRegion({
    cwd: tmpDir,
    nonInteractive,
    savedRegion: savedInputs.region,
  });
  const functionsCode = transformEnv(functionsIndexPath, {
    REGION: currentRegion,
  });
  await fs.promises.writeFile(functionsIndexPath, functionsCode);
  await setEnv({
    projectId: initializeVariable.projectId,
    storageBucket: initializeVariable.storageBucket,
    build,
    region: currentRegion,
  });

  if (
    runtimePackageInfo.serverPackageVersion !==
    runtimePackageInfo.currentPackageVersion
  ) {
    p.note(
      `Using ${HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV}=${runtimePackageInfo.serverPackageVersion} for Firebase functions deploy.`,
    );
  }

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
  ]);

  await deployFirestore(tmpDir, nonInteractive);
  await deployFunctions(tmpDir, nonInteractive);

  await p.tasks([
    {
      title: "Check IAM policy",
      async task(message) {
        const functionsList = await execa(
          "npx",
          [
            "firebase",
            "functions:list",
            "--json",
            ...(nonInteractive ? ["--non-interactive"] : []),
          ],
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
          } catch {
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
      "https://hot-updater.dev/docs/managed/firebase#step-3-generated-configurations",
    )}`,
  );
  p.log.message(
    "Next step: Change GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json in .env file",
  );
  p.log.success("Done! 🎉");
};
