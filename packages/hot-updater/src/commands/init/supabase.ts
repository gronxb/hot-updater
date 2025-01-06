import { getPackageManager } from "@/utils/getPackageManager";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import {
  type SupabaseApi,
  supabaseApi,
  supabaseConfigTomlTemplate,
} from "@hot-updater/supabase";
import fs from "fs/promises";

import path from "path";
import { ExecaError, execa } from "execa";

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  override: true,
});


export default defineConfig({
  build: metro(),
  storage: supabaseStorage({
    supabaseUrl: "%%SUPABASE_URL%%",
    supabaseAnonKey: "%%SUPABASE_ANON_KEY%%",
    bucketName: "%%SUPABASE_BUCKET_NAME%%",
  }),
  database: supabaseDatabase({
    supabaseUrl: "%%SUPABASE_URL%%",
    supabaseAnonKey: "%%SUPABASE_ANON_KEY%%",
  }),
});
`;

const selectBucket = async (api: SupabaseApi) => {
  const buckets = await api.listBuckets();
  const publicBuckets = buckets.filter((bucket: any) => bucket.isPublic);

  const identityCreate = `create/${Math.random().toString(36).substring(2, 15)}`;
  const selectedStorageId = await p.select({
    message: "Select your storage",
    options: [
      ...publicBuckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create new public bucket",
        value: identityCreate,
      },
    ],
  });

  if (p.isCancel(selectedStorageId)) {
    process.exit(0);
  }

  if (selectedStorageId === identityCreate) {
    const bucketName = await p.text({
      message: "Enter your bucket name",
    });
    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    await api.createBucket(bucketName, {
      public: true,
    });
    return null;
  }

  return selectedStorageId;
};

const PACKAGE_NAME = "@hot-updater/supabase";

export const initSupabase = async () => {
  const spinner = p.spinner();

  await p.tasks([
    {
      title: `Checking ${PACKAGE_NAME}`,
      task: async (message) => {
        const supabasePath = require.resolve("@hot-updater/supabase");
        if (supabasePath) {
          return `Installed ${PACKAGE_NAME}`;
        }

        const packageManager = getPackageManager();
        message(`Installing ${PACKAGE_NAME}`);

        await execa(packageManager, ["install", PACKAGE_NAME]);
        return `Installed ${PACKAGE_NAME}`;
      },
    },
  ]);

  const confirmed = await p.confirm({
    message: "Do you have supabsae organization?",
    initialValue: true,
  });

  if (p.isCancel(confirmed)) {
    process.exit(0);
  }
  if (!confirmed) {
    const orgName = await p.text({
      message: "Enter your supabase organization name",
    });
    if (p.isCancel(orgName)) {
      process.exit(0);
    }

    try {
      await execa("npx", ["-y", "supabase", "orgs", "create", orgName], {
        stdio: "inherit",
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.log(err.stderr);
        process.exit(1);
      }
      console.error(err);
      process.exit(1);
    }
  }

  const projectConfirmed = await p.confirm({
    message: "Do you have supabsae project?",
    initialValue: true,
  });

  if (p.isCancel(projectConfirmed)) {
    process.exit(0);
  }

  if (!projectConfirmed) {
    try {
      await execa("npx", ["-y", "supabase", "projects", "create"], {
        stdio: "inherit",
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.log(err.stderr);
      }
      console.error(err);
      process.exit(1);
    }
  }

  spinner.start("Getting projects");
  const listProjects = await execa("npx", [
    "-y",
    "supabase",
    "projects",
    "list",
    "--output",
    "json",
  ]);
  const projectsProcess = JSON.parse(listProjects.stdout ?? "[]") as {
    created_at: string;
    database: {
      host: string;
      postgres_engine: string;
      release_channel: string;
      version: string;
    };
    id: string;
    name: string;
    organization_id: string;
    region: string;
    status: string;
    linked: boolean;
  }[];

  spinner.stop();

  const selectedProjectId = await p.select({
    message: "Select your project",
    options: projectsProcess.map((p) => ({
      label: `${p.name} (${p.region})`,
      value: p.id,
    })),
  });
  if (p.isCancel(selectedProjectId)) {
    process.exit(0);
  }

  const project = projectsProcess.find((p) => p.id === selectedProjectId);
  if (!project) {
    throw new Error("Project not found");
  }

  spinner.start(`Getting api keys (${project?.name})`);
  const apisKeysProcess = await execa("npx", [
    "-y",
    "supabase",
    "projects",
    "api-keys",
    "--project-ref",
    selectedProjectId,
    "--output",
    "json",
  ]);
  spinner.stop();

  const apiKeys = JSON.parse(apisKeysProcess.stdout ?? "[]") as {
    api_key: string;
    name: string;
  }[];

  const serviceRoleKey = apiKeys.find((key) => key.name === "service_role");

  if (!serviceRoleKey) {
    throw new Error("Service role key not found");
  }

  const api = supabaseApi(
    `https://${project.id}.supabase.co`,
    serviceRoleKey.api_key,
  );

  let bucketId: string | null = null;
  do {
    bucketId = await selectBucket(api);
  } while (!bucketId);

  const supabasePath = path.resolve(
    require.resolve("@hot-updater/supabase"),
    "..",
    "..",
  );

  await p.tasks([
    {
      title: "Supabase linking",
      task: async () => {
        try {
          await fs.writeFile(
            path.join(supabasePath, "supabase", "config.toml"),
            transformTemplate(supabaseConfigTomlTemplate, {
              projectId: project.id,
            }),
          );

          await execa(
            "npx",
            [
              "supabase",
              "link",
              "--project-ref",
              project.id,
              "--workdir",
              supabasePath,
            ],
            {
              input: "",
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          return "Supabase linked";
        } catch (err) {
          if (err instanceof ExecaError) {
            console.log(err.stderr);
          } else {
            console.log(err);
          }
          process.exit(1);
        }
      },
    },
    {
      title: "Supabase db push",
      task: async () => {
        try {
          const dbPush = await execa("npx", ["supabase", "db", "push"], {
            cwd: supabasePath,
          });
          return dbPush.stdout;
        } catch (err) {
          if (err instanceof ExecaError) {
            console.log(err.stderr);
          } else {
            console.log(err);
          }
          process.exit(1);
        }
      },
    },
  ]);

  transformTemplate(CONFIG_TEMPLATE, {
    SUPABASE_ANON_KEY: serviceRoleKey.api_key,
    SUPABASE_URL: `https://${project.id}.supabase.co`,
    SUPABASE_BUCKET_NAME: bucketId,
  });

  // TODO: db migration, edge functions deploy만 하면 끝
  // TODO: db storage upload / remove 테스트
};
