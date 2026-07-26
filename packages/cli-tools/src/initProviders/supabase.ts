import type { InitProviderDefinition } from "../initProvider";

export const isSupabaseFunctionName = (
  value: string | undefined,
): value is string =>
  value !== undefined && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

export const SUPABASE_INIT_PROVIDER = {
  label: "Supabase",
  inputs: {
    projectId: {
      envKey: "HOT_UPDATER_SUPABASE_PROJECT_ID",
      help: "Supabase project reference",
    },
    accessToken: {
      envKey: "SUPABASE_ACCESS_TOKEN",
      help: "Supabase personal access token",
      persistence: "with-consent",
      prompt: {
        message: "Enter your Supabase personal access token",
        type: "password",
      },
    },
    bucketName: {
      envKey: "HOT_UPDATER_SUPABASE_BUCKET_NAME",
      help: "Storage bucket name",
    },
    functionName: {
      envKey: "HOT_UPDATER_SUPABASE_FUNCTION_NAME",
      help: "Edge Function name",
      prompt: {
        defaultValue: "update-server",
        message: "Enter a name for the edge function",
        placeholder: "update-server",
        type: "text",
      },
      validate: isSupabaseFunctionName,
    },
    databasePassword: {
      envKey: "HOT_UPDATER_SUPABASE_DB_PASSWORD",
      help: "Database password, when required by the linked project",
      optional: true,
      persistence: "with-consent",
      prompt: {
        message:
          "Enter your Supabase database password (press Enter to skip if none)",
        type: "password",
      },
    },
  },
} as const satisfies InitProviderDefinition;
