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
  link,
  makeEnv,
  type HotUpdaterConfigScaffold,
  MissingInitInputsError,
  type ProviderConfig,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  resolvePackageVersion,
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
  inputSupabaseDeploymentInputs,
  resolveSupabaseInitInputs,
} from "./supabaseInitInputs";

const require = createRequire(import.meta.url);
const EDGE_VENDOR_DIR = "_hot-updater";
const WORKSPACE_PACKAGE_PREFIX = "@hot-updater/";
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

export const selectProject = async (
  preferredProjectId?: string,
  nonInteractive = false,
  accessToken?: string,
): Promise<{
  id: string;
  name: string;
  region: string;
}> => {
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
    return preferredProject;
  }
  if (preferredProjectId) {
    if (nonInteractive) {
      throw new MissingInitInputsError(["HOT_UPDATER_SUPABASE_PROJECT_ID"]);
    }
    p.log.warn("Saved Supabase project was not found. Select a project again.");
  }
  if (projectsProcess.length === 1 && projectsProcess[0]) {
    p.log.info(`Using the only Supabase project: ${projectsProcess[0].name}`);
    return projectsProcess[0];
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
    try {
      await execa("npx", ["-y", "supabase", "projects", "create"], {
        env: accessToken
          ? {
              [SUPABASE_INIT_PROVIDER.inputs.accessToken.envKey]: accessToken,
            }
          : undefined,
        stdio: "inherit",
        shell: true,
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.error(err.stderr);
      } else {
        console.error(err);
      }
      process.exit(1);
    }

    // Re-run the selection after creating a new project
    return selectProject(undefined, false, accessToken);
  }

  const selectedProject = projectsProcess.find(
    (project) => project.id === selectedProjectId,
  );
  if (!selectedProject) {
    throw new Error("Project not found");
  }

  return selectedProject;
};

export const selectBucket = async (
  api: SupabaseApi,
  preferredBucketName?: string,
  nonInteractive = false,
): Promise<{
  id: string;
  name: string;
}> => {
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
  const createAndSelectBucket = async (bucketName: string) => {
    await api.createBucket(bucketName, { public: false });
    p.log.success(`Bucket "${bucketName}" created successfully.`);
    const updatedBuckets = await api.listBuckets();
    const newBucket = updatedBuckets.find(
      (bucket) => bucket.name === bucketName,
    );
    if (!newBucket) {
      throw new Error("Failed to create and select new bucket");
    }
    return { id: newBucket.id, name: newBucket.name };
  };
  if (preferredBucket) {
    p.log.info(`Using saved Supabase bucket: ${preferredBucket.name}`);
    return { id: preferredBucket.id, name: preferredBucket.name };
  }
  if (preferredBucketName) {
    if (nonInteractive) {
      return createAndSelectBucket(preferredBucketName);
    }
    p.log.warn("Saved Supabase bucket was not found. Select a bucket again.");
  }
  if (buckets.length === 1 && buckets[0]) {
    p.log.info(`Using the only Supabase bucket: ${buckets[0].name}`);
    return { id: buckets[0].id, name: buckets[0].name };
  }

  const createBucketOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedBucketId = await p.select({
    message: "Select a storage bucket",
    options: [
      ...buckets.map((bucket) => ({
        label: bucket.name,
        value: JSON.stringify({ id: bucket.id, name: bucket.name }),
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

    try {
      return await createAndSelectBucket(bucketName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Failed to create new bucket: ${message}`);
      process.exit(1);
    }
  }

  return JSON.parse(selectedBucketId);
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

  const targetDir = path.join(workdir, "supabase", "functions", functionName);
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

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const nonInteractive = envFile !== undefined;
  const { env: existingEnv } = await readHotUpdaterInitEnv(
    process.cwd(),
    envFile,
  );
  const savedInputs = resolveSupabaseInitInputs(existingEnv);
  assertSupabaseNonInteractiveInputs(savedInputs, nonInteractive);
  const initInputs = await inputSupabaseDeploymentInputs({
    ...savedInputs,
    nonInteractive,
  });
  const resolvedInputs = {
    ...savedInputs,
    accessToken: initInputs.accessToken,
    databasePassword: initInputs.dbPassword || undefined,
    functionName: initInputs.functionName,
  };
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv,
    inputs: resolvedInputs,
    nonInteractive,
    provider: SUPABASE_INIT_PROVIDER,
  });
  await makeEnv({
    ...getInitProviderEnvVars({
      includeConsentInputs: persistCredentialInputs,
      inputs: resolvedInputs,
      provider: SUPABASE_INIT_PROVIDER,
    }),
  });

  const { accessToken, dbPassword, functionName } = initInputs;
  const project = await selectProject(
    savedInputs.projectId,
    nonInteractive,
    accessToken,
  );
  await makeEnv({
    HOT_UPDATER_SUPABASE_PROJECT_ID: project.id,
  });

  const spinner = p.spinner();
  spinner.start(`Getting API keys for ${project.name}...`);
  let apiKeys: { api_key: string; name: string }[] = [];
  try {
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
    apiKeys = JSON.parse(keysProcess.stdout ?? "[]");
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to get API keys: ${message}`);
    process.exit(1);
  }
  spinner.stop();

  const serviceRoleApiKey = apiKeys.find((key) => key.name === "service_role");
  if (!serviceRoleApiKey) {
    throw new Error("Service role key not found, is your project paused?");
  }

  const api = supabaseApi(
    `https://${project.id}.supabase.co`,
    serviceRoleApiKey.api_key,
  );
  const bucket = await selectBucket(
    api,
    savedInputs.bucketName,
    nonInteractive,
  );
  await makeEnv({
    [SUPABASE_INIT_PROVIDER.inputs.projectId.envKey]: project.id,
    HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY: serviceRoleApiKey.api_key,
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
