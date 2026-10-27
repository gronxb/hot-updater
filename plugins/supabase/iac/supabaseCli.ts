import fs from "fs/promises";
import path from "path";

import { p, transformTemplate } from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { getSupabaseCliEnv } from "./supabaseAuthentication";

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

const getSupabaseCommandEnv = (
  accessToken?: string,
  dbPassword?: string,
): Readonly<Record<string, string>> | undefined =>
  accessToken || dbPassword
    ? {
        ...getSupabaseCliEnv(accessToken),
        ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
      }
    : undefined;

const isSupabaseDatabaseAuthError = (err: ExecaError) => {
  const stderr = err.stderr;
  return (
    typeof stderr === "string" &&
    SUPABASE_DATABASE_AUTH_ERROR_PATTERNS.some((pattern) =>
      pattern.test(stderr),
    )
  );
};

/** What a failed database command reports: a bad password, or the CLI's output. */
const supabaseDatabaseCommandErrorMessage = (
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
      return SUPABASE_DATABASE_CONNECTION_ERROR;
    }
    if (!stderrInherited && err.stderr) return err.stderr;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

const handleSupabaseDatabaseCommandError = (
  err: unknown,
  options: {
    dbPassword?: string;
    stderrInherited?: boolean;
  },
) => {
  if (err instanceof ExecaError) {
    p.log.error(supabaseDatabaseCommandErrorMessage(err, options));
  } else {
    console.error(err);
  }

  process.exit(1);
};

export const confirmSupabaseDatabaseMigrations = async ({
  nonInteractive,
}: {
  readonly nonInteractive: boolean;
}) => {
  if (nonInteractive) {
    return true;
  }

  const confirmed = await p.confirm({
    message:
      "Apply Hot Updater database migrations to the selected Supabase project?",
    initialValue: true,
  });
  return confirmed === true;
};

const runSupabaseLink = async (
  workdir: string,
  {
    accessToken,
    projectId,
    dbPassword,
  }: {
    accessToken?: string;
    projectId: string;
    dbPassword?: string;
  },
) => {
  await fs.writeFile(
    path.join(workdir, "supabase", "config.toml"),
    transformTemplate(SUPABASE_CONFIG_TEMPLATE, {
      projectId,
    }),
  );
  await execa(
    "npx",
    ["supabase", "link", "--project-ref", projectId, "--workdir", workdir],
    {
      cwd: workdir,
      env: getSupabaseCommandEnv(accessToken, dbPassword),
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
};

export const linkSupabase = async (
  workdir: string,
  options: {
    accessToken?: string;
    projectId: string;
    dbPassword?: string;
  },
) => {
  const spinner = p.spinner();

  try {
    spinner.start("Linking Supabase...");
    await runSupabaseLink(workdir, options);
    spinner.stop("Supabase linked ✔");
  } catch (err) {
    spinner.stop();
    handleSupabaseDatabaseCommandError(
      err instanceof Error ? err : new Error(String(err)),
      { dbPassword: options.dbPassword },
    );
  }
};

/** Pushes the workdir's migrations the linked project has not run, after its own history. */
const runSupabasePush = async (
  workdir: string,
  {
    accessToken,
    dbPassword,
    quiet = false,
  }: {
    accessToken?: string;
    dbPassword?: string;
    /** Keeps the CLI's output off stdout, which `doctor --json` writes. */
    quiet?: boolean;
  },
) => {
  await execa(
    "npx",
    [
      "supabase",
      "migration",
      "fetch",
      "--linked",
      "--yes",
      "--workdir",
      workdir,
    ],
    {
      cwd: workdir,
      env: getSupabaseCommandEnv(accessToken, dbPassword),
    },
  ).catch((error: unknown) => {
    // A fresh project has no migration history table until its first db push.
    if (
      error instanceof ExecaError &&
      [error.stderr, error.stdout].some(
        (output) =>
          typeof output === "string" &&
          /relation \\?"supabase_migrations\.schema_migrations\\?" does not exist/.test(
            output,
          ),
      )
    ) {
      return;
    }
    throw error;
  });
  return execa(
    "npx",
    ["supabase", "db", "push", "--include-all", "--yes", "--workdir", workdir],
    {
      cwd: workdir,
      env: getSupabaseCommandEnv(accessToken, dbPassword),
      ...(quiet
        ? { input: "" }
        : {
            stderr: ["pipe", "inherit"] as const,
            stdin: "inherit" as const,
            stdout: "inherit" as const,
          }),
    },
  );
};

export const pushDB = async (
  workdir: string,
  options: { accessToken?: string; dbPassword?: string },
) => {
  try {
    const dbPush = await runSupabasePush(workdir, options);
    p.log.success("DB pushed ✔");
    return dbPush.stdout;
  } catch (err) {
    handleSupabaseDatabaseCommandError(
      err instanceof Error ? err : new Error(String(err)),
      {
        dbPassword: options.dbPassword,
        stderrInherited: true,
      },
    );
  }
};
