import path from "path";
import {
  selectBucket,
  selectOrCreateOrganization,
  selectProject,
} from "@/commands/supabase/select";

import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import { copyDirToTmp } from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: metro({ enableHermes: true }),
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

const linkSupabase = async (supabasePath: string, projectId: string) => {
  const spinner = p.spinner();
  spinner.start("Linking Supabase...");

  try {
    const { supabaseConfigTomlTemplate } = await import(
      "@hot-updater/supabase"
    );

    const { tmpDir, removeTmpDir } = await copyDirToTmp(supabasePath);

    // Write the config.toml with correct projectId
    await fs.writeFile(
      path.join(tmpDir, "supabase", "config.toml"),
      transformTemplate(supabaseConfigTomlTemplate, {
        projectId,
      }),
    );

    // Link
    await execa(
      "npx",
      ["supabase", "link", "--project-ref", projectId, "--workdir", tmpDir],
      {
        cwd: tmpDir,
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    spinner.stop("Supabase linked ✔");
    return { tmpDir, removeTmpDir };
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

  const { tmpDir, removeTmpDir } = await linkSupabase(supabasePath, project.id);
  await pushDB(tmpDir);
  await deployEdgeFunction(tmpDir, project.id);
  await removeTmpDir();

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
