import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import type { DoctorFixability } from "./issues";

/** The variables that hold the vault's master keys. */
const MASTER_KEY_VARIABLES = [
  "HOT_UPDATER_VAULT_MASTER_KEY",
  "HOT_UPDATER_VAULT_MASTER_KEYS",
] as const;

/**
 * Variables that reach a database: those the providers' init writes and
 * their configs read, and the usual connection strings and passwords.
 */
const DATABASE_CREDENTIAL_VARIABLES = [
  "HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY",
  "HOT_UPDATER_SUPABASE_DB_PASSWORD",
  "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
  "HOT_UPDATER_VERCEL_DATABASE_URL",
  "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
  // The AWS config's credentials reach DynamoDB as well as S3.
  "HOT_UPDATER_S3_ACCESS_KEY_ID",
  "HOT_UPDATER_S3_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDFLARE_API_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "MYSQL_URL",
  "MYSQL_PASSWORD",
  "MONGODB_URI",
  "MONGO_URL",
  "TURSO_AUTH_TOKEN",
] as const;

/** A finding about where the vault's master keys are kept. */
export interface VaultMasterKeyIssue {
  type: "warning";
  code: "VAULT_MASTER_KEY_WITH_DATABASE_CREDENTIALS";
  /** The env file, relative to the project, or `process.env`. */
  source: string;
  /** The master key variables the source sets. */
  masterKeys: string[];
  /** The database credentials it sets beside them. */
  credentials: string[];
  message: string;
  resolution: string;
  fixability: DoctorFixability;
}

const isSet = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
) => (env[name]?.trim().length ?? 0) > 0;

const findIssue = (
  source: string,
  where: string,
  env: Readonly<Record<string, string | undefined>>,
): VaultMasterKeyIssue | null => {
  const masterKeys = MASTER_KEY_VARIABLES.filter((name) => isSet(env, name));
  const credentials = DATABASE_CREDENTIAL_VARIABLES.filter((name) =>
    isSet(env, name),
  );
  if (masterKeys.length === 0 || credentials.length === 0) return null;
  return {
    type: "warning",
    code: "VAULT_MASTER_KEY_WITH_DATABASE_CREDENTIALS",
    source,
    masterKeys,
    credentials,
    message: `${where} holds the vault's master key (${masterKeys.join(", ")}) beside database credentials (${credentials.join(", ")}): whoever reads it opens every secret in the vault.`,
    resolution:
      "Keep the master key only in the Console's runtime environment, apart from the database credentials, and out of CI. Hot Updater does not move secrets for you.",
    fixability: "blocked",
  };
};

/**
 * Warns where the vault's master keys sit in one env source with database
 * credentials: each `.env*` file in the project, then the environment
 * doctor runs in, unless a file it loaded already explains it. Only names
 * are compared; nothing is read from the database or the vault.
 */
export const checkVaultMasterKey = async ({
  cwd,
  env = process.env,
}: {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<VaultMasterKeyIssue[]> => {
  const files = (await readdir(cwd).catch(() => [] as string[]))
    // Examples hold placeholders, not keys.
    .filter(
      (name) =>
        /^\.env(\..+)?$/u.test(name) &&
        !/\.(example|sample|template)$/u.test(name),
    )
    .sort();
  const issues: VaultMasterKeyIssue[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(cwd, file), "utf8");
    } catch {
      // A directory or an unreadable file holds nothing to compare.
      continue;
    }
    const issue = findIssue(file, file, parseEnv(text.replace(/^﻿/u, "")));
    if (issue) issues.push(issue);
  }
  if (issues.length === 0) {
    const issue = findIssue(
      "process.env",
      "The environment doctor runs in",
      env,
    );
    if (issue) issues.push(issue);
  }
  return issues;
};
