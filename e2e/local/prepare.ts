import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createNativeBuildPlan } from "../mobile/build.ts";
import { runMobile } from "../mobile/run.ts";
import type { MobileRuntime } from "../mobile/target.ts";
import { publishedBin } from "../shared/published.ts";
import {
  localMutableFiles,
  lynxLocalMutableFiles,
  preserveFiles,
} from "./files.ts";
import {
  createLocalProfile,
  localAppConfig,
  localEnvFile,
  selectDevice,
  siloImage,
  type LocalPlatform,
  type LocalProfile,
} from "./profile.ts";

function stopGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function localCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    capture?: boolean;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let output = "";
  let diagnostic = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    diagnostic = (diagnostic + String(chunk)).slice(-8_192);
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    stopGroup(child, "SIGTERM");
    killTimer = setTimeout(() => stopGroup(child, "SIGKILL"), 5_000);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              `${command} failed (${code ?? signal}). ${diagnostic.trim()}`,
            ),
          );
      });
    });
    return output;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(killTimer);
    if (options.signal?.aborted) stopGroup(child, "SIGKILL");
  }
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHttp(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      if (response.ok) return;
    } catch {
      signal.throwIfAborted();
    }
    await sleep(250, undefined, { signal });
  }
  throw new Error(`Local E2E service did not become ready: ${url}`);
}

async function createBucket(profile: LocalProfile, signal: AbortSignal) {
  const appRequire = createRequire(path.join(profile.appDir, "package.json"));
  const awsRequire = createRequire(
    appRequire.resolve("@hot-updater/aws/package.json"),
  );
  // Use the same installed SDK as the real storage adapter; no AWS CLI or
  // cloud account is needed to create this run's local bucket.
  const { S3Client, CreateBucketCommand } = awsRequire("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: profile.env.AWS_S3_ENDPOINT,
    region: profile.env.AWS_REGION,
    credentials: {
      accessKeyId: profile.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: profile.env.AWS_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
  });
  try {
    await client.send(
      new CreateBucketCommand({ Bucket: profile.env.AWS_S3_METADATA_BUCKET }),
      { abortSignal: signal },
    );
  } finally {
    client.destroy();
  }
}

async function startProvider(profile: LocalProfile, signal: AbortSignal) {
  const readiness = new AbortController();
  const log = await fs.open(
    path.join(profile.runDir, "provider.log"),
    "w",
    0o600,
  );
  const server = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: profile.serverDir,
    env: profile.env,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  const exited = new Promise<void>((resolve) => {
    server.once("error", () => resolve());
    server.once("exit", () => resolve());
  });
  const stop = async () => {
    stopGroup(server, "SIGTERM");
    const timer = setTimeout(() => stopGroup(server, "SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      stopGroup(server, "SIGKILL");
      await log.close();
    }
  };
  try {
    await Promise.race([
      waitForHttp(
        `http://127.0.0.1:${profile.providerPort}/hot-updater/admin/version`,
        AbortSignal.any([signal, readiness.signal]),
        {
          Authorization: `Bearer ${profile.env.HOT_UPDATER_ADMIN_TOKEN!}`,
        },
      ),
      exited.then(() => {
        throw new Error(
          `Local provider exited; see ${path.join(profile.runDir, "provider.log")}`,
        );
      }),
    ]);
    return stop;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    readiness.abort();
  }
}

export async function runLocal(
  argv: readonly string[],
  root: string,
  platform: LocalPlatform,
  requestedDevice: string | undefined,
  env: NodeJS.ProcessEnv,
  runtime: MobileRuntime = "react-native",
): Promise<number> {
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new Error("Local E2E interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const signal = cancellation.signal;
  const command = (
    name: string,
    args: readonly string[],
    cwd = root,
    commandEnv = env,
    capture = false,
  ) => localCommand(name, args, { cwd, env: commandEnv, signal, capture });
  const runRoot = path.join(root, "e2e/results/local");
  let releaseLock: (() => Promise<void>) | undefined;
  let restoreFiles: (() => Promise<void>) | undefined;
  let stopProvider: (() => Promise<void>) | undefined;
  let profile: LocalProfile | undefined;
  let id: string | undefined;
  let result = 1;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const devices = await command(
      platform === "ios" ? "xcrun" : "adb",
      platform === "ios"
        ? ["simctl", "list", "devices", "available", "--json"]
        : ["devices", "-l"],
      root,
      env,
      true,
    );
    const device = selectDevice(platform, devices, requestedDevice);
    await command(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      root,
      env,
      true,
    );
    if (platform === "ios") {
      await command("xcodebuild", ["-version"], root, env, true);
      await command("bundle", ["--version"], root, env, true);
    } else await command("java", ["-version"], root, env, true);

    await fs.mkdir(runRoot, { recursive: true });
    const lock = path.join(runRoot, "checkout.lock");
    try {
      await fs.mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(
        `Another local E2E run owns this checkout (${lock}). Wait for it to finish; inspect a stale lock before removing it.`,
      );
    }
    releaseLock = () => fs.rm(lock, { recursive: true });
    id = randomUUID().replaceAll("-", "");
    const runDir = path.join(runRoot, id);
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, device, runDir }),
    );
    await fs.mkdir(runDir, { mode: 0o700 });
    const ports = new Set<number>();
    while (ports.size < 3) ports.add(await reservePort());
    const [providerPort, controlPort, storagePort] = [...ports] as [
      number,
      number,
      number,
    ];
    profile = createLocalProfile({
      root,
      platform,
      runtime,
      runDir,
      id,
      providerPort,
      controlPort,
      storagePort,
      token: randomBytes(24).toString("hex"),
      storagePassword: randomBytes(24).toString("hex"),
      env,
    });
    console.log(`Local E2E: ${platform} ${device}; results: ${runDir}`);
    await command("pnpm", ["-w", "build"]);
    const cli = publishedBin("hot-updater");
    restoreFiles = await preserveFiles(
      profile.appDir,
      runtime === "lynx" ? lynxLocalMutableFiles : localMutableFiles,
      path.join(runDir, "originals"),
    );
    await fs.rm(path.join(profile.appDir, ".env.hotupdater"), { force: true });
    await fs.writeFile(
      path.join(profile.appDir, ".env.hotupdater"),
      localEnvFile(profile.env),
      { mode: 0o600 },
    );
    await fs.chmod(path.join(profile.appDir, ".env.hotupdater"), 0o600);
    const config = path.join(profile.appDir, "hot-updater.config.ts");
    if (runtime === "react-native")
      await fs.writeFile(config, localAppConfig("fingerprint"));
    const cliCommand = (args: string[], cwd = profile!.appDir) =>
      command(process.execPath, [cli, ...args], cwd, profile!.env);
    const keyDir = path.join(runDir, "keys");
    await cliCommand(["keys", "generate", "--output", keyDir]);
    await fs.mkdir(path.join(profile.appDir, "keys"), { recursive: true });
    for (const key of ["private-key.pem", "public-key.pem"]) {
      await fs.rm(path.join(profile.appDir, "keys", key), { force: true });
      await fs.copyFile(
        path.join(keyDir, key),
        path.join(profile.appDir, "keys", key),
      );
    }
    await fs.chmod(path.join(profile.appDir, "keys/private-key.pem"), 0o600);
    await cliCommand(["keys", "export-public", "--yes"]);
    const builds = createNativeBuildPlan(
      { platform, runtime, deviceId: device, dryRun: false },
      root,
      profile.env,
    );
    const runBuild = (build: (typeof builds)[number]) =>
      command(build.command, build.args, build.cwd, {
        ...profile!.env,
        ...build.env,
      });
    // Pods update native inputs. Fingerprint only after dependencies and the
    // signing key have reached their final state, before compiling the binary.
    for (const build of builds.filter((build) => build.command === "bundle"))
      await runBuild(build);
    if (runtime === "react-native") {
      await cliCommand(["fingerprint", "create"]);
      await fs.writeFile(config, localAppConfig("appVersion"));
    }
    // Lynx's builder binds the artifact to committed source and fingerprint,
    // allowing only exact public-key injection. Keep its checked-in contract.
    for (const build of builds.filter((build) => build.command !== "bundle"))
      await runBuild(build);

    const image = siloImage(
      await fs.readFile(
        path.join(root, "examples-server/hono-dynamodb/docker-compose.yml"),
        "utf8",
      ),
    );
    await command(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        profile.containerName,
        "--label",
        `hot-updater-e2e-run=${id}`,
        "--publish",
        `127.0.0.1:${storagePort}:9000`,
        "--env",
        "MINIO_ROOT_USER",
        "--env",
        "MINIO_ROOT_PASSWORD",
        image,
        "server",
        "/data",
      ],
      root,
      {
        ...profile.env,
        MINIO_ROOT_USER: profile.env.AWS_ACCESS_KEY_ID,
        MINIO_ROOT_PASSWORD: profile.env.AWS_SECRET_ACCESS_KEY,
      },
      true,
    );
    await waitForHttp(
      `http://127.0.0.1:${storagePort}/minio/health/ready`,
      signal,
    );
    await createBucket(profile, signal);
    await cliCommand(
      ["db", "migrate", "src/db.ts", "--yes"],
      profile.serverDir,
    );
    stopProvider = await startProvider(profile, signal);
    signal.throwIfAborted();
    const mobileArgs = [...argv];
    if (!mobileArgs.includes("--device")) mobileArgs.push("--device", device);
    if (!mobileArgs.includes("--profile"))
      mobileArgs.push("--profile", "standalone-kysely");
    if (!mobileArgs.includes("--results-dir"))
      mobileArgs.push("--results-dir", path.join(runDir, "results"));
    result = await runMobile(mobileArgs, profile.env);
  } catch (error) {
    failure = error;
  } finally {
    if (stopProvider)
      await stopProvider().catch((error: unknown) => cleanupErrors.push(error));
    if (profile && id) {
      const cleanup = (args: string[]) =>
        localCommand("docker", args, {
          cwd: root,
          env,
          capture: true,
          signal: AbortSignal.timeout(30_000),
        });
      try {
        const owner = await cleanup([
          "inspect",
          "--format",
          '{{index .Config.Labels "hot-updater-e2e-run"}}',
          profile.containerName,
        ]);
        if (owner.trim() === id)
          await cleanup(["rm", "--force", profile.containerName]);
      } catch (error) {
        // A failure before docker run has no container to clean up.
        if (
          !(error instanceof Error) ||
          !/No such (object|container)/i.test(error.message)
        )
          cleanupErrors.push(error);
      }
    }
    if (restoreFiles)
      await restoreFiles().catch((error: unknown) => cleanupErrors.push(error));
    if (releaseLock && cleanupErrors.length === 0)
      await releaseLock().catch((error: unknown) => cleanupErrors.push(error));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (cleanupErrors.length) {
    const errors =
      failure === undefined ? cleanupErrors : [failure, ...cleanupErrors];
    throw new AggregateError(
      errors,
      [
        "Local E2E cleanup failed; the checkout lease is retained.",
        ...errors.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      ].join("\n"),
    );
  }
  if (failure !== undefined) throw failure;
  return result;
}
