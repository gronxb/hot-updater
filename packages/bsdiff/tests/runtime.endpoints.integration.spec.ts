import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { hdiff } from "../src/node.js";
import { readFixtureHbc } from "./test-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

type EndpointExpectation = {
  patch: Uint8Array<ArrayBuffer>;
  patchSize: number;
  patchSha256: string;
};

type RuntimeChild = ChildProcessByStdio<null, Readable, Readable>;

const CLOUDFLARE_ENDPOINT_TIMEOUT_MS = 60_000;

assertCommandAvailable(
  "node",
  ["--version"],
  "Node.js is required to run the runtime endpoint integration tests.",
);
assertCommandAvailable(
  "bun",
  ["--version"],
  "Bun is required to run the runtime endpoint integration tests.",
);
assertCommandAvailable(
  "deno",
  ["--version"],
  "Deno is required to run the runtime endpoint integration tests.",
);
assertCommandAvailable(
  "pnpm",
  ["exec", "wrangler", "--version"],
  "Wrangler is required to run the cloudflare runtime endpoint integration test.",
);

let expected: EndpointExpectation;

beforeAll(async () => {
  ensureBuildArtifacts();

  const [base, next] = await Promise.all([
    readFixtureHbc("one"),
    readFixtureHbc("two"),
  ]);
  const patch = await hdiff(base, next);
  expected = {
    patch,
    patchSize: patch.byteLength,
    patchSha256: await sha256Hex(patch),
  };
});

describe.sequential("runtime endpoint integration", () => {
  it("node endpoint returns valid patch", async () => {
    await assertEndpointRuntime({
      runtime: "node",
      command: "node",
      args: ["tests/runtime/fixtures/node-endpoint.mjs"],
      env: {},
    });
  });

  it("bun endpoint returns valid patch", async () => {
    await assertEndpointRuntime({
      runtime: "bun",
      command: "bun",
      args: ["tests/runtime/fixtures/bun-endpoint.ts"],
      env: {},
    });
  });

  it("deno endpoint returns valid patch", async () => {
    await assertEndpointRuntime({
      runtime: "deno",
      command: "deno",
      args: [
        "run",
        "--allow-read",
        "--allow-net",
        "tests/runtime/fixtures/deno-endpoint.ts",
      ],
      env: {},
    });
  });

  it(
    "cloudflare worker endpoint returns valid patch",
    async () => {
      await assertEndpointRuntime({
        runtime: "cloudflare",
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "dev",
          "--config",
          "tests/runtime/fixtures/wrangler.endpoint.jsonc",
          "--local",
          "--log-level",
          "error",
        ],
        env: {},
      });
    },
    CLOUDFLARE_ENDPOINT_TIMEOUT_MS,
  );
});

type RuntimeCommand = {
  runtime: "node" | "bun" | "deno" | "cloudflare";
  command: string;
  args: string[];
  env: Record<string, string>;
};

async function assertEndpointRuntime(
  commandSpec: RuntimeCommand,
): Promise<void> {
  const port = await findOpenPort();
  const args = [...commandSpec.args, "--port", String(port)];

  const processResult = spawnRuntime({
    command: commandSpec.command,
    args,
    env: commandSpec.env,
  });

  try {
    await waitForHealthy(
      `http://127.0.0.1:${port}/healthz`,
      processResult.child,
      processResult.logs,
    );

    const response = await fetch(`http://127.0.0.1:${port}/demo/patch`);
    expect(
      response.status,
      formatLogs(commandSpec.runtime, processResult.logs),
    ).toBe(200);

    const patch = new Uint8Array(await response.arrayBuffer());
    expect(
      Buffer.from(patch),
      formatLogs(commandSpec.runtime, processResult.logs),
    ).toEqual(Buffer.from(expected.patch));

    expect(response.headers.get("x-hdiff-patch-bytes")).toBe(
      String(expected.patchSize),
    );
    expect(response.headers.get("x-hdiff-patch-sha256")).toBe(
      expected.patchSha256,
    );
  } finally {
    await stopRuntime(processResult.child);
  }
}

function spawnRuntime(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): {
  child: RuntimeChild;
  logs: { stdout: string[]; stderr: string[] };
} {
  const child = spawn(input.command, input.args, {
    cwd: ROOT,
    env: { ...process.env, ...input.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = { stdout: [] as string[], stderr: [] as string[] };

  child.stdout.on("data", (chunk: Buffer) => {
    appendLog(logs.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    appendLog(logs.stderr, chunk.toString("utf8"));
  });

  return { child, logs };
}

function appendLog(store: string[], value: string): void {
  store.push(value);
  if (store.length > 200) {
    store.shift();
  }
}

async function waitForHealthy(
  url: string,
  child: RuntimeChild,
  logs: { stdout: string[]; stderr: string[] },
): Promise<void> {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited early: ${formatLogs("runtime", logs)}`);
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

  throw new Error(
    `runtime health check timed out: ${formatLogs("runtime", logs)}`,
  );
}

async function stopRuntime(child: RuntimeChild): Promise<void> {
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
}

function waitForExit(child: RuntimeChild, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
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
}

function ensureBuildArtifacts(): void {
  const buildResult = spawnSync("pnpm", ["build"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (buildResult.status !== 0) {
    const stdout = buildResult.stdout ?? "";
    const stderr = buildResult.stderr ?? "";
    throw new Error(
      `failed to build artifacts before endpoint tests\n${stdout}\n${stderr}`,
    );
  }
}

function hasCommand(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0;
}

function assertCommandAvailable(
  command: string,
  args: string[],
  message: string,
): void {
  if (hasCommand(command, args)) {
    return;
  }

  throw new Error(message);
}

async function findOpenPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function formatLogs(
  runtime: string,
  logs: { stdout: string[]; stderr: string[] },
): string {
  return [
    `[${runtime}] stdout:`,
    logs.stdout.join("").trim() || "(empty)",
    `[${runtime}] stderr:`,
    logs.stderr.join("").trim() || "(empty)",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
