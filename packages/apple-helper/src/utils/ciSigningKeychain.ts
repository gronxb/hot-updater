import { spawnSync } from "child_process";
import crypto from "crypto";
import fs, { readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";

import {
  type Credentials,
  p,
  registerSecretValue,
} from "@hot-updater/cli-tools";
import { execa } from "execa";

import { createAppStoreConnectToken } from "../uploadToTestFlight";

const API_URL = "https://api.appstoreconnect.apple.com";
const CERTIFICATES_URL =
  "https://developer.apple.com/account/resources/certificates/list";

/** Long enough for any build: the keychain never locks while one runs. */
const KEYCHAIN_TIMEOUT_SECONDS = 6 * 60 * 60;

/** Runs `security` with `args` and returns its standard output. */
export type RunSecurity = (args: readonly string[]) => Promise<string>;

const runSecurity: RunSecurity = async (args) =>
  (await execa("security", args)).stdout;

/** The keychain paths `security` prints, one quoted path per line. */
const parseKeychains = (stdout: string): string[] =>
  [...stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

/** A certificate Xcode created in the build's keychain. */
export interface KeychainCertificate {
  /** Uppercase hex without leading zeros, as App Store Connect lists it. */
  readonly serialNumber: string;
  readonly commonName: string;
}

const normalizeSerial = (serial: string) =>
  serial.toUpperCase().replace(/^0+(?=.)/, "");

/**
 * A keychain only this build uses: Xcode stores the private key of each
 * signing certificate it creates in the default keychain, which on a CI
 * runner is locked, shared, or kept across jobs. Its random password exists
 * only in this process; `security create-keychain` and `unlock-keychain`
 * take it on their command line, as GitHub's guide for macOS runners does,
 * since the keychain is deleted when the build ends.
 */
export interface SigningKeychain {
  readonly path: string;
  /** The certificates in the keychain: those Xcode created while building. */
  certificates(): Promise<KeychainCertificate[]>;
  /**
   * Restores the default keychain and the search list the build found, and
   * deletes the keychain with every private key in it.
   */
  dispose(): Promise<void>;
}

/** The keychain whose state the process restores if it exits first. */
let live: { restore: () => void } | undefined;

/**
 * Where builds under one macOS user take turns: the default keychain and the
 * search list are the user's, not a process's, so two builds that overlap,
 * such as two self-hosted runner instances, would each restore the other's
 * keychain. It is in the user's caches, whatever TMPDIR a runner sets.
 */
const defaultLockPath = () =>
  path.join(
    os.homedir(),
    "Library",
    "Caches",
    "hot-updater",
    "signing-keychain.lock",
  );

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readHolder = async (file: string) =>
  Number((await fs.promises.readFile(file, "utf-8").catch(() => "")).trim());

/**
 * Takes the user's signing keychain lock, holding the process's ID, and
 * waits while a running build holds it. A lock whose build is gone, such as
 * one killed outright, is taken over: it is moved aside first, so of two
 * builds that find it only one removes it, and a lock another build took
 * meanwhile is put back.
 */
const acquireLock = async (lockPath: string, pollMs: number) => {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  let announced = false;
  // The lock appears whole, holding its owner: the ID is written to a file
  // of this process's own, which is then linked into place, and a link
  // fails while any lock exists.
  const claim = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  await fs.promises.writeFile(claim, String(process.pid));
  try {
    for (;;) {
      try {
        await fs.promises.link(claim, lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readHolder(lockPath);
      if (!Number.isInteger(holder) || holder <= 0 || !isAlive(holder)) {
        const aside = `${lockPath}.${process.pid}.stale`;
        if (
          await fs.promises.rename(lockPath, aside).then(
            () => true,
            () => false,
          )
        ) {
          const moved = await readHolder(aside);
          if (moved !== holder && Number.isInteger(moved) && isAlive(moved)) {
            await fs.promises.link(aside, lockPath).catch(() => undefined);
          }
          await fs.promises.rm(aside, { force: true });
        }
        continue;
      }
      if (!announced) {
        p.log.info(
          `Waiting for another build (process ${holder}) that signs in a keychain of its own under this macOS user.`,
        );
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    await fs.promises.rm(claim, { force: true });
  }
};

/** Removes the lock, if this process still holds it. */
const releaseLockSync = (lockPath: string) => {
  try {
    if (Number(readFileSync(lockPath, "utf-8").trim()) === process.pid) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone.
  }
};

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

// An `exit` listener must be synchronous, and Node exits on a termination
// signal without emitting `exit`, so both are listened to.
const restoreLive = () => {
  live?.restore();
  live = undefined;
  process.off("exit", restoreLive);
  for (const signal of TERMINATION_SIGNALS) process.off(signal, onSignal);
};

const onSignal = (signal: NodeJS.Signals) => {
  restoreLive();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
};

/**
 * Creates the build's keychain and makes it the user's default keychain,
 * first in the search list, ahead of the keychains already there, so Xcode
 * still finds a signing identity a self-hosted runner keeps and creates a
 * new one only when it has none.
 */
export const createSigningKeychain = async ({
  security = runSecurity,
  directory = os.tmpdir(),
  lockPath = defaultLockPath(),
  pollMs = 2_000,
}: {
  security?: RunSecurity;
  directory?: string;
  /** The per-user lock builds take turns with. */
  lockPath?: string;
  /** How often a build waiting for the lock checks it. */
  pollMs?: number;
} = {}): Promise<SigningKeychain> => {
  if (live) {
    throw new Error("A signing keychain is already in use by this process.");
  }
  // Held from before the snapshot until the keychains are restored.
  live = { restore: () => releaseLockSync(lockPath) };
  try {
    await acquireLock(lockPath, pollMs);
  } catch (error) {
    live = undefined;
    throw error;
  }
  process.on("exit", restoreLive);
  for (const signal of TERMINATION_SIGNALS) process.on(signal, onSignal);

  let originalDefault: string | undefined;
  let originalSearchList: string[];
  try {
    // A user without a default keychain gets none back afterwards.
    [originalDefault] = parseKeychains(
      await security(["default-keychain", "-d", "user"]).catch(() => ""),
    );
    originalSearchList = parseKeychains(
      await security(["list-keychains", "-d", "user"]),
    );
  } catch (error) {
    restoreLive();
    throw error;
  }
  const keychainPath = path.join(
    directory,
    `hot-updater-${crypto.randomBytes(6).toString("hex")}.keychain-db`,
  );
  const password = crypto.randomBytes(24).toString("base64url");
  registerSecretValue(password);

  const restoreArgs = [
    ...(originalDefault
      ? [["default-keychain", "-d", "user", "-s", originalDefault]]
      : []),
    ["list-keychains", "-d", "user", "-s", ...originalSearchList],
    ["delete-keychain", keychainPath],
  ];
  live = {
    restore: () => {
      for (const args of restoreArgs) spawnSync("security", args);
      releaseLockSync(lockPath);
    },
  };

  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= (async () => {
      const failures: string[] = [];
      for (const args of restoreArgs) {
        await security(args).catch((error: unknown) => {
          failures.push(
            `security ${args[0]}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      releaseLockSync(lockPath);
      live = undefined;
      process.off("exit", restoreLive);
      for (const signal of TERMINATION_SIGNALS) process.off(signal, onSignal);
      if (failures.length > 0) {
        p.log.warn(
          `Restoring the keychains after the build failed (${failures.join("; ")}). Check \`security list-keychains -d user\` and \`security default-keychain -d user\`, and delete ${keychainPath} if it is left.`,
        );
      }
    })();
    return disposal;
  };

  try {
    await security(["create-keychain", "-p", password, keychainPath]);
    await security([
      "set-keychain-settings",
      "-lut",
      String(KEYCHAIN_TIMEOUT_SECONDS),
      keychainPath,
    ]);
    await security(["unlock-keychain", "-p", password, keychainPath]);
    await security([
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychainPath,
      ...originalSearchList.filter((keychain) => keychain !== keychainPath),
    ]);
    await security(["default-keychain", "-d", "user", "-s", keychainPath]);
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    path: keychainPath,
    certificates: async () => {
      const pems =
        (await security(["find-certificate", "-a", "-p", keychainPath])).match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        ) ?? [];
      return pems.map((pem) => {
        const certificate = new crypto.X509Certificate(pem);
        return {
          serialNumber: normalizeSerial(certificate.serialNumber),
          commonName:
            certificate.subject.match(/^CN=(.*)$/m)?.[1] ?? certificate.subject,
        };
      });
    },
    dispose,
  };
};

/**
 * Revokes the certificates Xcode created in the build's keychain, whose
 * private keys the keychain's deletion destroys: on a runner that starts
 * empty, Xcode creates a development certificate for every build, and App
 * Store Connect refuses new ones once a team has its maximum. Each is found
 * in the team's certificates by serial number. A revocation that fails is
 * reported with where to revoke it by hand, and never fails the build.
 */
export const revokeKeychainCertificates = async ({
  certificates,
  apiKey,
  fetch = globalThis.fetch,
}: {
  certificates: readonly KeychainCertificate[];
  apiKey: Credentials["asc-api-key"];
  fetch?: typeof globalThis.fetch;
}): Promise<{ revoked: string[]; failed: string[] }> => {
  const revoked: string[] = [];
  const failed: string[] = [];
  if (certificates.length === 0) return { revoked, failed };

  const describe = ({ commonName, serialNumber }: KeychainCertificate) =>
    `${commonName} (serial ${serialNumber})`;
  try {
    const token = createAppStoreConnectToken({
      privateKey: crypto.createPrivateKey(
        await fs.promises.readFile(apiKey.keyPath, "utf-8"),
      ),
      keyId: apiKey.keyId,
      issuerId: apiKey.issuerId,
    });
    registerSecretValue(token);
    const headers = { Authorization: `Bearer ${token}` };

    const idsBySerial = new Map<string, string>();
    let next: string | undefined =
      `${API_URL}/v1/certificates?${new URLSearchParams({
        "fields[certificates]": "serialNumber",
        limit: "200",
      })}`;
    while (next) {
      const response = await fetch(next, { headers });
      if (!response.ok) {
        throw new Error(
          `Listing the team's certificates failed (HTTP ${response.status}).`,
        );
      }
      const body = (await response.json()) as {
        data?: { id: string; attributes?: { serialNumber?: string } }[];
        links?: { next?: string };
      };
      for (const { id, attributes } of body.data ?? []) {
        if (attributes?.serialNumber) {
          idsBySerial.set(normalizeSerial(attributes.serialNumber), id);
        }
      }
      next = body.links?.next;
    }

    for (const certificate of certificates) {
      const id = idsBySerial.get(certificate.serialNumber);
      if (id === undefined) {
        // Not the team's: nothing App Store Connect counts.
        continue;
      }
      const response = await fetch(`${API_URL}/v1/certificates/${id}`, {
        method: "DELETE",
        headers,
      });
      if (response.ok || response.status === 404) {
        revoked.push(describe(certificate));
      } else {
        failed.push(`${describe(certificate)}: HTTP ${response.status}`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const certificate of certificates) {
      if (!revoked.includes(describe(certificate))) {
        failed.push(`${describe(certificate)}: ${reason}`);
      }
    }
  }

  if (revoked.length > 0) {
    p.log.info(
      `Revoked the signing certificates Xcode created for this build, whose keys the build's keychain held: ${revoked.join(", ")}.`,
    );
  }
  if (failed.length > 0) {
    p.log.warn(
      `Revoking the signing certificates Xcode created for this build failed, and their keys are deleted with the build's keychain: ${failed.join("; ")}. Revoke them at ${CERTIFICATES_URL}, since App Store Connect stops creating certificates at a team's maximum.`,
    );
  }
  return { revoked, failed };
};

/**
 * Runs `run`, the archive and export of a build that signs with an App
 * Store Connect API key, in a keychain of its own when `enabled` (in CI),
 * then revokes the certificates Xcode created in it and deletes it.
 */
export const withSigningKeychain = async <T>({
  enabled,
  apiKey,
  run,
  security,
  lockPath,
  fetch,
}: {
  enabled: boolean;
  apiKey: Credentials["asc-api-key"];
  run: () => Promise<T>;
  security?: RunSecurity;
  lockPath?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<T> => {
  if (!enabled) return run();
  const keychain = await createSigningKeychain({ security, lockPath });
  p.log.info(
    "Signing in a keychain of this build's own, deleted when it ends (CI is set).",
  );
  try {
    return await run();
  } finally {
    const certificates = await keychain.certificates().catch(() => []);
    await keychain.dispose();
    await revokeKeychainCertificates({ certificates, apiKey, fetch });
  }
};
