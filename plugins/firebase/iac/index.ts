import fs from "fs";
import path from "path";

import {
  confirmInitInputPersistence,
  formatApiKeyNote,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV,
  InitError,
  link,
  makeEnv,
  p,
  readHotUpdaterInitEnv,
  resolveHotUpdaterServerVersion,
  resolvePackageVersion,
  type RunInitOptions,
  transformEnv,
  transformTemplate,
} from "@hot-updater/cli-tools";
import { provisionApiKey } from "@hot-updater/server";
import { isEqual, merge, sortBy, uniqWith } from "es-toolkit";
import { ExecaError, execa } from "execa";
import {
  applicationDefault,
  cert,
  deleteApp,
  getApps,
} from "firebase-admin/app";

import { firebaseDatabase } from "../src/firebaseDatabase";
import { FIREBASE_V1_FUNCTION_NAME } from "../src/firebaseInfrastructureNames";
import { inputFirebaseApplicationCredentials } from "./firebaseApplicationCredentials";
import {
  assertFirebaseFunctionCanInitialize,
  assertFirebaseInfrastructureCanInitialize,
} from "./firebaseInfrastructureState";
import {
  assertFirebaseNonInteractiveInputs,
  type FirebaseCliEnv,
  getFirebaseCliEnv,
  resolveFirebaseInitInputs,
} from "./firebaseInitInputs";
import { resolveFirebaseRegion } from "./firebaseRegion";
import { initProvider as FIREBASE_INIT_PROVIDER } from "./init/index";
import { prepareFirebaseTemplate } from "./prepareTemplate";
import { createFirebaseProject, initFirebaseUser, setEnv } from "./select";

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return null; // Replace with your app root
}

HotUpdater.init({
  baseURL: "%%source%%",
  requestHeaders: {
    "x-api-key": %%apiKey%%,
  },
});

// Call HotUpdater.checkForUpdate({ updateStrategy: "appVersion" })
// when your app is ready to check.
export default App;`;

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

const commandErrorMessage = (error: unknown): string => {
  if (error instanceof ExecaError) {
    const output = error.stderr || error.stdout;
    if (output !== undefined && output !== null) {
      const text = String(output).trim();
      if (!text) return error.message;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          const message = Reflect.get(parsed, "error");
          if (typeof message === "string") return message;
        }
      } catch {
        return text;
      }
      return text;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const ensureCloudFunctionsApiEnabled = async (
  projectId: string,
  cliEnv?: FirebaseCliEnv,
): Promise<void> => {
  await p.tasks([
    {
      title: "Checking Cloud Functions API",
      task: async () => {
        try {
          await execa(
            "gcloud",
            [
              "services",
              "enable",
              "cloudfunctions.googleapis.com",
              `--project=${projectId}`,
              "--quiet",
            ],
            { env: cliEnv },
          );
        } catch (error) {
          throw new InitError(
            `Could not enable the Cloud Functions API for Firebase project ${projectId}: ${commandErrorMessage(error)}`,
          );
        }
        return "Cloud Functions API is enabled";
      },
    },
  ]);
};

const listFirebaseFunctions = async (
  cwd: string,
  projectId: string,
  nonInteractive: boolean,
  cliEnv?: FirebaseCliEnv,
): Promise<FirebaseFunction[]> => {
  let functionsList: { readonly stdout: string };
  try {
    functionsList = await execa(
      "npx",
      [
        "firebase",
        "functions:list",
        "--json",
        "--project",
        projectId,
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      {
        cwd,
        env: cliEnv,
      },
    );
  } catch (error) {
    throw new InitError(
      `Could not list Firebase Functions for project ${projectId}: ${commandErrorMessage(error)}. Run npx firebase functions:list --project ${projectId} --debug for details.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(functionsList.stdout);
  } catch {
    throw new InitError("Firebase functions list response was invalid.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray(Reflect.get(body, "result"))
  ) {
    throw new InitError("Firebase functions list response was invalid.");
  }
  return Reflect.get(body, "result") as FirebaseFunction[];
};

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

const deployFirestore = async (
  cwd: string,
  nonInteractive = false,
  cliEnv?: FirebaseCliEnv,
) => {
  const original = await execa(
    "npx",
    [
      "firebase",
      "firestore:indexes",
      ...(nonInteractive ? ["--non-interactive"] : []),
    ],
    {
      cwd,
      env: cliEnv,
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
  } catch {
    originalIndexes = { indexes: [], fieldOverrides: [] };
  }

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
        env: cliEnv,
        stdio: "inherit",
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

const deployFunctions = async (
  cwd: string,
  nonInteractive = false,
  cliEnv?: FirebaseCliEnv,
) => {
  try {
    await execa(
      "npx",
      [
        "firebase",
        "deploy",
        "--only",
        `functions:${FIREBASE_V1_FUNCTION_NAME}`,
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      {
        cwd,
        env: cliEnv,
        stdio: "inherit",
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

const printTemplate = async (
  apiKey: string,
  projectId: string,
  region: string,
  cliEnv?: FirebaseCliEnv,
) => {
  try {
    const describedFunction = await execa(
      "gcloud",
      [
        "functions",
        "describe",
        FIREBASE_V1_FUNCTION_NAME,
        "--project",
        projectId,
        "--region",
        region,
        "--format=json",
      ],
      {
        env: cliEnv,
      },
    );
    const functionData = JSON.parse(describedFunction.stdout) as {
      readonly serviceConfig?: { readonly uri?: string };
    };
    const functionUrl = functionData.serviceConfig?.uri;
    if (!functionUrl) {
      throw new InitError(
        `Firebase Function ${FIREBASE_V1_FUNCTION_NAME} did not report an endpoint URL.`,
      );
    }

    p.note(
      transformTemplate(SOURCE_TEMPLATE, {
        apiKey: JSON.stringify(apiKey),
        source: functionUrl,
      }),
    );
    p.note(formatApiKeyNote(apiKey), "API Key");
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
    await execa("gcloud", ["--version"]);
    return true;
  } catch {
    return false;
  }
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const nonInteractive = envFile !== undefined;
  const initEnvSources = await readHotUpdaterInitEnv(process.cwd(), envFile);
  const { managedEnv } = initEnvSources;
  const initInputEnv = getHotUpdaterInitInputEnv(
    initEnvSources,
    nonInteractive,
  );
  const savedInputs = resolveFirebaseInitInputs(initInputEnv);
  assertFirebaseNonInteractiveInputs(savedInputs, nonInteractive);
  let applicationCredentials = savedInputs.applicationCredentials;
  const cliEnv = nonInteractive
    ? getFirebaseCliEnv(applicationCredentials)
    : undefined;

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
    cliEnv,
    async (projectId) => {
      applicationCredentials = await inputFirebaseApplicationCredentials({
        applicationCredentials,
        nonInteractive,
        projectId,
      });
      return cliEnv;
    },
  );

  if (initializeVariable.status === "ready") {
    await assertFirebaseInfrastructureCanInitialize({
      applicationCredentials,
      projectId: initializeVariable.projectId,
    });
    await ensureCloudFunctionsApiEnabled(initializeVariable.projectId, cliEnv);
    await assertFirebaseFunctionCanInitialize({
      functions: await listFirebaseFunctions(
        tmpDir,
        initializeVariable.projectId,
        nonInteractive,
        cliEnv,
      ),
    });
  }

  const currentRegion = await resolveFirebaseRegion({
    cwd: tmpDir,
    discoverExistingProject: initializeVariable.status === "ready",
    nonInteractive,
    savedRegion: savedInputs.region,
    cliEnv,
  });
  const resolvedInputs = {
    ...savedInputs,
    applicationCredentials: applicationCredentials || undefined,
    projectId: initializeVariable.projectId,
    region: currentRegion,
  };
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv: managedEnv,
    inputs: resolvedInputs,
    nonInteractive,
    provider: FIREBASE_INIT_PROVIDER,
  });
  const persistedInputs = getInitProviderEnvVars({
    includeConsentInputs: persistCredentialInputs,
    inputs: resolvedInputs,
    provider: FIREBASE_INIT_PROVIDER,
  });
  if (initializeVariable.status === "create") {
    await createFirebaseProject({
      cliEnv,
      projectId: initializeVariable.projectId,
    });
    await makeEnv(persistedInputs);
    await removeTmpDir();
    return;
  }
  const functionsCode = transformEnv(functionsIndexPath, {
    AUTHORITY_ID: initializeVariable.projectId,
    REGION: currentRegion,
  });
  await fs.promises.writeFile(functionsIndexPath, functionsCode);
  await setEnv({
    projectId: initializeVariable.projectId,
    storageBucket: initializeVariable.storageBucket,
    build,
    region: currentRegion,
    applicationCredentials:
      persistedInputs[
        FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.envKey
      ],
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

  await deployFirestore(tmpDir, nonInteractive, cliEnv);
  const credential = applicationCredentials
    ? cert(
        JSON.parse(await fs.promises.readFile(applicationCredentials, "utf-8")),
      )
    : applicationDefault();
  const existingApps = new Set(getApps());
  const databasePlugin = firebaseDatabase({
    authorityId: initializeVariable.projectId,
    credential,
    projectId: initializeVariable.projectId,
  });
  let apiKey: string;
  try {
    apiKey = (
      await provisionApiKey({
        apiKeys: databasePlugin.models.apiKeys,
        existingApiKey: initInputEnv.HOT_UPDATER_API_KEY,
        name: "Firebase init",
      })
    ).apiKey;
    await makeEnv({ HOT_UPDATER_API_KEY: apiKey });
  } finally {
    await databasePlugin.dispose?.();
    await Promise.all(
      getApps()
        .filter((app) => !existingApps.has(app))
        .map((app) => deleteApp(app)),
    );
  }
  await deployFunctions(tmpDir, nonInteractive, cliEnv);

  await p.tasks([
    {
      title: "Check IAM policy",
      async task(message) {
        const functionsData = await listFirebaseFunctions(
          tmpDir,
          initializeVariable.projectId,
          nonInteractive,
          cliEnv,
        );
        const hotUpdater = functionsData.find(
          (fn: FirebaseFunction) => fn.id === FIREBASE_V1_FUNCTION_NAME,
        );
        const account = hotUpdater?.serviceAccount as string | undefined;

        if (!account) {
          p.log.error(`${FIREBASE_V1_FUNCTION_NAME} function not found`);
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
            env: cliEnv,
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
                env: cliEnv,
                stdio: "inherit",
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
  await printTemplate(
    apiKey,
    initializeVariable.projectId,
    currentRegion,
    cliEnv,
  );
  await removeTmpDir();

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/firebase#step-3-generated-configurations",
    )}`,
  );
  if (!applicationCredentials) {
    p.log.message(
      "Next step: Change GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json in .env.hotupdater",
    );
  }
  p.log.success("Done! 🎉");
};
