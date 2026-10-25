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
  createSigningKeychain,
  revokeKeychainCertificates,
  withSigningKeychain,
} from "./ciSigningKeychain";

/**
 * The public certificate Xcode creates for a CI build, as `security
 * find-certificate -p` prints it: serial 0A1B2C3D4E5F.
 */
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

const LOGIN = "/Users/runner/Library/Keychains/login.keychain-db";
const SYSTEM = "/Library/Keychains/System.keychain";

/** A fake `security`, recording each call, that prints what macOS would. */
const fakeSecurity = (
  {
    certificates = "",
    fail,
  }: { certificates?: string; fail?: (args: readonly string[]) => boolean } = {},
) => {
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
    if (args[0] === "find-certificate") return certificates;
    return "";
  });
  return { security, calls };
};

let directory: string;
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

    const keychain = await createSigningKeychain({ security, directory });

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

  it("restores the keychains when setting one up fails", async () => {
    const { security, calls } = fakeSecurity({
      fail: (args) => args[0] === "unlock-keychain",
    });

    await expect(
      createSigningKeychain({ security, directory }),
    ).rejects.toThrow("security unlock-keychain failed");

    expect(calls.slice(-3)).toEqual([
      ["default-keychain", "-d", "user", "-s", LOGIN],
      ["list-keychains", "-d", "user", "-s", LOGIN, SYSTEM],
      ["delete-keychain", expect.stringMatching(/hot-updater-.*\.keychain-db$/)],
    ]);
    // Another build in the same process can create one again.
    const keychain = await createSigningKeychain({
      security: fakeSecurity().security,
      directory,
    });
    await keychain.dispose();
  });

  it("lists the certificates Xcode created in it by serial number", async () => {
    const { security } = fakeSecurity({
      certificates: `${XCODE_CERTIFICATE}\n`,
    });
    const keychain = await createSigningKeychain({ security, directory });

    await expect(keychain.certificates()).resolves.toEqual([
      {
        serialNumber: "A1B2C3D4E5F",
        commonName: "Apple Development: Created via API (ABCDE12345)",
      },
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
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  });
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
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.appstoreconnect.apple.com/v1/certificates?fields%5Bcertificates%5D=serialNumber&limit=200",
      "GET https://api.appstoreconnect.apple.com/v1/certificates?cursor=2",
      "DELETE https://api.appstoreconnect.apple.com/v1/certificates/CERT1",
    ]);
    expect(requests[0]!.headers.get("authorization")).toMatch(/^Bearer ey/);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Revoked the signing certificates Xcode created"),
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
      "Apple Development: Created via API (ABCDE12345) (serial A1B2C3D4E5F): HTTP 403",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Revoke them at https://developer.apple.com/account/resources/certificates/list",
      ),
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
      withSigningKeychain({ enabled: false, apiKey, run, security }),
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
      withSigningKeychain({ enabled: true, apiKey, run, security, fetch }),
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
});
