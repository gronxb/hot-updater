import { maskSecretValues } from "@hot-updater/cli-tools";
import sodium from "libsodium-wrappers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createGitHubSecretWriter } from "./githubSecretWriter";

const USER_TOKEN = "gho_specUserTokenFromGhCli000000000000";

let keyPair: { publicKey: Uint8Array; privateKey: Uint8Array };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A GitHub API that answers the public key and records each PUT. */
const stubGitHub = ({
  keyStatus = 200,
  putStatus = 201,
  headers = {},
}: {
  readonly keyStatus?: number;
  readonly putStatus?: number;
  readonly headers?: Record<string, string>;
} = {}) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/public-key")) {
        return keyStatus === 200
          ? Response.json({
              key_id: "568250167242549743",
              key: sodium.to_base64(
                keyPair.publicKey,
                sodium.base64_variants.ORIGINAL,
              ),
            })
          : Response.json(
              { message: "Not Found" },
              { status: keyStatus, headers },
            );
      }
      return putStatus < 300
        ? new Response(null, { status: putStatus })
        : Response.json(
            { message: "Resource not accessible by integration" },
            { status: putStatus, headers },
          );
    }),
  );
  return calls;
};

/** Opens a PUT body's sealed box with libsodium, as GitHub does. */
const openPut = (call: Call) => {
  const body = JSON.parse(String(call.init.body)) as {
    encrypted_value: string;
    key_id: string;
  };
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
    keyPair.publicKey,
    keyPair.privateKey,
  );
  return { keyId: body.key_id, value: sodium.to_string(opened) };
};

const writer = () =>
  createGitHubSecretWriter({ repo: "acme/app", token: USER_TOKEN });

beforeAll(async () => {
  await sodium.ready;
  // A fixed key pair, so a failure reproduces.
  keyPair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
});

beforeEach(() => {
  vi.stubEnv("CI", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createGitHubSecretWriter", () => {
  it("seals the value for the repository's public key and stores it under its variable name", async () => {
    const calls = stubGitHub();
    const value = JSON.stringify({ keyId: "ABC123", p8: "-----BEGIN…" });

    await writer().set("asc-api-key", value);

    expect(calls.map(({ url, init }) => [init.method ?? "GET", url])).toEqual([
      [
        "GET",
        "https://api.github.com/repos/acme/app/actions/secrets/public-key",
      ],
      [
        "PUT",
        "https://api.github.com/repos/acme/app/actions/secrets/HOT_UPDATER_ASC_API_KEY",
      ],
    ]);
    for (const { init } of calls) {
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${USER_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      });
    }
    expect(openPut(calls[1]!)).toEqual({ keyId: "568250167242549743", value });
  });

  it("seals each write with a fresh ephemeral key", async () => {
    const calls = stubGitHub();
    const secrets = writer();

    await secrets.set("TOKEN_A", "same value");
    await secrets.set("TOKEN_A", "same value");

    const [first, second] = calls
      .filter(({ init }) => init.method === "PUT")
      .map(({ init }) => JSON.parse(String(init.body)).encrypted_value);
    expect(first).not.toBe(second);
    expect(openPut(calls[1]!).value).toBe("same value");
    expect(openPut(calls[3]!).value).toBe("same value");
  });

  it("names the permission GitHub accepts when the token may not write", async () => {
    stubGitHub({
      putStatus: 403,
      headers: { "x-accepted-github-permissions": "secrets=write" },
    });

    await expect(writer().set("asc-api-key", "{}")).rejects.toThrow(
      "Could not store HOT_UPDATER_ASC_API_KEY in acme/app: the token may not write its secrets; GitHub accepts secrets=write (Resource not accessible by integration).",
    );
  });

  it("masks the token and the value", async () => {
    stubGitHub();
    const value = "spec-github-secret-value";

    await writer().set("TOKEN_B", value);

    expect(maskSecretValues(`${USER_TOKEN} ${value}`)).toBe(
      "******** ********",
    );
  });

  it.each([
    ["GITHUB_SHA_OVERRIDE", "start with GITHUB_"],
    ["NODE_OPTIONS", "changes how a process loads code"],
  ])("refuses %s", async (name, reason) => {
    const calls = stubGitHub();

    await expect(writer().set(name, "x")).rejects.toThrow(reason);
    expect(calls).toEqual([]);
  });

  it("refuses a value over GitHub's 48 KB", async () => {
    const calls = stubGitHub();

    await expect(
      writer().set("big", "x".repeat(48 * 1024 + 1)),
    ).rejects.toThrow("GitHub stores secrets up to 48 KB");
    expect(calls).toEqual([]);
  });
});
