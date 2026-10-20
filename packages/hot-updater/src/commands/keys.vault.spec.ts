import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keysGenerate } from "./keys";

const { log, spinner } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

// The vault client runs for real against a mocked Console.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  p: { log, spinner: () => spinner },
}));

const TOKEN = `hu_vault_${"W".repeat(43)}`;
const CONSOLE_URL = "https://console.example.com";

let directory: string;

const printed = () =>
  [...log.message.mock.calls, ...log.error.mock.calls]
    .map(([text]) => stripVTControlCharacters(String(text)))
    .join("\n");

/** A Console that answers each write with `respond`, and the bodies it received. */
const mockConsole = (respond: () => Response) => {
  const writes: {
    url: string;
    body: { kind?: string; value?: { privateKey: string } };
  }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    writes.push({ url: request.url, body: await request.json() });
    return respond();
  });
  return writes;
};

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-keys-"));
  vi.mocked(getCwd).mockReturnValue(directory);
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("hot-updater keys generate --vault", () => {
  it("stores the private key in the vault, writing and printing only the public key", async () => {
    const writes = mockConsole(() =>
      Response.json(
        {
          secret: {
            id: "sec-1",
            name: "bundle-signing-key",
            kind: "bundle-signing-key",
            version: 1,
          },
        },
        { status: 201 },
      ),
    );

    await keysGenerate({ keySize: 2048, vault: true });

    expect(process.exitCode).toBeUndefined();
    expect(writes).toHaveLength(1);
    const [{ url, body }] = writes as [(typeof writes)[number]];
    expect(url).toBe(
      `${CONSOLE_URL}/_hot-updater/vault/v1/secrets/bundle-signing-key`,
    );
    expect(body).toEqual({
      kind: "bundle-signing-key",
      value: { privateKey: expect.any(String) },
      expectedVersion: 0,
    });
    const privateKeyPem = Buffer.from(
      body.value!.privateKey,
      "base64",
    ).toString("utf8");
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");

    expect(await fs.readdir(path.join(directory, "keys"))).toEqual([
      "public-key.pem",
    ]);
    const publicKey = await fs.readFile(
      path.join(directory, "keys", "public-key.pem"),
      "utf8",
    );
    expect(publicKey).toBe(
      crypto
        .createPublicKey(privateKeyPem)
        .export({ format: "pem", type: "spki" })
        .toString(),
    );

    const output = printed();
    expect(output).toContain("bundle-signing-key in the vault of");
    expect(output).toContain(`endpoint: "${CONSOLE_URL}"`);
    expect(output).toContain(
      "hot-updater secrets token create --name <ci> --secrets bundle-signing-key --actions sign",
    );
    expect(output).not.toContain("PRIVATE KEY");
    expect(output).not.toContain(body.value!.privateKey);
  });

  it("never replaces a secret under the name, and leaves no public key behind", async () => {
    const writes = mockConsole(() =>
      Response.json(
        {
          error: {
            code: "conflict",
            message:
              'The secret "ota-key" is at version 2, and the write expected no secret under its name.',
          },
        },
        { status: 409 },
      ),
    );

    await keysGenerate({ keySize: 2048, vault: "ota-key" });

    expect(process.exitCode).toBe(1);
    expect(writes[0]?.url).toBe(
      `${CONSOLE_URL}/_hot-updater/vault/v1/secrets/ota-key`,
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "The vault already holds a secret named ota-key, and keys generate --vault never replaces one",
      ),
    );
    await expect(fs.readdir(path.join(directory, "keys"))).resolves.toEqual([]);
  });

  it("keeps an existing public key, storing nothing", async () => {
    const writes = mockConsole(() => Response.json({}));
    await fs.mkdir(path.join(directory, "keys"));
    await fs.writeFile(path.join(directory, "keys", "public-key.pem"), "old");

    await keysGenerate({ keySize: 2048, vault: true });

    expect(process.exitCode).toBe(1);
    expect(writes).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("public-key.pem already exists"),
    );
    await expect(
      fs.readFile(path.join(directory, "keys", "public-key.pem"), "utf8"),
    ).resolves.toBe("old");
  });

  it("names the connection variables when they are not set, writing nothing", async () => {
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");

    await keysGenerate({ keySize: 2048, vault: true });

    expect(process.exitCode).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("HOT_UPDATER_VAULT_TOKEN"),
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });
});
