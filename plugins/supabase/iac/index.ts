import {
  type BuildType,
  ConfigBuilder,
  copyDirToTmp,
  link,
  makeEnv,
  type ProviderConfig,
  p,
  transformEnv,
  transformTemplate,
} from "@hot-updater/cli-tools";
import { delay } from "es-toolkit";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { type SupabaseApi, supabaseApi } from "./supabaseApi";

const getConfigTemplate = (build: BuildType) => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
    configString: `supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
    configString: `supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  })`,
  };

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .getResult();
};

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater, getUpdateSource } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: getUpdateSource("%%source%%", {
    updateStrategy: "appVersion", // or "fingerprint"
  }),
})(App);`;

const SUPABASE_CONFIG_TEMPLATE = `
project_id = "%%projectId%%"

[db.seed]
enabled = false
`;

export const selectProject = async (): Promise<{
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
      {},
    );

    projectsProcess =
      listProjects.stdout === "null"
        ? []
        : JSON.parse(listProjects?.stdout ?? "[]");
  } catch (err) {
    spinner.stop();
    console.error("Failed to fetch Supabase projects:", err);
    process.exit(1);
  }

  spinner.stop();

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
    return selectProject();
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
      await api.createBucket(bucketName, { public: false });
      p.log.success(`Bucket "${bucketName}" created successfully.`);
      const buckets = await api.listBuckets();

      const newBucket = buckets.find((bucket) => bucket.name === bucketName);
      if (!newBucket) {
        throw new Error("Failed to create and select new bucket");
      }
      return { id: newBucket.id, name: newBucket.name };
    } catch (err) {
      p.log.error(`Failed to create new bucket: ${err}`);
      process.exit(1);
    }
  }

  return JSON.parse(selectedBucketId);
};

const linkSupabase = async (
  workdir: string,
  { projectId, dbPassword }: { projectId: string; dbPassword?: string },
) => {
  const spinner = p.spinner();

  try {
    // Write the config.toml with correct projectId
    await fs.writeFile(
      path.join(workdir, "supabase", "config.toml"),
      transformTemplate(SUPABASE_CONFIG_TEMPLATE, {
        projectId,
      }),
    );

    spinner.start("Linking Supabase...");

    // Link with password
    await execa(
      "npx",
      [
        "supabase",
        "link",
        "--project-ref",
        projectId,
        "--workdir",
        workdir,
        dbPassword ? ["--password", dbPassword] : [],
      ].flat(),
      {
        cwd: workdir,
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    spinner.stop("Supabase linked ✔");
  } catch (err) {
    spinner.stop();
    if (err instanceof ExecaError && err.stderr) {
      p.log.error(err.stderr);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
};

const pushDB = async (
  workdir: string,
  { dbPassword }: { dbPassword?: string },
) => {
  try {
    const dbPush = await execa(
      "npx",
      [
        "supabase",
        "db",
        "push",
        "--include-all",
        dbPassword ? ["--password", dbPassword] : [],
      ].flat(),
      {
        cwd: workdir,
        stdio: "inherit",
        shell: true,
      },
    );
    p.log.success("DB pushed ✔");
    return dbPush.stdout;
  } catch (err) {
    if (err instanceof ExecaError && err.stderr) {
      p.log.error(err.stderr);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
};

const deployEdgeFunction = async (workdir: string, projectId: string) => {
  const functionName = await p.text({
    message: "Enter a name for the edge function",
    initialValue: "update-server",
    placeholder: "update-server",
  });

  if (p.isCancel(functionName)) {
    process.exit(0);
  }
  const edgeFunctionsLibPath = path.join(workdir, "supabase", "edge-functions");
  const edgeFunctionsCodePath = path.join(edgeFunctionsLibPath, "index.ts");
  const edgeFunctionsCode = transformEnv(edgeFunctionsCodePath, {
    FUNCTION_NAME: functionName,
  });

  const targetDir = path.join(workdir, "supabase", "functions", functionName);
  await fs.mkdir(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, "index.ts");
  await fs.writeFile(targetPath, edgeFunctionsCode);

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
            },
          );
          return dbPush.stdout;
        } catch (err) {
          if (err instanceof ExecaError && err.stderr) {
            p.log.error(err.stderr);
          } else {
            console.error(err);
          }
          process.exit(1);
        }
      },
    },
  ]);
};

export const runInit = async ({ build }: { build: BuildType }) => {
  const project = await selectProject();

  const spinner = p.spinner();
  spinner.start(`Getting API keys for ${project.name}...`);
  let apiKeys: { api_key: string; name: string }[] = [];
  try {
    const keysProcess = await execa("npx", [
      "-y",
      "supabase",
      "projects",
      "api-keys",
      "--project-ref",
      project.id,
      "--output",
      "json",
    ]);
    apiKeys = JSON.parse(keysProcess.stdout ?? "[]");
  } catch (err) {
    spinner.stop();
    console.error("Failed to get API keys:", err);
    process.exit(1);
  }
  spinner.stop();

  const serviceRoleKey = apiKeys.find((key) => key.name === "service_role");
  if (!serviceRoleKey) {
    throw new Error("Service role key not found, is your project paused?");
  }

  const api = supabaseApi(
    `https://${project.id}.supabase.co`,
    serviceRoleKey.api_key,
  );
  const bucket = await selectBucket(api);

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

  // Get database password from user
  const dbPassword = await p.password({
    message:
      "Enter your Supabase database password (press Enter to skip if none)",
  });

  if (p.isCancel(dbPassword)) {
    process.exit(0);
  }

  await linkSupabase(tmpDir, { projectId: project.id, dbPassword });

  await pushDB(tmpDir, { dbPassword });
  await deployEdgeFunction(tmpDir, project.id);

  await removeTmpDir();

  await fs.writeFile("hot-updater.config.ts", getConfigTemplate(build));

  await makeEnv({
    HOT_UPDATER_SUPABASE_ANON_KEY: serviceRoleKey.api_key,
    HOT_UPDATER_SUPABASE_BUCKET_NAME: bucket.name,
    HOT_UPDATER_SUPABASE_URL: `https://${project.id}.supabase.co`,
  });
  p.log.success("Generated '.env.hotupdater' file with Supabase settings.");
  p.log.success(
    "Generated 'hot-updater.config.ts' file with Supabase settings.",
  );

  p.note(
    transformTemplate(SOURCE_TEMPLATE, {
      source: `https://${project.id}.supabase.co/functions/v1/update-server`,
    }),
  );

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/supabase#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
