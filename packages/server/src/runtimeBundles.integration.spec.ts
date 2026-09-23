import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HOT_UPDATER_SERVER_VERSION } from "./version";

/** Runs the built bundle from `tests/runtime`, with `plugins: []` and no Node APIs. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [command, ...args] of [
  ["deno", "--version"],
  ["pnpm", "exec", "wrangler", "--version"],
]) {
  if (spawnSync(command!, args, { cwd: root, stdio: "ignore" }).status !== 0) {
    throw new Error(
      `${command === "pnpm" ? "wrangler" : command} is required for the server runtime bundle tests.`,
    );
  }
}

const openPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

let running: ChildProcess | undefined;

const serve = async (command: string, args: readonly string[]) => {
  const port = await openPort();
  const child = spawn(command, [...args, "--port", String(port)], {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running = child;
  const logs: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  for (
    let attempt = 0;
    attempt < 120 && child.exitCode === null;
    attempt += 1
  ) {
    const ready = await fetch(`${url}/version`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${command} never served /version:\n${logs.join("")}`);
};

describe.sequential("server bundle with plugins: []", () => {
  afterEach(() => {
    if (running?.pid !== undefined && running.exitCode === null) {
      process.kill(-running.pid, "SIGTERM");
    }
    running = undefined;
  });

  it.each([
    [
      "Deno",
      "deno",
      [
        "run",
        "--allow-read",
        "--allow-net",
        "--allow-env",
        "tests/runtime/deno-server.mjs",
      ],
    ],
    [
      "workerd",
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        "tests/runtime/wrangler.runtime.jsonc",
        "--local",
        "--log-level",
        "error",
      ],
    ],
  ] as const)(
    "serves client routes on %s",
    async (_runtime, command, args) => {
      const url = await serve(command, args);
      const version = await fetch(`${url}/version`);
      await expect(version.json()).resolves.toEqual({
        adminProtocol: 2,
        infrastructureGeneration: 1,
        version: HOT_UPDATER_SERVER_VERSION,
      });
      expect((await fetch(`${url}/not-a-route`)).status).toBe(404);
    },
    120_000,
  );
});
