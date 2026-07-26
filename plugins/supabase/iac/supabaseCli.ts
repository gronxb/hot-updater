import fs from "fs/promises";
import path from "path";

import {
  p,
  SUPABASE_INIT_PROVIDER,
  transformTemplate,
} from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

const SUPABASE_CONFIG_TEMPLATE = `
project_id = "%%projectId%%"

[db.seed]
enabled = false
`;
const SUPABASE_DATABASE_CONNECTION_ERROR =
  "Supabase database connection failed. Check your database password and project access.";

// Supabase CLI/Postgres auth messages observed for bad database passwords.
const SUPABASE_DATABASE_AUTH_ERROR_PATTERNS = [
  /failed SASL auth/i,
  /password authentication failed/i,
  /SQLSTATE 28P01/i,
  /invalid SCRAM server-final-message/i,
] as const;

const isSupabaseDatabaseAuthError = (err: ExecaError) => {
  const stderr = err.stderr;
  return (
    typeof stderr === "string" &&
    SUPABASE_DATABASE_AUTH_ERROR_PATTERNS.some((pattern) =>
      pattern.test(stderr),
    )
  );
};

const handleSupabaseDatabaseCommandError = (
  err: unknown,
  {
    dbPassword,
    stderrInherited = false,
  }: {
    dbPassword?: string;
    stderrInherited?: boolean;
  },
) => {
  if (err instanceof ExecaError) {
    if (dbPassword && isSupabaseDatabaseAuthError(err)) {
      p.log.error(SUPABASE_DATABASE_CONNECTION_ERROR);
    } else if (!stderrInherited && err.stderr) {
      p.log.error(err.stderr);
    } else {
      p.log.error(err.message);
    }
  } else {
    console.error(err);
  }

  process.exit(1);
};

export const linkSupabase = async (
  workdir: string,
  {
    accessToken,
    projectId,
    dbPassword,
  }: {
    accessToken: string;
    projectId: string;
    dbPassword?: string;
  },
) => {
  const spinner = p.spinner();

  try {
    await fs.writeFile(
      path.join(workdir, "supabase", "config.toml"),
      transformTemplate(SUPABASE_CONFIG_TEMPLATE, {
        projectId,
      }),
    );

    spinner.start("Linking Supabase...");

    await execa(
      "npx",
      ["supabase", "link", "--project-ref", projectId, "--workdir", workdir],
      {
        cwd: workdir,
        env: {
          [SUPABASE_INIT_PROVIDER.inputs.accessToken.envKey]: accessToken,
          ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
        },
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    spinner.stop("Supabase linked ✔");
  } catch (err) {
    spinner.stop();
    handleSupabaseDatabaseCommandError(
      err instanceof Error ? err : new Error(String(err)),
      { dbPassword },
    );
  }
};

export const pushDB = async (
  workdir: string,
  { accessToken, dbPassword }: { accessToken: string; dbPassword?: string },
) => {
  try {
    const dbPush = await execa(
      "npx",
      ["supabase", "db", "push", "--include-all"],
      {
        cwd: workdir,
        env: {
          [SUPABASE_INIT_PROVIDER.inputs.accessToken.envKey]: accessToken,
          ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
        },
        stderr: ["pipe", "inherit"],
        stdin: "inherit",
        stdout: "inherit",
      },
    );
    p.log.success("DB pushed ✔");
    return dbPush.stdout;
  } catch (err) {
    handleSupabaseDatabaseCommandError(
      err instanceof Error ? err : new Error(String(err)),
      {
        dbPassword,
        stderrInherited: true,
      },
    );
  }
};
