import { selectBucket, selectProject } from "@/commands/supabase/select";
import { transformTemplate } from "@/utils/transformTemplate";
import * as p from "@clack/prompts";
import { execa } from "execa";

const CONFIG_TEMPLATE = `
HOT_UPDATER_SUPABASE_URL=%%HOT_UPDATER_SUPABASE_URL%%
HOT_UPDATER_SUPABASE_ANON_KEY=%%HOT_UPDATER_SUPABASE_ANON_KEY%%
HOT_UPDATER_SUPABASE_BUCKET_NAME=%%HOT_UPDATER_SUPABASE_BUCKET_NAME%%
`;

export const getSupabaseEnv = async () => {
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

  p.log.message(
    transformTemplate(CONFIG_TEMPLATE, {
      HOT_UPDATER_SUPABASE_ANON_KEY: serviceRoleKey.api_key,
      HOT_UPDATER_SUPABASE_BUCKET_NAME: bucketId,
      HOT_UPDATER_SUPABASE_URL: `https://${project.id}.supabase.co`,
    }),
  );

  p.outro(
    "Please use these values for reference only and manage them through .env file.",
  );
};
