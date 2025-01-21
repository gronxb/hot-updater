import path from "path";
import { link } from "@/components/banner";
import { delay } from "@/utils/delay";
import { makeEnv } from "@/utils/makeEnv";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import type { SupabaseApi } from "@hot-updater/supabase";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: metro(),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
});
`;

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: "%%source%%",
})(App);`;

const selectOrCreateOrganization = async () => {
  const confirmed = await p.confirm({
    message: "Do you already have a Supabase organization?",
    initialValue: true,
  });
  if (p.isCancel(confirmed)) process.exit(0);

  if (confirmed) {
    // If user already has an organization, just return
    return;
  }

  const orgName = await p.text({
    message: "Enter your new Supabase organization name",
  });
  if (p.isCancel(orgName)) process.exit(0);

  try {
    await execa("npx", ["-y", "supabase", "orgs", "create", orgName], {
      stdio: "inherit",
    });
  } catch (err) {
    if (err instanceof ExecaError && err.stderr) {
      p.log.error(err.stderr);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
};

const selectProject = async () => {
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
    console.error("Failed to list Supabase projects:", err);
    process.exit(1);
  }

  spinner.stop();

  const createProjectOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedProjectId = await p.select({
    message: "Select your Supabase project",
    options: [
      ...projectsProcess.map((project) => ({
        label: `${project.name} (${project.region})`,
        value: project.id,
      })),
      {
        label: "Create new project",
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
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.error(err.stderr);
      } else {
        console.error(err);
      }
      process.exit(1);
    }

    // Re-run after creating a project to select it
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

const selectBucket = async (api: SupabaseApi) => {
  let buckets: { id: string; name: string; isPublic: boolean }[] = [];
  let retryCount = 0;

  await p.tasks([
    {
      title: "Fetching buckets...",
      task: async (message) => {
        while (retryCount < 60 * 5) {
          try {
            if (retryCount === 5) {
              message(
                "Supabase project is not ready yet. This may take a few minutes.",
              );
            }

            buckets = await api.listBuckets();
            return `Fetched ${buckets.length} buckets`;
          } catch (err) {
            retryCount++;
            await delay(1000);
          }
        }
        p.log.error("Failed to list buckets");
        process.exit(1);
      },
    },
  ]);

  const publicBuckets = buckets.filter((bucket) => bucket.isPublic);
  const createBucketOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedBucketId = await p.select({
    message: "Select your storage bucket",
    options: [
      ...publicBuckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create new public bucket",
        value: createBucketOption,
      },
    ],
  });

  if (p.isCancel(selectedBucketId)) {
    process.exit(0);
  }

  if (selectedBucketId === createBucketOption) {
    const bucketName = await p.text({
      message: "Enter your new bucket name",
    });

    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    try {
      await api.createBucket(bucketName, { public: true });
      p.log.success(`Bucket "${bucketName}" created successfully.`);
    } catch (err) {
      p.log.error(`Failed to create a new bucket: ${err}`);
      process.exit(1);
    }

    // Re-run selection to pick the newly created bucket
    return selectBucket(api);
  }

  return selectedBucketId;
};

const linkSupabase = async (supabasePath: string, projectId: string) => {
  const spinner = p.spinner();
  spinner.start("Linking Supabase...");

  try {
    const { supabaseConfigTomlTemplate } = await import(
      "@hot-updater/supabase"
    );
    // Write the config.toml with correct projectId
    await fs.writeFile(
      path.join(supabasePath, "supabase", "config.toml"),
      transformTemplate(supabaseConfigTomlTemplate, {
        projectId,
      }),
    );

    // Link
    await execa(
      "npx",
      [
        "supabase",
        "link",
        "--project-ref",
        projectId,
        "--workdir",
        supabasePath,
      ],
      {
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

const pushDB = async (supabasePath: string) => {
  try {
    const dbPush = await execa("npx", ["supabase", "db", "push"], {
      cwd: supabasePath,
      stdio: "inherit",
    });
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

const deployEdgeFunction = async (supabasePath: string, projectId: string) => {
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
              "update-server",
              "--project-ref",
              projectId,
              "--no-verify-jwt",
            ],
            {
              cwd: supabasePath,
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

export const initSupabase = async () => {
  await selectOrCreateOrganization();

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
    throw new Error("Service role key not found");
  }

  const { supabaseApi } = await import("@hot-updater/supabase");
  const api = supabaseApi(
    `https://${project.id}.supabase.co`,
    serviceRoleKey.api_key,
  );
  const bucketId = await selectBucket(api);

  const supabasePath = path.resolve(
    require.resolve("@hot-updater/supabase"),
    "..",
    "..",
  );

  await linkSupabase(supabasePath, project.id);
  await pushDB(supabasePath);
  await deployEdgeFunction(supabasePath, project.id);

  await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);

  await makeEnv({
    HOT_UPDATER_SUPABASE_ANON_KEY: serviceRoleKey.api_key,
    HOT_UPDATER_SUPABASE_BUCKET_NAME: bucketId,
    HOT_UPDATER_SUPABASE_URL: `https://${project.id}.supabase.co`,
  });
  p.log.success("Generated '.env' file with Supabase settings.");
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
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-supabase.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
