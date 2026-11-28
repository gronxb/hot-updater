import type { InitProviderDefinition } from "@hot-updater/cli-tools";

/**
 * A Vercel project name: up to 100 lowercase letters, digits, `.`, `_`, and
 * `-`, without the `---` sequence Vercel reserves.
 */
export const isVercelProjectName = (value: string | undefined) =>
  value !== undefined &&
  /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value) &&
  !value.includes("---");

/** A Blob store name: letters, digits, `_`, and `-`. */
export const isVercelBlobStoreName = (value: string | undefined) =>
  value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value);

export const isPostgresUrl = (value: string | undefined) => {
  if (value === undefined) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
};

export const initProvider = {
  label: "Vercel Blob + Functions + Postgres",
  inputs: {
    teamId: {
      envKey: "HOT_UPDATER_VERCEL_TEAM_ID",
      help: "Vercel team ID (team_...), or the user ID of a personal account",
      prompt: {
        message: "Select a Vercel team",
        type: "select",
      },
    },
    projectName: {
      envKey: "HOT_UPDATER_VERCEL_PROJECT_NAME",
      help: "Vercel project that runs the Hot Updater Function",
      prompt: {
        defaultValue: "hot-updater",
        message: "Enter a name for the Vercel project",
        placeholder: "hot-updater",
        type: "text",
      },
      validate: isVercelProjectName,
    },
    projectId: {
      envKey: "HOT_UPDATER_VERCEL_PROJECT_ID",
      help: "Vercel project ID (prj_...), saved by init",
      optional: true,
    },
    blobStoreName: {
      envKey: "HOT_UPDATER_VERCEL_BLOB_STORE_NAME",
      help: "Blob store that keeps the bundles",
      prompt: {
        defaultValue: "hot-updater-storage",
        message: "Enter a name for the new Blob store",
        placeholder: "hot-updater-storage",
        type: "text",
      },
      validate: isVercelBlobStoreName,
    },
    blobStoreId: {
      envKey: "HOT_UPDATER_VERCEL_BLOB_STORE_ID",
      help: "Blob store ID (store_...), saved by init",
      optional: true,
    },
    blobReadWriteToken: {
      envKey: "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
      help: "The Blob store's read-write token, which init reads from the project",
      optional: true,
      persistence: "with-consent",
      preflight: false,
    },
    databaseUrl: {
      envKey: "HOT_UPDATER_VERCEL_DATABASE_URL",
      help: "PostgreSQL connection URL of the Hot Updater database",
      persistence: "with-consent",
      prompt: {
        message: "Enter the PostgreSQL connection URL",
        type: "password",
      },
      validate: isPostgresUrl,
    },
    vercelToken: {
      envKey: "VERCEL_TOKEN",
      help: "Vercel access token; without it, init uses the Vercel CLI login",
      optional: true,
      persistence: "with-consent",
      preflight: false,
    },
  },
  secrets: [
    "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
    "HOT_UPDATER_VERCEL_DATABASE_URL",
  ],
} as const satisfies InitProviderDefinition;
