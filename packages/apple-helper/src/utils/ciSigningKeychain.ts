import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  type Credentials,
  p,
  registerSecretValue,
} from "@hot-updater/cli-tools";
import { execa } from "execa";

import {
  isProgramLicenseAgreementError,
  PROGRAM_LICENSE_AGREEMENT_HINT,
} from "../asc/programLicenseAgreement";
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

/** A signing certificate Xcode created in the build's keychain. */
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
  /**
   * The signing identities in the keychain, the certificates Xcode created
   * while building, each with its private key there. The CA certificates
   * Xcode imports beside them have no private key, and are not listed.
   */
  certificates(): Promise<KeychainCertificate[]>;
  /**
   * Restores the default keychain and the search list the build found, and
   * deletes the keychain with every private key in it.
   */
  dispose(): Promise<void>;
}

/** The keychain whose state the process restores if it exits first. */
let live: { restore: () => void } | undefined;

// An `exit` listener must be synchronous: it restores the keychains when the
// process exits before the build disposes them. A termination signal is
// handled by `withSigningKeychain`, which revokes before it restores.
const restoreLive = () => {
  live?.restore();
  live = undefined;
  process.off("exit", restoreLive);
};

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

/** Takes the lock at a path, waiting while another holder has it, and returns its release. */
export type AcquireLock = (lockPath: string) => Promise<() => Promise<void>>;

/** lockf's exit code when `-t 0` finds the lock held. */
const EX_TEMPFAIL = 75;

/**
 * Holds `lockPath` with macOS's `lockf`, a kernel lock on the file kept by a
 * helper that waits on this process's pipe: the kernel releases it when the
 * helper ends, which is when the pipe closes, so a build that dies, even
 * killed outright, leaves no lock behind and none needs taking over. The
 * helper runs in its own process group, out of reach of a terminal's
 * Ctrl+C, and never keeps this process alive.
 */
const holdWithLockf = (
  lockPath: string,
  wait: boolean,
): Promise<(() => Promise<void>) | undefined> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "lockf",
      [
        "-k",
        ...(wait ? [] : ["-t", "0"]),
        lockPath,
        "/bin/sh",
        "-c",
        "echo held; exec cat >/dev/null",
      ],
      { detached: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    let held = false;
    child.stdout.once("data", () => {
      held = true;
      child.unref();
      (child.stdin as unknown as { unref?: () => void }).unref?.();
      (child.stdout as unknown as { unref?: () => void }).unref?.();
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      resolve(async () => {
        // Referenced again, so this process waits for the release.
        child.ref();
        child.stdin.end();
        await exited;
      });
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (held) return;
      if (!wait && code === EX_TEMPFAIL) resolve(undefined);
      else reject(new Error(`lockf ${lockPath} exited with ${code}.`));
    });
  });

export const acquireWithLockf: AcquireLock = async (lockPath) => {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const release = await holdWithLockf(lockPath, false);
  if (release) return release;
  p.log.info(
    "Waiting for another build's signing keychain under this macOS user.",
  );
  return (await holdWithLockf(lockPath, true))!;
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
  acquireLock = acquireWithLockf,
}: {
  security?: RunSecurity;
  directory?: string;
  /** The per-user lock builds take turns with. */
  lockPath?: string;
  acquireLock?: AcquireLock;
} = {}): Promise<SigningKeychain> => {
  if (live) {
    throw new Error("A signing keychain is already in use by this process.");
  }
  // Held from before the snapshot until the keychains are restored; the
  // process's end releases it too.
  live = { restore: () => undefined };
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquireLock(lockPath);
  } catch (error) {
    live = undefined;
    throw error;
  }
  process.on("exit", restoreLive);

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
    await releaseLock();
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
      live = undefined;
      process.off("exit", restoreLive);
      await releaseLock().catch(() => undefined);
      if (failures.length > 0) {
        p.log.warn(
          [
            "Couldn't restore the keychains after the build.",
            ...failures,
            "Check security list-keychains -d user and default-keychain -d user,",
            `and delete ${keychainPath} if it is left.`,
          ].join("\n"),
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
      // Without -v: an identity whose chain the keychain can't verify yet is
      // still one Xcode created.
      const identities = new Set(
        [
          ...(
            await security(["find-identity", "-p", "codesigning", keychainPath])
          ).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s/gm),
        ].map((match) => match[1]!),
      );
      if (identities.size === 0) return [];
      const pems =
        (await security(["find-certificate", "-a", "-p", keychainPath])).match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        ) ?? [];
      return pems.flatMap((pem) => {
        const certificate = new crypto.X509Certificate(pem);
        if (!identities.has(certificate.fingerprint.replaceAll(":", ""))) {
          return [];
        }
        return [
          {
            serialNumber: normalizeSerial(certificate.serialNumber),
            commonName:
              certificate.subject.match(/^CN=(.*)$/m)?.[1] ??
              certificate.subject,
          },
        ];
      });
    },
    dispose,
  };
};

/** A request App Store Connect refused, in one line. */
class AppStoreConnectRefusal extends Error {
  /** Whether the team has a Program License Agreement to accept. */
  readonly agreement: boolean;
  constructor(message: string, agreement: boolean) {
    super(message);
    this.agreement = agreement;
  }
}

const refusal = async (action: string, response: Response) => {
  const body = (await response.json().catch(() => undefined)) as
    | { errors?: { code?: string; detail?: string; title?: string }[] }
    | undefined;
  return new AppStoreConnectRefusal(
    `${action} failed (HTTP ${response.status}).`,
    isProgramLicenseAgreementError(
      Array.isArray(body?.errors) ? body.errors : [],
    ),
  );
};

/**
 * Revokes the certificates Xcode created in the build's keychain, whose
 * private keys the keychain's deletion destroys: on a runner that starts
 * empty, Xcode creates a development certificate for every build, and App
 * Store Connect refuses new ones once a team has its maximum. Each is found
 * in the team's certificates by serial number. A revocation that fails is
 * reported with each certificate's name and serial and where to revoke it
 * by hand, and never fails the build.
 */
export const revokeKeychainCertificates = async ({
  certificates,
  apiKey,
  privateKey,
  fetch = globalThis.fetch,
}: {
  certificates: readonly KeychainCertificate[];
  apiKey: Credentials["asc-api-key"];
  /** The key's private key, read already, as a cancelled build's is. */
  privateKey?: crypto.KeyObject;
  fetch?: typeof globalThis.fetch;
}): Promise<{ revoked: string[]; failed: string[] }> => {
  const revoked: KeychainCertificate[] = [];
  const failed: { certificate: KeychainCertificate; status?: number }[] = [];
  /** Why none could be revoked: the token or the listing failed. */
  let reason: string | undefined;
  let agreement = false;
  if (certificates.length === 0) return { revoked: [], failed: [] };

  try {
    const token = createAppStoreConnectToken({
      privateKey:
        privateKey ??
        crypto.createPrivateKey(
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
        throw await refusal("Listing the team's certificates", response);
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
        revoked.push(certificate);
      } else {
        agreement ||= (await refusal("Revoking", response)).agreement;
        failed.push({ certificate, status: response.status });
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    agreement ||= error instanceof AppStoreConnectRefusal && error.agreement;
    for (const certificate of certificates) {
      if (!revoked.includes(certificate)) failed.push({ certificate });
    }
  }

  const describe = ({ commonName, serialNumber }: KeychainCertificate) =>
    `${commonName} (serial ${serialNumber})`;
  if (revoked.length > 0) {
    p.log.info(
      [
        "Revoked the certificates Xcode created for this build:",
        ...revoked.flatMap(({ commonName, serialNumber }) => [
          commonName,
          `Serial ${serialNumber}`,
        ]),
      ].join("\n"),
    );
  }
  if (failed.length > 0) {
    p.log.warn(
      [
        "Couldn't revoke the certificates Xcode created for this build.",
        ...(reason === undefined ? [] : [reason]),
        ...(agreement ? [PROGRAM_LICENSE_AGREEMENT_HINT] : []),
        ...failed.flatMap(({ certificate, status }) => [
          certificate.commonName,
          `Serial ${certificate.serialNumber}${status === undefined ? "" : ` (HTTP ${status})`}`,
        ]),
        CERTIFICATES_URL,
      ].join("\n"),
    );
  }
  return {
    revoked: revoked.map(describe),
    failed: failed.map(({ certificate }) => describe(certificate)),
  };
};

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * Runs `run`, the archive and export of a build that signs with an App
 * Store Connect API key, in a keychain of its own when `enabled` (in CI),
 * then revokes the certificates Xcode created in it and deletes it. A
 * termination signal does the same before the process ends with it: the
 * certificates are read from the keychain before it is deleted, and the key
 * is read into memory first, since the build's temporary key file is deleted
 * on the signal. A second signal restores the keychains at once.
 *
 * `keepDistribution` keeps a distribution certificate out of the revoking, for
 * an ad hoc export: Xcode may have signed the `.ipa` with one it created here,
 * rather than the cloud-managed one, and installs may need it valid. Only the
 * development certificates Xcode created for the archive are then revoked.
 */
export const withSigningKeychain = async <T>({
  enabled,
  keepDistribution = false,
  apiKey,
  run,
  security,
  lockPath,
  acquireLock,
  fetch,
}: {
  enabled: boolean;
  keepDistribution?: boolean;
  apiKey: Credentials["asc-api-key"];
  run: () => Promise<T>;
  security?: RunSecurity;
  lockPath?: string;
  acquireLock?: AcquireLock;
  fetch?: typeof globalThis.fetch;
}): Promise<T> => {
  if (!enabled) return run();
  const privateKey = crypto.createPrivateKey(
    await fs.promises.readFile(apiKey.keyPath, "utf-8"),
  );
  const keychain = await createSigningKeychain({
    security,
    lockPath,
    acquireLock,
  });
  p.log.info("Signing in a keychain of this build's own (CI is set).");

  let cleanup: Promise<void> | undefined;
  const release = () => {
    cleanup ??= (async () => {
      const certificates = await keychain.certificates().catch(() => []);
      await keychain.dispose();
      await revokeKeychainCertificates({
        certificates: keepDistribution
          ? certificates.filter(
              ({ commonName }) => !commonName.includes("Distribution"),
            )
          : certificates,
        apiKey,
        privateKey,
        fetch,
      });
    })();
    return cleanup;
  };
  const stopListening = () => {
    for (const signal of TERMINATION_SIGNALS) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (cleanup) {
      // Asked again: restore the keychains now, and end.
      stopListening();
      restoreLive();
      process.kill(process.pid, signal);
      return;
    }
    void release().finally(() => {
      stopListening();
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    });
  };
  for (const signal of TERMINATION_SIGNALS) process.on(signal, onSignal);

  try {
    return await run();
  } finally {
    await release();
    stopListening();
  }
};
