import { execa } from "execa";

type ComposeServiceState = "absent" | "running" | "stopped";

interface ComposeState {
  readonly service: ComposeServiceState;
  readonly volumeExists: boolean;
}

const compose = (projectRoot: string, args: readonly string[]) =>
  execa("docker", ["compose", ...args], { cwd: projectRoot });

const getComposeProjectName = async (projectRoot: string): Promise<string> => {
  const result = await compose(projectRoot, ["config", "--format", "json"]);
  const config: unknown = JSON.parse(result.stdout);
  if (
    !config ||
    typeof config !== "object" ||
    !("name" in config) ||
    typeof config.name !== "string"
  ) {
    throw new Error("Docker Compose did not report a project name.");
  }
  return config.name;
};

const getComposeState = async (projectRoot: string): Promise<ComposeState> => {
  const [container, projectName] = await Promise.all([
    compose(projectRoot, ["ps", "-a", "-q", "mysql"]),
    getComposeProjectName(projectRoot),
  ]);
  const containerId = container.stdout.trim();
  const volume = await execa("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--filter",
    "label=com.docker.compose.volume=mysql_data",
  ]);
  if (!containerId) {
    return {
      service: "absent",
      volumeExists: volume.stdout.trim().length > 0,
    };
  }

  const running = await execa("docker", [
    "inspect",
    "--format={{.State.Running}}",
    containerId,
  ]);
  return {
    service: running.stdout.trim() === "true" ? "running" : "stopped",
    volumeExists: volume.stdout.trim().length > 0,
  };
};

const waitForMySQLReady = async (
  projectRoot: string,
  maxAttempts: number,
): Promise<void> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const health = await execa(
        "docker",
        ["inspect", "--format={{.State.Health.Status}}", "hono-kysely-mysql"],
        { cwd: projectRoot },
      );
      if (health.stdout.trim() === "healthy") {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("MySQL failed to become ready.");
};

const executeRootSQL = (
  projectRoot: string,
  statement: string,
): Promise<unknown> =>
  compose(projectRoot, [
    "exec",
    "-T",
    "mysql",
    "mysql",
    "-uroot",
    "-phot_updater_root",
    "-e",
    statement,
  ]);

const restoreComposeState = async (
  projectRoot: string,
  state: ComposeState,
): Promise<void> => {
  if (state.service === "running") {
    return;
  }
  if (state.service === "stopped") {
    await compose(projectRoot, ["stop", "mysql"]);
    return;
  }
  await compose(
    projectRoot,
    state.volumeExists ? ["down"] : ["down", "--volumes"],
  );
};

export const restoreAfterMySQLSetupFailure = async (
  setupError: unknown,
  restore: () => Promise<void>,
): Promise<never> => {
  try {
    await restore();
  } catch (cleanupError) {
    throw new AggregateError(
      [setupError, cleanupError],
      "MySQL test setup and cleanup both failed.",
      { cause: setupError },
    );
  }
  throw setupError;
};

export const startMySQLTestDatabase = async (projectRoot: string) => {
  const initialState = await getComposeState(projectRoot);
  const previousDatabaseName = process.env.MYSQL_DATABASE;
  const databaseName = `hot_updater_test_${process.pid}_${Date.now()}`;
  let databaseCreated = false;
  let restored = false;

  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    const errors: unknown[] = [];

    if (databaseCreated) {
      try {
        await executeRootSQL(
          projectRoot,
          `DROP DATABASE IF EXISTS \`${databaseName}\`;`,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (previousDatabaseName === undefined) {
      delete process.env.MYSQL_DATABASE;
    } else {
      process.env.MYSQL_DATABASE = previousDatabaseName;
    }
    try {
      await restoreComposeState(projectRoot, initialState);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "MySQL test cleanup failed.");
    }
  };

  try {
    await compose(projectRoot, ["up", "-d", "--wait"]);
    await waitForMySQLReady(projectRoot, 30);
    await executeRootSQL(
      projectRoot,
      `CREATE DATABASE \`${databaseName}\`; GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO 'hot_updater'@'%';`,
    );
    databaseCreated = true;
    process.env.MYSQL_DATABASE = databaseName;
    return { databaseName, restore };
  } catch (error) {
    return restoreAfterMySQLSetupFailure(error, restore);
  }
};
