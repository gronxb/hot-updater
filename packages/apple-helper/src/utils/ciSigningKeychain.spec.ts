import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log },
}));

import {
  acquireWithLockf,
  createSigningKeychain,
  revokeKeychainCertificates,
  withSigningKeychain,
} from "./ciSigningKeychain";

/**
 * The public certificate Xcode creates for a CI build, as `security
 * find-certificate -p` prints it: serial 0A1B2C3D4E5F.
 */
/** What Xcode would create to sign an ad hoc `.ipa` with, serial C1B61101312B3E29. */
const DISTRIBUTION_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICwTCCAmgCCQDBthEBMSs+KTAKBggqhkjOPQQDAjBvMTkwNwYDVQQDDDBBcHBs
ZSBEaXN0cmlidXRpb246IENyZWF0ZWQgdmlhIEFQSSAoQUJDREUxMjM0NSkxEzAR
BgNVBAsMClEzUVQ0WkYzNDMxEDAOBgNVBAoMB0V4YW1wbGUxCzAJBgNVBAYTAlVT
MB4XDTI2MTEwMTA1MTMzMFoXDTM2MTAyOTA1MTMzMFowbzE5MDcGA1UEAwwwQXBw
bGUgRGlzdHJpYnV0aW9uOiBDcmVhdGVkIHZpYSBBUEkgKEFCQ0RFMTIzNDUpMRMw
EQYDVQQLDApRM1FUNFpGMzQzMRAwDgYDVQQKDAdFeGFtcGxlMQswCQYDVQQGEwJV
UzCCAUswggEDBgcqhkjOPQIBMIH3AgEBMCwGByqGSM49AQECIQD/////AAAAAQAA
AAAAAAAAAAAAAP///////////////zBbBCD/////AAAAAQAAAAAAAAAAAAAAAP//
/////////////AQgWsY12Ko6k+ez671VdpiGvGUdBrDMU7D2O848PifSYEsDFQDE
nTYIhucEk2pmeOETnSa3gZ9+kARBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPSh
OUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfUCIQD/////AAAA
AP//////////vOb6racXnoTzucrC/GMlUQIBAQNCAARm1hJDMkw44oBhjMZMjQxq
mocN9A+p32hjHbncq8kTCkLYd9V43Q3nhuaXwh4DzU6fB4Zutgj43d6Q9spEkKMH
MAoGCCqGSM49BAMCA0cAMEQCIAbSxnsQlzaPWH/k2QcswD9AkObcP3Xxdnwcw6yp
j/7xAiBNA8C5TaWhGjp9gU5pPeO1/cRd11dYsz1RqxB/e0vHeA==
-----END CERTIFICATE-----`;

const XCODE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICvTCCAmMCBgobLD1OXzAKBggqhkjOPQQDAjBuMTgwNgYDVQQDDC9BcHBsZSBE
ZXZlbG9wbWVudDogQ3JlYXRlZCB2aWEgQVBJIChBQkNERTEyMzQ1KTETMBEGA1UE
CwwKUTNRVDRaRjM0MzEQMA4GA1UECgwHRXhhbXBsZTELMAkGA1UEBhMCVVMwHhcN
MjYxMDI1MDQzMzE1WhcNMzYxMDIyMDQzMzE1WjBuMTgwNgYDVQQDDC9BcHBsZSBE
ZXZlbG9wbWVudDogQ3JlYXRlZCB2aWEgQVBJIChBQkNERTEyMzQ1KTETMBEGA1UE
CwwKUTNRVDRaRjM0MzEQMA4GA1UECgwHRXhhbXBsZTELMAkGA1UEBhMCVVMwggFL
MIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAA
AAAAAAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD/////////
//////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbn
BJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjC
lk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD/////
/////7zm+q2nF56E87nKwvxjJVECAQEDQgAEafk+UqjrA6nwLZry2hS1stYq7Kvs
prv90QoT/4mIJlOvZJ1m2PVdHD9S3qMGrG62PA8sBUsn7JTF6PQUHJ8r7zAKBggq
hkjOPQQDAgNIADBFAiBdmDV0kDR3U6TLxMUOPKDrfOB6mWSCrwudkZwqdUKgUQIh
AIuXK3FrmQrp/cVXu+yfChxvGgzf6JlHqDclVa3JkPpT
-----END CERTIFICATE-----`;

/**
 * The Apple WWDR intermediate CA Xcode imports into the keychain beside the
 * certificate it creates: no private key, so no signing identity.
 */
const WWDR_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIEUTCCAzmgAwIBAgIQfK9pCiW3Of57m0R6wXjF7jANBgkqhkiG9w0BAQsFADBi
MQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBw
bGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3Qg
Q0EwHhcNMjAwMjE5MTgxMzQ3WhcNMzAwMjIwMDAwMDAwWjB1MUQwQgYDVQQDDDtB
cHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTELMAkGA1UECwwCRzMxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJ
BgNVBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2PWJ/KhZ
C4fHTJEuLVaQ03gdpDDppUjvC0O/LYT7JF1FG+XrWTYSXFRknmxiLbTGl8rMPPbW
BpH85QKmHGq0edVny6zpPwcR4YS8Rx1mjjmi6LRJ7TrS4RBgeo6TjMrA2gzAg9Dj
+ZHWp4zIwXPirkbRYp2SqJBgN31ols2N4Pyb+ni743uvLRfdW/6AWSN1F7gSwe0b
5TTO/iK1nkmw5VW/j4SiPKi6xYaVFuQAyZ8D0MyzOhZ71gVcnetHrg21LYwOaU1A
0EtMOwSejSGxrC5DVDDOwYqGlJhL32oNP/77HK6XF8J4CjDgXx9UO0m3JQAaN4LS
VpelUkl8YDib7wIDAQABo4HvMIHsMBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0j
BBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wRAYIKwYBBQUHAQEEODA2MDQGCCsG
AQUFBzABhihodHRwOi8vb2NzcC5hcHBsZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNh
MC4GA1UdHwQnMCUwI6AhoB+GHWh0dHA6Ly9jcmwuYXBwbGUuY29tL3Jvb3QuY3Js
MB0GA1UdDgQWBBQJ/sAVkPmvZAqSErkmKGMMl+ynsjAOBgNVHQ8BAf8EBAMCAQYw
EAYKKoZIhvdjZAYCAQQCBQAwDQYJKoZIhvcNAQELBQADggEBAK1lE+j24IF3RAJH
Qr5fpTkg6mKp/cWQyXMT1Z6b0KoPjY3L7QHPbChAW8dVJEH4/M/BtSPp3Ozxb8qA
HXfCxGFJJWevD8o5Ja3T43rMMygNDi6hV0Bz+uZcrgZRKe3jhQxPYdwyFot30ETK
XXIDMUacrptAGvr04NM++i+MZp+XxFRZ79JI9AeZSWBZGcfdlNHAwWx/eCHvDOs7
bJmCS1JgOLU5gm3sUjFTvg+RTElJdI+mUcuER04ddSduvfnSXPN/wmwLCTbiZOTC
NwMUGdXqapSqqdv+9poIZ4vvK7iqF0mDr8/LvOnP6pVxsLRFoszlh6oKw0E6eVza
UDSdlTs=
-----END CERTIFICATE-----`;

/** A signing identity's SHA-1 hash, as `security find-identity` prints it. */
const identityHash = (pem: string) =>
  new crypto.X509Certificate(pem).fingerprint.replaceAll(":", "");

/** What `security find-identity -p codesigning` prints for `identities`. */
const findIdentityOutput = (identities: readonly string[]) =>
  [
    "",
    "Policy: Code Signing",
    "  Matching identities",
    ...identities.map(
      (pem, index) =>
        `  ${index + 1}) ${identityHash(pem)} "${new crypto.X509Certificate(pem).subject.match(/^CN=(.*)$/m)?.[1]}"`,
    ),
    `     ${identities.length} identities found`,
    "",
  ].join("\n");

const LOGIN = "/Users/runner/Library/Keychains/login.keychain-db";
const SYSTEM = "/Library/Keychains/System.keychain";

/** A fake `security`, recording each call, that prints what macOS would. */
const fakeSecurity = ({
  certificates = "",
  identities = certificates.includes(XCODE_CERTIFICATE)
    ? [XCODE_CERTIFICATE]
    : [],
  fail,
}: {
  certificates?: string;
  /** The certificates with their private key in the keychain. */
  identities?: readonly string[];
  fail?: (args: readonly string[]) => boolean;
} = {}) => {
  const calls: string[][] = [];
  const security = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    if (fail?.(args)) throw new Error(`security ${args[0]} failed`);
    if (args[0] === "default-keychain" && args.length === 3) {
      return `    "${LOGIN}"`;
    }
    if (args[0] === "list-keychains" && args.length === 3) {
      return `    "${LOGIN}"\n    "${SYSTEM}"`;
    }
    if (args[0] === "find-identity") return findIdentityOutput(identities);
    if (args[0] === "find-certificate") return certificates;
    return "";
  });
  return { security, calls };
};

let directory: string;
const lock = () => path.join(directory, "locks", "signing-keychain.lock");

/** A per-user lock that records when it is taken and released. */
const fakeLock = (events: string[] = []) => ({
  events,
  acquireLock: vi.fn(async (lockPath: string) => {
    events.push(`acquire ${path.basename(lockPath)}`);
    return async () => {
      events.push("release");
    };
  }),
});
let apiKey: { keyPath: string; keyId: string; issuerId: string };

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "signing-keychain-"));
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const keyPath = path.join(directory, "AuthKey_ABC.p8");
  await fs.writeFile(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  apiKey = { keyPath, keyId: "ABC", issuerId: "issuer" };
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("createSigningKeychain", () => {
  it("creates an unlocked keychain, makes it the default and first in the search list, and restores both when disposed", async () => {
    const { security, calls } = fakeSecurity();
    const exitListeners = process.listenerCount("exit");

    const keychain = await createSigningKeychain({
      security,
      directory,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
    });

    const keychainPath = keychain.path;
    expect(path.dirname(keychainPath)).toBe(directory);
    expect(path.basename(keychainPath)).toMatch(
      /^hot-updater-[0-9a-f]{12}\.keychain-db$/,
    );
    const password = calls[2]![2]!;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(calls).toEqual([
      ["default-keychain", "-d", "user"],
      ["list-keychains", "-d", "user"],
      ["create-keychain", "-p", password, keychainPath],
      ["set-keychain-settings", "-lut", "21600", keychainPath],
      ["unlock-keychain", "-p", password, keychainPath],
      ["list-keychains", "-d", "user", "-s", keychainPath, LOGIN, SYSTEM],
      ["default-keychain", "-d", "user", "-s", keychainPath],
    ]);
    // The process restores them if it exits before the build ends.
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);

    calls.length = 0;
    await keychain.dispose();
    await keychain.dispose();

    expect(calls).toEqual([
      ["default-keychain", "-d", "user", "-s", LOGIN],
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      ["delete-keychain", keychainPath],
    ]);
    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("restores the keychains and releases the lock when setting one up fails", async () => {
    const lockFake = fakeLock();
    const { security, calls } = fakeSecurity({
      fail: (args) => args[0] === "unlock-keychain",
    });

    await expect(
      createSigningKeychain({
        security,
        directory,
        lockPath: lock(),
        acquireLock: lockFake.acquireLock,
      }),
    ).rejects.toThrow("security unlock-keychain failed");

    expect(calls.slice(-3)).toEqual([
      ["default-keychain", "-d", "user", "-s", LOGIN],
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      [
        "delete-keychain",
        expect.stringMatching(/hot-updater-.*\.keychain-db$/),
      ],
    ]);
    expect(lockFake.events).toEqual([
      "acquire signing-keychain.lock",
      "release",
    ]);
    // Another build in the same process can create one again.
    const keychain = await createSigningKeychain({
      security: fakeSecurity().security,
      directory,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
    });
    await keychain.dispose();
  });

  it("restores only the search list for a user without a default keychain", async () => {
    const { security, calls } = fakeSecurity({
      fail: (args) => args[0] === "default-keychain" && args.length === 3,
    });

    const keychain = await createSigningKeychain({
      security,
      directory,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
    });
    calls.length = 0;
    await keychain.dispose();

    expect(calls).toEqual([
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      ["delete-keychain", keychain.path],
    ]);
  });

  it("holds the user's lock from before the snapshot until the keychains are restored", async () => {
    const events: string[] = [];
    const { acquireLock } = fakeLock(events);
    const { security } = fakeSecurity();
    security.mockImplementation(async (args) => {
      events.push(`security ${args[0]}`);
      if (args[0] === "list-keychains" && args.length === 3) {
        return `    "${LOGIN}"`;
      }
      return "";
    });

    const keychain = await createSigningKeychain({
      security,
      directory,
      lockPath: lock(),
      acquireLock,
    });
    await keychain.dispose();

    expect(events[0]).toBe("acquire signing-keychain.lock");
    expect(events[1]).toBe("security default-keychain");
    expect(events.at(-2)).toBe("security delete-keychain");
    expect(events.at(-1)).toBe("release");
  });

  it.runIf(process.platform === "darwin")(
    "takes turns with lockf, and the kernel frees the lock of a holder that dies",
    async () => {
      const lockPath = lock();
      const first = await acquireWithLockf(lockPath);
      let second: (() => Promise<void>) | undefined;
      const waiting = acquireWithLockf(lockPath).then((release) => {
        second = release;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(second).toBeUndefined();
      expect(log.info).toHaveBeenCalledWith(
        "Waiting for another build's signing keychain under this macOS user.",
      );
      await first();
      await waiting;
      await second!();

      // A holder killed outright: its lock goes with it.
      const holder = spawn("lockf", ["-k", lockPath, "sleep", "30"], {
        detached: true,
        stdio: "ignore",
      });
      for (;;) {
        const probe = spawnSync("lockf", ["-k", "-t", "0", lockPath, "true"]);
        if (probe.status === 75) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      process.kill(-holder.pid!, "SIGKILL");
      const release = await acquireWithLockf(lockPath);
      await release();
    },
  );

  it("lists the certificates Xcode created in it by serial number", async () => {
    const { security } = fakeSecurity({
      certificates: `${WWDR_INTERMEDIATE}\n${XCODE_CERTIFICATE}\n`,
    });
    const keychain = await createSigningKeychain({
      security,
      directory,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
    });

    await expect(keychain.certificates()).resolves.toEqual([
      {
        serialNumber: "A1B2C3D4E5F",
        commonName: "Apple Development: Created via API (ABCDE12345)",
      },
    ]);
    await keychain.dispose();
  });

  it("lists no intermediate CA certificate, which has no private key in it", async () => {
    const { security, calls } = fakeSecurity({
      certificates: `${WWDR_INTERMEDIATE}\n`,
    });
    const keychain = await createSigningKeychain({
      security,
      directory,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
    });

    await expect(keychain.certificates()).resolves.toEqual([]);
    expect(calls.at(-1)).toEqual([
      "find-identity",
      "-p",
      "codesigning",
      keychain.path,
    ]);
    await keychain.dispose();
  });
});

const CERTIFICATE = {
  serialNumber: "A1B2C3D4E5F",
  commonName: "Apple Development: Created via API (ABCDE12345)",
};

const mockAppStoreConnect = (
  respond: (request: Request) => Response | undefined = () => undefined,
) => {
  const requests: Request[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const answer = respond(request);
      if (answer) return answer;
      const url = new URL(request.url);
      if (request.method === "GET" && !url.searchParams.has("cursor")) {
        return Response.json({
          data: [{ id: "OTHER", attributes: { serialNumber: "77" } }],
          links: {
            next: "https://api.appstoreconnect.apple.com/v1/certificates?cursor=2",
          },
        });
      }
      if (request.method === "GET") {
        return Response.json({
          data: [{ id: "CERT1", attributes: { serialNumber: "0A1B2C3D4E5F" } }],
        });
      }
      return new Response(null, { status: 204 });
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
};

describe("revokeKeychainCertificates", () => {
  it("revokes the team's certificate with the keychain certificate's serial, across pages", async () => {
    const { fetch, requests } = mockAppStoreConnect();

    const result = await revokeKeychainCertificates({
      certificates: [CERTIFICATE],
      apiKey,
      fetch,
    });

    expect(result).toEqual({
      revoked: [
        "Apple Development: Created via API (ABCDE12345) (serial A1B2C3D4E5F)",
      ],
      failed: [],
    });
    expect(
      requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      "GET https://api.appstoreconnect.apple.com/v1/certificates?fields%5Bcertificates%5D=serialNumber&limit=200",
      "GET https://api.appstoreconnect.apple.com/v1/certificates?cursor=2",
      "DELETE https://api.appstoreconnect.apple.com/v1/certificates/CERT1",
    ]);
    expect(requests[0]!.headers.get("authorization")).toMatch(/^Bearer ey/);
    expect(log.info).toHaveBeenCalledWith(
      [
        "Revoked the certificates Xcode created for this build:",
        "Apple Development: Created via API (ABCDE12345)",
        "Serial A1B2C3D4E5F",
      ].join("\n"),
    );
  });

  it("leaves a certificate the team does not have", async () => {
    const { fetch, requests } = mockAppStoreConnect();

    await expect(
      revokeKeychainCertificates({
        certificates: [{ serialNumber: "BEEF", commonName: "Apple WWDR CA" }],
        apiKey,
        fetch,
      }),
    ).resolves.toEqual({ revoked: [], failed: [] });
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("warns with where to revoke by hand when App Store Connect refuses, without throwing", async () => {
    const { fetch } = mockAppStoreConnect((request) =>
      request.method === "DELETE"
        ? Response.json({ errors: [] }, { status: 403 })
        : undefined,
    );

    const result = await revokeKeychainCertificates({
      certificates: [CERTIFICATE],
      apiKey,
      fetch,
    });

    expect(result.failed).toEqual([
      "Apple Development: Created via API (ABCDE12345) (serial A1B2C3D4E5F)",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      [
        "Couldn't revoke the certificates Xcode created for this build.",
        "Apple Development: Created via API (ABCDE12345)",
        "Serial A1B2C3D4E5F (HTTP 403)",
        "https://developer.apple.com/account/resources/certificates/list",
      ].join("\n"),
    );
  });

  it("names each certificate it couldn't revoke and the agreement to accept, in lines of 73 columns at most", async () => {
    const { fetch } = mockAppStoreConnect((request) =>
      request.method === "GET"
        ? Response.json(
            {
              errors: [
                {
                  code: "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED",
                  detail:
                    "To resolve this issue, your team's Account Holder must agree to the latest Program License Agreement.",
                },
              ],
            },
            { status: 403 },
          )
        : undefined,
    );

    const result = await revokeKeychainCertificates({
      certificates: [CERTIFICATE],
      apiKey,
      fetch,
    });

    expect(result.failed).toHaveLength(1);
    const warning = log.warn.mock.calls[0]![0] as string;
    expect(warning).toBe(
      [
        "Couldn't revoke the certificates Xcode created for this build.",
        "Listing the team's certificates failed (HTTP 403).",
        "The Account Holder must accept the latest Program License Agreement:",
        "https://developer.apple.com/account",
        "Apple Development: Created via API (ABCDE12345)",
        "Serial A1B2C3D4E5F",
        "https://developer.apple.com/account/resources/certificates/list",
      ].join("\n"),
    );
  });

  it("asks App Store Connect nothing when Xcode created no certificate", async () => {
    const { fetch, requests } = mockAppStoreConnect();

    await revokeKeychainCertificates({ certificates: [], apiKey, fetch });

    expect(requests).toEqual([]);
  });
});

describe("withSigningKeychain", () => {
  it("only runs the build outside CI", async () => {
    const { security, calls } = fakeSecurity();
    const run = vi.fn(async () => "ipa");

    await expect(
      withSigningKeychain({
        enabled: false,
        apiKey,
        run,
        security,
        lockPath: lock(),
        acquireLock: fakeLock().acquireLock,
      }),
    ).resolves.toBe("ipa");
    expect(calls).toEqual([]);
  });

  it("builds in its own keychain, then deletes it and revokes what Xcode created, even when the build fails", async () => {
    const { security, calls } = fakeSecurity({
      certificates: XCODE_CERTIFICATE,
    });
    const { fetch, requests } = mockAppStoreConnect();
    const order: string[] = [];
    const run = vi.fn(async () => {
      order.push(`build in ${calls.at(-1)![0]} ${calls.at(-1)![4]}`);
      throw new Error("Archive failed");
    });

    await expect(
      withSigningKeychain({
        enabled: true,
        apiKey,
        run,
        security,
        lockPath: lock(),
        acquireLock: fakeLock().acquireLock,
        fetch,
      }),
    ).rejects.toThrow("Archive failed");

    const keychainPath = calls.find(
      (args) => args[0] === "create-keychain",
    )![3]!;
    expect(order).toEqual([`build in default-keychain ${keychainPath}`]);
    expect(calls.slice(-4)).toEqual([
      ["find-certificate", "-a", "-p", keychainPath],
      ["default-keychain", "-d", "user", "-s", LOGIN],
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      ["delete-keychain", keychainPath],
    ]);
    expect(requests.at(-1)!.method).toBe("DELETE");
  });

  it.each([
    [true, ["CERT1"]],
    [false, ["CERT1", "DIST1"]],
  ])(
    "with keepDistribution %s, revokes %j of what Xcode created",
    async (keepDistribution, revoked) => {
      const { security } = fakeSecurity({
        certificates: `${XCODE_CERTIFICATE}\n${DISTRIBUTION_CERTIFICATE}\n`,
        identities: [XCODE_CERTIFICATE, DISTRIBUTION_CERTIFICATE],
      });
      const { fetch, requests } = mockAppStoreConnect((request) =>
        request.method === "GET"
          ? Response.json({
              data: [
                { id: "CERT1", attributes: { serialNumber: "0A1B2C3D4E5F" } },
                {
                  id: "DIST1",
                  attributes: { serialNumber: "C1B61101312B3E29" },
                },
              ],
            })
          : undefined,
      );

      await withSigningKeychain({
        enabled: true,
        keepDistribution,
        apiKey,
        run: async () => "ipa",
        security,
        lockPath: lock(),
        acquireLock: fakeLock().acquireLock,
        fetch,
      });

      expect(
        requests
          .filter(({ method }) => method === "DELETE")
          .map(({ url }) => url.split("/").at(-1))
          .sort(),
      ).toEqual(revoked);
    },
  );

  it("asks App Store Connect nothing and warns of nothing when the keychain holds only intermediate CAs", async () => {
    const { security } = fakeSecurity({
      certificates: `${WWDR_INTERMEDIATE}\n`,
    });
    const { fetch, requests } = mockAppStoreConnect();

    await expect(
      withSigningKeychain({
        enabled: true,
        apiKey,
        run: async () => {
          throw new Error("Export failed");
        },
        security,
        lockPath: lock(),
        acquireLock: fakeLock().acquireLock,
        fetch,
      }),
    ).rejects.toThrow("Export failed");

    expect(requests).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it("revokes and restores before a termination signal ends the build, with the key file already gone", async () => {
    const { security, calls } = fakeSecurity({
      certificates: XCODE_CERTIFICATE,
    });
    const { fetch, requests } = mockAppStoreConnect();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let cancel: (reason: Error) => void = () => undefined;
    const run = () =>
      new Promise<never>((_, reject) => {
        cancel = reject;
      });

    const building = withSigningKeychain({
      enabled: true,
      apiKey,
      run,
      security,
      lockPath: lock(),
      acquireLock: fakeLock().acquireLock,
      fetch,
    });
    await vi.waitFor(() =>
      expect(
        calls.some(
          (args) => args[0] === "default-keychain" && args.length === 5,
        ),
      ).toBe(true),
    );
    // The credential resolver deletes the key file on the same signal.
    await fs.rm(apiKey.keyPath);
    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(requests.at(-1)?.method).toBe("DELETE"));
    const keychainPath = calls.find(
      (args) => args[0] === "create-keychain",
    )![3]!;
    expect(calls.slice(-4)).toEqual([
      ["find-certificate", "-a", "-p", keychainPath],
      ["default-keychain", "-d", "user", "-s", LOGIN],
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      ["delete-keychain", keychainPath],
    ]);

    // The build's own handler stops xcodebuild, and the build ends.
    cancel(new Error("xcodebuild was terminated"));
    await expect(building).rejects.toThrow("xcodebuild was terminated");
    // Cleaned up once.
    expect(
      requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    kill.mockRestore();
  });
});
