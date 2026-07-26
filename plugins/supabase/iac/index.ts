import fs from "fs/promises";
import { createRequire } from "node:module";
import path from "path";

import {
  type BuildType,
  ConfigBuilder,
  confirmInitInputPersistence,
  copyDirToTmp,
  createHotUpdaterConfigScaffoldFromBuilder,
  getInitProviderEnvVars,
  isSupabaseFunctionName,
  link,
  makeEnv,
  type HotUpdaterConfigScaffold,
  MissingInitInputsError,
  type ProviderConfig,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  resolvePackageVersion,
  shouldAutoSelectOnlyInitResource,
  SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY,
  SUPABASE_INIT_PROVIDER,
  transformEnv,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { delay } from "es-toolkit";
import { ExecaError, execa } from "execa";

import { type SupabaseApi, supabaseApi } from "./supabaseApi";
import { linkSupabase, pushDB } from "./supabaseCli";
import {
  assertSupabaseNonInteractiveInputs,
  inputSupabaseDatabasePassword,
  inputSupabaseDeploymentInputs,
  inputSupabaseProjectCreationInputs,
  resolveSupabaseInitInputs,
} from "./supabaseInitInputs";
import {
  supabaseManagementApi,
  type SupabaseManagementApi,
  type SupabaseProject,
} from "./supabaseManagementApi";

const require = createRequire(import.meta.url);
const EDGE_VENDOR_DIR = "_hot-updater";
const WORKSPACE_PACKAGE_PREFIX = "@hot-updater/";
const SUPABASE_PROJECT_READY_STATUS = "ACTIVE_HEALTHY";
const SUPABASE_PROJECT_PROVISIONING_STATUS = "COMING_UP";
const SUPABASE_PROJECT_READINESS_MAX_ATTEMPTS = 60 * 5;
const SUPABASE_PROJECT_READINESS_POLL_INTERVAL_MS = 1000;
const STATIC_IMPORT_SPECIFIER_PATTERN =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["']([^"']+)["'];?/gm;
const DYNAMIC_IMPORT_SPECIFIER_PATTERN =
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const getConfigScaffold = (build: BuildType): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
    configString: `supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
    configString: `supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  })`,
  };

  return createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuildType(build)
      .setStorage(storageConfig)
      .setDatabase(databaseConfig),
  );
};

export const getLegacySupabaseConfigReference = (configText: string) => {
  if (configText.includes("HOT_UPDATER_SUPABASE_ANON_KEY")) {
    return "HOT_UPDATER_SUPABASE_ANON_KEY";
  }

  if (/\bsupabaseAnonKey\s*:/.test(configText)) {
    return "supabaseAnonKey";
  }

  return null;
};

const assertSkippedConfigDoesNotUseLegacySupabaseKey = async (
  configWriteResult: Awaited<ReturnType<typeof writeHotUpdaterConfig>>,
) => {
  if (configWriteResult.status !== "skipped") {
    return;
  }

  const configText = await fs
    .readFile(configWriteResult.path, "utf-8")
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    });

  const legacyReference =
    configText === null ? null : getLegacySupabaseConfigReference(configText);

  if (!legacyReference) {
    return;
  }

  p.log.error(
    `Existing '${configWriteResult.path}' still references '${legacyReference}'.`,
  );
  p.log.message(
    "Update it to use 'supabaseServiceRoleKey' with " +
      "'HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY', then run init again.",
  );
  process.exit(1);
};

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  baseURL: "%%source%%",
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

const resolvePackageExportPath = async (
  packageName: string,
  exportName: "." | "./runtime" | "./edge",
) => {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf-8"),
  ) as {
    exports?: Record<
      string,
      | string
      | {
          import?: string;
          require?: string;
          default?: string;
        }
    >;
  };
  const exportTarget = packageJson.exports?.[exportName];
  const relativePath =
    typeof exportTarget === "string"
      ? exportTarget
      : (exportTarget?.import ??
        exportTarget?.default ??
        exportTarget?.require);

  if (!relativePath) {
    throw new Error(
      `Could not resolve ${exportName} export for package ${packageName}`,
    );
  }

  return path.resolve(path.dirname(packageJsonPath), relativePath);
};

const toImportMapPath = (fromDir: string, toPath: string) => {
  const relativePath = path.relative(fromDir, toPath).split(path.sep).join("/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
};

const pathExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolveLocalModulePath = async (fromFile: string, specifier: string) => {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.js`,
    path.join(basePath, "index.mjs"),
    path.join(basePath, "index.js"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
};

const collectBareImportSpecifiers = async (entryPath: string) => {
  const filesToVisit = [entryPath];
  const visitedFiles = new Set<string>();
  const specifiers = new Set<string>();

  while (filesToVisit.length > 0) {
    const currentFile = filesToVisit.pop();
    if (!currentFile || visitedFiles.has(currentFile)) {
      continue;
    }

    visitedFiles.add(currentFile);
    const source = await fs.readFile(currentFile, "utf8");

    const matches = [
      ...source.matchAll(STATIC_IMPORT_SPECIFIER_PATTERN),
      ...source.matchAll(DYNAMIC_IMPORT_SPECIFIER_PATTERN),
    ];

    for (const match of matches) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }

      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolvedPath = await resolveLocalModulePath(
          currentFile,
          specifier,
        );
        if (resolvedPath) {
          filesToVisit.push(resolvedPath);
        }
        continue;
      }

      if (
        specifier.startsWith("node:") ||
        specifier.startsWith("npm:") ||
        specifier.startsWith("jsr:") ||
        specifier.startsWith("http://") ||
        specifier.startsWith("https://")
      ) {
        continue;
      }

      specifiers.add(specifier);
    }
  }

  return specifiers;
};

const toVendorDirName = (packageName: string) =>
  packageName.replace(/^@/, "").replaceAll("/", "-");

const prepareVendoredPackageImport = async ({
  targetDir,
  packageName,
  exportName,
}: {
  targetDir: string;
  packageName: string;
  exportName: "." | "./runtime" | "./edge";
}) => {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageRoot = path.dirname(packageJsonPath);
  const exportPath = await resolvePackageExportPath(packageName, exportName);
  const relativeExportPath = path
    .relative(packageRoot, exportPath)
    .split(path.sep);

  const [sourceRootDir, ...restPath] = relativeExportPath;
  if (!sourceRootDir || restPath.length === 0) {
    throw new Error(
      `Could not determine vendored import layout for ${packageName}${exportName}`,
    );
  }

  const vendorDirName = toVendorDirName(packageName);
  const sourceRootPath = path.join(packageRoot, sourceRootDir);
  const vendoredRootPath = path.join(
    targetDir,
    EDGE_VENDOR_DIR,
    vendorDirName,
    sourceRootDir,
  );

  await fs.rm(path.join(targetDir, EDGE_VENDOR_DIR, vendorDirName), {
    recursive: true,
    force: true,
  });
  await fs.mkdir(path.dirname(vendoredRootPath), { recursive: true });
  await fs.cp(sourceRootPath, vendoredRootPath, {
    recursive: true,
    force: true,
  });

  const vendoredEntryPath = path.join(vendoredRootPath, ...restPath);

  return {
    importMapPath: toImportMapPath(targetDir, vendoredEntryPath),
    packageRoot,
    sourceEntryPath: exportPath,
  };
};

const resolveBareSpecifierImportTarget = async (
  specifier: string,
  searchFrom: string,
) => {
  const version = resolvePackageVersion(specifier, { searchFrom });
  return `npm:${specifier}@${version}`;
};

const buildEdgeFunctionImports = async (targetDir: string) => {
  const imports: Record<string, string> = {};
  const visitedWorkspacePackages = new Set<string>();

  const addWorkspacePackage = async ({
    importSpecifier,
    packageName,
    exportName,
  }: {
    importSpecifier: string;
    packageName: string;
    exportName: "." | "./runtime" | "./edge";
  }) => {
    const visitKey = `${packageName}:${exportName}`;
    if (visitedWorkspacePackages.has(visitKey)) {
      return;
    }
    visitedWorkspacePackages.add(visitKey);

    const vendoredPackage = await prepareVendoredPackageImport({
      targetDir,
      packageName,
      exportName,
    });

    imports[importSpecifier] = vendoredPackage.importMapPath;

    const nestedSpecifiers = await collectBareImportSpecifiers(
      vendoredPackage.sourceEntryPath,
    );

    for (const nestedSpecifier of nestedSpecifiers) {
      if (imports[nestedSpecifier]) {
        continue;
      }

      if (nestedSpecifier.startsWith(WORKSPACE_PACKAGE_PREFIX)) {
        await addWorkspacePackage({
          importSpecifier: nestedSpecifier,
          packageName: nestedSpecifier,
          exportName: ".",
        });
        continue;
      }

      imports[nestedSpecifier] = await resolveBareSpecifierImportTarget(
        nestedSpecifier,
        vendoredPackage.packageRoot,
      );
    }
  };

  await addWorkspacePackage({
    importSpecifier: "@hot-updater/server",
    packageName: "@hot-updater/server",
    exportName: ".",
  });
  await addWorkspacePackage({
    importSpecifier: "@hot-updater/supabase",
    packageName: "@hot-updater/supabase",
    exportName: "./edge",
  });

  return imports;
};

export const resolveEdgeFunctionDenoConfig = async (targetDir: string) => {
  return {
    imports: await buildEdgeFunctionImports(targetDir),
  };
};

export type SupabaseProjectSelection =
  | {
      readonly create: false;
      readonly project: SupabaseProject;
    }
  | {
      readonly create: true;
    };

export const selectProject = async (
  preferredProjectId?: string,
  nonInteractive = false,
  accessToken?: string,
): Promise<SupabaseProjectSelection> => {
  const spinner = p.spinner();
  spinner.start("Fetching Supabase projects...");

  let projectsProcess: { id: string; name: string; region: string }[] = [];
  try {
    const listProjects = await execa(
      "npx",
      ["-y", "supabase", "projects", "list", "--output", "json"],
      {
        env: accessToken
          ? {
              [SUPABASE_INIT_PROVIDER.inputs.accessToken.envKey]: accessToken,
            }
          : undefined,
      },
    );

    projectsProcess =
      listProjects.stdout === "null"
        ? []
        : JSON.parse(listProjects?.stdout ?? "[]");
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch Supabase projects: ${message}`);
    process.exit(1);
  }

  spinner.stop();

  const preferredProject = projectsProcess.find(
    (project) => project.id === preferredProjectId,
  );
  if (preferredProject) {
    p.log.info(`Using saved Supabase project: ${preferredProject.name}`);
    return { create: false, project: preferredProject };
  }
  if (preferredProjectId) {
    if (nonInteractive) {
      throw new MissingInitInputsError(["HOT_UPDATER_SUPABASE_PROJECT_ID"]);
    }
    p.log.warn("Saved Supabase project was not found. Select a project again.");
  }
  if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: projectsProcess.length,
      savedIdentifier: preferredProjectId,
    }) &&
    projectsProcess[0]
  ) {
    p.log.info(`Using the only Supabase project: ${projectsProcess[0].name}`);
    return { create: false, project: projectsProcess[0] };
  }

  const createProjectOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedProjectId = await p.select({
    message: "Select a Supabase project",
    options: [
      ...projectsProcess.map((project) => ({
        label: `${project.name} (${project.region})`,
        value: project.id,
      })),
      {
        label: "Create a new project",
        value: createProjectOption,
      },
    ],
  });

  if (p.isCancel(selectedProjectId)) {
    process.exit(0);
  }

  if (selectedProjectId === createProjectOption) {
    return { create: true };
  }

  const selectedProject = projectsProcess.find(
    (project) => project.id === selectedProjectId,
  );
  if (!selectedProject) {
    throw new Error("Project not found");
  }

  return { create: false, project: selectedProject };
};

export type SupabaseBucketSelection =
  | {
      readonly create: false;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly create: true;
      readonly name: string;
    };

export const selectBucket = async (
  api: SupabaseApi,
  preferredBucketName?: string,
  nonInteractive = false,
): Promise<SupabaseBucketSelection> => {
  let buckets: { id: string; name: string; isPublic: boolean }[] = [];
  let retryCount = 0;

  await p.tasks([
    {
      title: "Fetching bucket list...",
      task: async (message) => {
        while (retryCount < 60 * 5) {
          try {
            if (retryCount === 5) {
              message(
                "Supabase project is not ready yet. This might take a few minutes.",
              );
            }

            buckets = await api.listBuckets();
            return `Retrieved ${buckets.length} buckets`;
          } catch {
            retryCount++;
            await delay(1000);
          }
        }
        p.log.error("Failed to fetch bucket list");
        process.exit(1);
      },
    },
  ]);

  const preferredBucket = buckets.find(
    (bucket) => bucket.name === preferredBucketName,
  );
  if (preferredBucket) {
    p.log.info(`Using saved Supabase bucket: ${preferredBucket.name}`);
    return {
      create: false,
      id: preferredBucket.id,
      name: preferredBucket.name,
    };
  }
  if (preferredBucketName) {
    if (nonInteractive) {
      return { create: true, name: preferredBucketName };
    }
    p.log.warn("Saved Supabase bucket was not found. Select a bucket again.");
  }
  if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: buckets.length,
      savedIdentifier: preferredBucketName,
    }) &&
    buckets[0]
  ) {
    p.log.info(`Using the only Supabase bucket: ${buckets[0].name}`);
    return {
      create: false,
      id: buckets[0].id,
      name: buckets[0].name,
    };
  }

  const createBucketOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedBucketId = await p.select({
    message: "Select a storage bucket",
    options: [
      ...buckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create a new private bucket",
        value: createBucketOption,
      },
    ],
  });

  if (p.isCancel(selectedBucketId)) {
    process.exit(0);
  }

  if (selectedBucketId === createBucketOption) {
    const bucketName = await p.text({
      message: "Enter a name for the new bucket",
    });

    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    return { create: true, name: bucketName };
  }

  const selectedBucket = buckets.find(
    (bucket) => bucket.id === selectedBucketId,
  );
  if (!selectedBucket) {
    throw new Error("Selected Supabase bucket was not found.");
  }
  return {
    create: false,
    id: selectedBucket.id,
    name: selectedBucket.name,
  };
};

export const createSelectedBucket = async (
  api: SupabaseApi,
  selection: SupabaseBucketSelection,
): Promise<{ readonly id: string; readonly name: string }> => {
  if (!selection.create) {
    return selection;
  }

  await api.createBucket(selection.name, { public: false });
  p.log.success(`Bucket "${selection.name}" created successfully.`);
  const buckets = await api.listBuckets();
  const bucket = buckets.find((item) => item.name === selection.name);
  if (!bucket) {
    throw new Error("Failed to create and select new bucket");
  }
  return { id: bucket.id, name: bucket.name };
};

const deployEdgeFunction = async (
  accessToken: string,
  workdir: string,
  projectId: string,
  functionName: string,
) => {
  const edgeFunctionsLibPath = path.join(workdir, "supabase", "edge-functions");
  const edgeFunctionsCodePath = path.join(edgeFunctionsLibPath, "index.ts");
  const edgeFunctionsCode = transformEnv(edgeFunctionsCodePath, {
    FUNCTION_NAME: functionName,
  });

  if (!isSupabaseFunctionName(functionName)) {
    throw new Error("Invalid Supabase Edge Function name.");
  }
  const functionsDir = path.resolve(workdir, "supabase", "functions");
  const targetDir = path.resolve(functionsDir, functionName);
  if (!targetDir.startsWith(`${functionsDir}${path.sep}`)) {
    throw new Error(
      "Supabase Edge Function path escaped its output directory.",
    );
  }
  await fs.mkdir(targetDir, { recursive: true });
  const denoConfig = await resolveEdgeFunctionDenoConfig(targetDir);

  const targetPath = path.join(targetDir, "index.ts");
  await fs.writeFile(targetPath, edgeFunctionsCode);
  await fs.writeFile(
    path.join(targetDir, "deno.json"),
    `${JSON.stringify(denoConfig, null, 2)}\n`,
  );

  await p.tasks([
    {
      title: "Supabase edge function deploy. This may take a few minutes.",
      task: async () => {
        try {
          const dbPush = await execa(
            "npx",
            [
              "supabase",
              "functions",
              "deploy",
              functionName,
              "--project-ref",
              projectId,
              "--no-verify-jwt",
              "--workdir",
              workdir,
            ],
            {
              cwd: workdir,
              env: {
                SUPABASE_ACCESS_TOKEN: accessToken,
              },
            },
          );
          return dbPush.stdout;
        } catch (err) {
          if (err instanceof ExecaError && err.stderr) {
            p.log.error(err.stderr);
          } else if (err instanceof Error) {
            p.log.error(err.message);
          }
          process.exit(1);
        }
      },
    },
  ]);
};

export const waitForSupabaseProjectReady = async ({
  getProjectStatus,
  maxAttempts = SUPABASE_PROJECT_READINESS_MAX_ATTEMPTS,
  onLongWait,
  pollIntervalMs = SUPABASE_PROJECT_READINESS_POLL_INTERVAL_MS,
}: {
  readonly getProjectStatus: () => Promise<string>;
  readonly maxAttempts?: number;
  readonly onLongWait: () => void;
  readonly pollIntervalMs?: number;
}): Promise<void> => {
  let lastStatus: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastStatus = await getProjectStatus();
    if (lastStatus === SUPABASE_PROJECT_READY_STATUS) {
      return;
    }
    if (lastStatus !== SUPABASE_PROJECT_PROVISIONING_STATUS) {
      throw new Error(
        `Supabase project entered unexpected status: ${lastStatus}.`,
      );
    }
    if (attempt === 5) {
      onLongWait();
    }
    if (attempt < maxAttempts - 1) {
      await delay(pollIntervalMs);
    }
  }
  throw new Error(
    `Timed out while waiting for the Supabase project. Last status: ${lastStatus ?? "unknown"}.`,
  );
};

export const getSupabaseProjectAccess = async ({
  accessToken,
  managementApi,
  project,
  waitForProject,
}: {
  readonly accessToken: string;
  readonly managementApi: SupabaseManagementApi;
  readonly project: SupabaseProject;
  readonly waitForProject: boolean;
}): Promise<{
  readonly api: SupabaseApi;
  readonly serviceRoleApiKey: string;
}> => {
  const getServiceRoleApiKey = async () => {
    const keysProcess = await execa(
      "npx",
      [
        "-y",
        "supabase",
        "projects",
        "api-keys",
        "--project-ref",
        project.id,
        "--output",
        "json",
      ],
      {
        env: {
          SUPABASE_ACCESS_TOKEN: accessToken,
        },
      },
    );
    const apiKeys: { api_key: string; name: string }[] = JSON.parse(
      keysProcess.stdout ?? "[]",
    );
    return apiKeys.find((key) => key.name === "service_role")?.api_key;
  };

  let serviceRoleApiKey: string | undefined;
  if (waitForProject) {
    await p.tasks([
      {
        title: `Waiting for ${project.name} to become ready...`,
        task: async (message) => {
          await waitForSupabaseProjectReady({
            getProjectStatus: () => managementApi.getProjectStatus(project.id),
            onLongWait: () => {
              message(
                "Supabase project is still provisioning. This might take a few minutes.",
              );
            },
          });
          serviceRoleApiKey = await getServiceRoleApiKey();
          return "Supabase project is ready.";
        },
      },
    ]);
  } else {
    const spinner = p.spinner();
    spinner.start(`Getting API keys for ${project.name}...`);
    try {
      serviceRoleApiKey = await getServiceRoleApiKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get Supabase API keys: ${message}`);
    } finally {
      spinner.stop();
    }
  }

  if (!serviceRoleApiKey) {
    throw new Error("Service role key not found, is your project paused?");
  }

  return {
    api: supabaseApi(`https://${project.id}.supabase.co`, serviceRoleApiKey),
    serviceRoleApiKey,
  };
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const nonInteractive = envFile !== undefined;
  const {
    env: existingEnv,
    inputEnv,
    managedEnv,
  } = await readHotUpdaterInitEnv(process.cwd(), envFile);
  const savedInputs = resolveSupabaseInitInputs(existingEnv, {
    inputEnv,
    managedEnv,
  });
  assertSupabaseNonInteractiveInputs(savedInputs, nonInteractive);
  const initInputs = await inputSupabaseDeploymentInputs({
    ...savedInputs,
    nonInteractive,
  });
  const { accessToken, functionName } = initInputs;
  const projectSelection = await selectProject(
    savedInputs.projectId,
    nonInteractive,
    accessToken,
  );
  let project = projectSelection.create ? undefined : projectSelection.project;
  const projectChanged =
    savedInputs.projectId !== undefined &&
    (project === undefined || savedInputs.projectId !== project.id);
  const dbPassword = await inputSupabaseDatabasePassword({
    databasePassword: savedInputs.databasePassword,
    forcePrompt: projectChanged || projectSelection.create,
    nonInteractive,
    required: projectSelection.create,
  });

  const managementApi = supabaseManagementApi(accessToken);
  const projectCreationInputs = projectSelection.create
    ? await inputSupabaseProjectCreationInputs({
        bucketName: savedInputs.bucketName,
        organizationSlug: savedInputs.organizationSlug,
        organizations: await managementApi.listOrganizations(),
        projectName: savedInputs.projectName,
        region: savedInputs.region,
      })
    : undefined;
  let projectAccess =
    project === undefined
      ? undefined
      : await getSupabaseProjectAccess({
          accessToken,
          managementApi,
          project,
          waitForProject: false,
        });
  let bucketSelection: SupabaseBucketSelection;
  if (project && projectAccess) {
    bucketSelection = await selectBucket(
      projectAccess.api,
      savedInputs.bucketName,
      nonInteractive,
    );
  } else if (projectCreationInputs) {
    bucketSelection = {
      create: true,
      name: projectCreationInputs.bucketName,
    };
  } else {
    throw new Error("Failed to plan the Supabase storage bucket.");
  }
  const inputsBeforeProvisioning = {
    ...savedInputs,
    ...projectCreationInputs,
    accessToken,
    bucketName: bucketSelection.name,
    databasePassword: dbPassword,
    functionName,
    projectId: project?.id,
  };
  const databasePasswordKey =
    SUPABASE_INIT_PROVIDER.inputs.databasePassword.envKey;
  const databasePasswordNeedsConsent =
    dbPassword !== "" &&
    (projectSelection.create ||
      managedEnv[SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY] !==
        project?.id);
  const existingEnvForConsent = databasePasswordNeedsConsent
    ? {
        ...managedEnv,
        [databasePasswordKey]: "",
      }
    : managedEnv;
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv: existingEnvForConsent,
    inputs: inputsBeforeProvisioning,
    nonInteractive,
    provider: SUPABASE_INIT_PROVIDER,
  });

  if (projectSelection.create) {
    if (!projectCreationInputs) {
      throw new Error("Supabase project creation inputs were not resolved.");
    }
    project = await managementApi.createProject({
      databasePassword: dbPassword,
      name: projectCreationInputs.projectName,
      organizationSlug: projectCreationInputs.organizationSlug,
      region: projectCreationInputs.region,
    });
    projectAccess = await getSupabaseProjectAccess({
      accessToken,
      managementApi,
      project,
      waitForProject: true,
    });
  }
  if (!project || !projectAccess) {
    throw new Error("Failed to resolve the Supabase project.");
  }

  const resolvedInputs = {
    ...inputsBeforeProvisioning,
    projectId: project.id,
  };
  const providerEnv = getInitProviderEnvVars({
    includeConsentInputs: persistCredentialInputs,
    inputs: resolvedInputs,
    provider: SUPABASE_INIT_PROVIDER,
  });
  const persistDatabasePassword = persistCredentialInputs && dbPassword !== "";
  if (persistDatabasePassword) {
    providerEnv[SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY] = project.id;
  }
  await makeEnv(providerEnv, ".env.hotupdater", {
    removeKeys: persistDatabasePassword
      ? []
      : [databasePasswordKey, SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY],
  });

  const bucket = await createSelectedBucket(projectAccess.api, bucketSelection);
  await makeEnv({
    [SUPABASE_INIT_PROVIDER.inputs.projectId.envKey]: project.id,
    HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY: projectAccess.serviceRoleApiKey,
    [SUPABASE_INIT_PROVIDER.inputs.bucketName.envKey]: bucket.name,
    HOT_UPDATER_SUPABASE_URL: `https://${project.id}.supabase.co`,
  });
  const scaffoldLibPath = path.dirname(
    path.resolve(require.resolve("@hot-updater/supabase/scaffold")),
  );

  const { tmpDir, removeTmpDir } = await copyDirToTmp(
    scaffoldLibPath,
    "supabase",
  );

  const migrationPath = await path.join(tmpDir, "supabase", "migrations");
  const migrationFiles = await fs.readdir(migrationPath);
  for (const file of migrationFiles) {
    if (file.endsWith(".sql")) {
      const filePath = path.join(migrationPath, file);
      const content = await fs.readFile(filePath, "utf-8");
      await fs.writeFile(
        filePath,
        transformTemplate(content, {
          BUCKET_NAME: bucket.name,
        }),
      );
    }
  }

  await linkSupabase(tmpDir, {
    accessToken,
    projectId: project.id,
    dbPassword,
  });

  await pushDB(tmpDir, { accessToken, dbPassword });
  await deployEdgeFunction(accessToken, tmpDir, project.id, functionName);

  await removeTmpDir();

  const configWriteResult = await writeHotUpdaterConfig(
    getConfigScaffold(build),
  );
  await assertSkippedConfigDoesNotUseLegacySupabaseKey(configWriteResult);

  p.log.success("Generated '.env.hotupdater' file with Supabase settings.");
  if (configWriteResult.status === "created") {
    p.log.success(
      "Generated 'hot-updater.config.ts' file with Supabase settings.",
    );
  } else if (configWriteResult.status === "merged") {
    p.log.success(
      "Updated 'hot-updater.config.ts' file with Supabase settings.",
    );
  } else {
    p.log.warn(
      `Kept existing 'hot-updater.config.ts' unchanged: ${configWriteResult.reason}`,
    );
  }

  p.note(
    transformTemplate(SOURCE_TEMPLATE, {
      source: `https://${project.id}.supabase.co/functions/v1/${functionName}`,
    }),
  );

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/supabase#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
