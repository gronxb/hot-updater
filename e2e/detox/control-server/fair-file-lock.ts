import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type FileLockOwner = {
  readonly pid: number;
  readonly platform: string | null;
  readonly startedAt: string;
};

type AbandonedFileLock = {
  readonly ageMs: number;
  readonly lockPath: string;
  readonly owner: FileLockOwner | null;
  readonly reason: "owner-exited" | "stale";
};

type FileLockWait = {
  readonly owner: FileLockOwner | null;
  readonly position: number;
};

type FairFileLockOptions = {
  readonly lockRoot: string;
  readonly onAbandoned?: (lock: AbandonedFileLock) => void;
  readonly onWait?: (wait: FileLockWait) => void;
  readonly ownerLabel?: string;
  readonly signal?: AbortSignal;
  readonly staleMs?: number;
  readonly waitIntervalMs?: number;
};

export type FairFileLock = {
  readonly lockPath: string;
  readonly release: () => Promise<void>;
};

const defaultStaleMs = 45 * 60 * 1000;
const defaultWaitIntervalMs = 500;

function ticketName(): string {
  const wallClock = Date.now().toString().padStart(16, "0");
  const monotonicClock = process.hrtime.bigint().toString().padStart(20, "0");
  return `${wallClock}-${monotonicClock}-${randomUUID()}`;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function parseOwner(value: unknown): FileLockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const pid = Reflect.get(value, "pid");
  const platform = Reflect.get(value, "platform");
  const startedAt = Reflect.get(value, "startedAt");
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    (typeof platform !== "string" && platform !== undefined) ||
    typeof startedAt !== "string"
  ) {
    return null;
  }
  return { pid, platform: platform ?? null, startedAt };
}

async function readOwner(directory: string): Promise<FileLockOwner | null> {
  try {
    const source = await fs.readFile(
      path.join(directory, "owner.json"),
      "utf8",
    );
    const value: unknown = JSON.parse(source);
    return parseOwner(value);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      return null;
    }
    throw error;
  }
}

function isOwnerAlive(owner: FileLockOwner | null): boolean {
  if (!owner) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function abandonedLock(
  lockPath: string,
  staleMs: number,
): Promise<AbandonedFileLock | null> {
  const stats = await fs.stat(lockPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stats) return null;

  const owner = await readOwner(lockPath);
  const ageMs = Date.now() - stats.mtimeMs;
  if (!isOwnerAlive(owner)) {
    return { ageMs, lockPath, owner, reason: "owner-exited" };
  }
  if (ageMs > staleMs) {
    return { ageMs, lockPath, owner, reason: "stale" };
  }
  return null;
}

async function waitForTurn(
  options: FairFileLockOptions,
): Promise<FairFileLock> {
  const lockPath = path.join(options.lockRoot, "deploy.lock");
  const queuePath = path.join(options.lockRoot, "deploy.lock.queue");
  const ticketPath = path.join(queuePath, ticketName());
  const staleMs = options.staleMs ?? defaultStaleMs;
  const waitIntervalMs = options.waitIntervalMs ?? defaultWaitIntervalMs;
  let waitingLogged = false;

  await fs.mkdir(queuePath, { recursive: true });
  await fs.mkdir(ticketPath);
  await fs.writeFile(
    path.join(ticketPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      platform: options.ownerLabel,
      startedAt: new Date().toISOString(),
    }),
  );

  try {
    for (;;) {
      options.signal?.throwIfAborted();
      let tickets = (await fs.readdir(queuePath)).sort();
      for (;;) {
        const head = tickets[0];
        if (!head || head === path.basename(ticketPath)) break;
        const headPath = path.join(queuePath, head);
        const abandoned = await abandonedLock(headPath, staleMs);
        if (!abandoned) break;
        options.onAbandoned?.(abandoned);
        await fs.rm(headPath, { force: true, recursive: true });
        tickets = (await fs.readdir(queuePath)).sort();
      }
      const position = tickets.indexOf(path.basename(ticketPath));
      const owner = await readOwner(lockPath);

      if (position === 0) {
        try {
          await fs.mkdir(lockPath);
          try {
            await fs.writeFile(
              path.join(lockPath, "owner.json"),
              JSON.stringify({
                pid: process.pid,
                platform: options.ownerLabel,
                startedAt: new Date().toISOString(),
              }),
            );
          } catch (error) {
            await fs.rm(lockPath, { force: true, recursive: true });
            throw error;
          }
          await fs.rm(ticketPath, { force: true, recursive: true });
          return {
            lockPath,
            release: () => fs.rm(lockPath, { force: true, recursive: true }),
          };
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const abandoned = await abandonedLock(lockPath, staleMs);
          if (abandoned) {
            options.onAbandoned?.(abandoned);
            await fs.rm(lockPath, { force: true, recursive: true });
            waitingLogged = false;
            continue;
          }
        }
      }

      if (!waitingLogged) {
        options.onWait?.({ owner, position });
        waitingLogged = true;
      }
      await sleep(waitIntervalMs, undefined, { signal: options.signal });
    }
  } catch (error) {
    await fs.rm(ticketPath, { force: true, recursive: true });
    throw error;
  }
}

export async function acquireFairFileLock(
  options: FairFileLockOptions,
): Promise<FairFileLock> {
  await fs.mkdir(options.lockRoot, { recursive: true });
  return waitForTurn(options);
}
