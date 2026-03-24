import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";

export type RuntimeChild = ChildProcessByStdio<null, Readable, Readable>;

export interface RuntimeLogs {
  stdout: string[];
  stderr: string[];
}

export interface SpawnRuntimeOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export const runCheckedCommand = ({
  command,
  args,
  cwd,
  env,
}: SpawnRuntimeOptions) => {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
    },
    encoding: "utf8",
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
};

export const hasCommand = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
  });

  return result.status === 0;
};

export const hasDockerDaemon = () => {
  return hasCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
};

export const hasDockerCompose = () => {
  return (
    hasCommand("docker", ["compose", "version", "--short"]) && hasDockerDaemon()
  );
};

export const findOpenPort = async (): Promise<number> => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve an available port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
};

export const spawnRuntime = ({
  command,
  args,
  cwd,
  env,
}: SpawnRuntimeOptions): {
  child: RuntimeChild;
  logs: RuntimeLogs;
} => {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: RuntimeLogs = { stdout: [], stderr: [] };

  child.stdout.on("data", (chunk: Buffer) => {
    appendLog(logs.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    appendLog(logs.stderr, chunk.toString("utf8"));
  });

  return { child, logs };
};

export const waitForHttpOk = async ({
  url,
  child,
  logs,
  timeoutMs = 45_000,
}: {
  url: string;
  child: RuntimeChild;
  logs: RuntimeLogs;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited early: ${formatRuntimeLogs(logs)}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await sleep(200);
  }

  throw new Error(`runtime health check timed out: ${formatRuntimeLogs(logs)}`);
};

export const stopRuntime = async (child: RuntimeChild) => {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await waitForExit(child, 8_000);
  if (exited) {
    return;
  }

  child.kill("SIGKILL");
  await waitForExit(child, 3_000);
};

export const formatRuntimeLogs = (logs: RuntimeLogs) => {
  return [...logs.stdout, ...logs.stderr].join("").trim();
};

const appendLog = (store: string[], value: string) => {
  store.push(value);
  if (store.length > 200) {
    store.shift();
  }
};

const waitForExit = async (child: RuntimeChild, timeoutMs: number) => {
  return await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };

    child.on("exit", onExit);
  });
};

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
