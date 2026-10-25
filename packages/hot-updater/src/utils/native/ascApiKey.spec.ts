import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, text, confirm } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, confirm, isCancel: vi.fn(() => false) },
}));

import type {
  IssueAscApiKeyRequest,
  IssuedAscApiKey,
} from "@hot-updater/apple-helper";

import {
  AscApiKeyNotStoredError,
  AscApiKeyRefusedError,
  ascApiKeySetupCommand,
  ensureAscApiKey,
} from "./ascApiKey";

const CONSOLE_URL = "https://console.example.com";
const TOKEN = `hu_vault_${"T".repeat(43)}`;
const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----";

type Secret = {
  name: string;
  kind: string;
  version: number;
  metadata: Record<string, string>;
};

/**
 * A Console vault as its routes answer (packages/console vaultRoutes.ts,
 * whose spec pins the write probe): the token's scope decides before the
 * value does, and only a valid value is stored.
 */
const fakeConsole = ({
  secrets = [] as Secret[],
  actions = ["read", "write"] as string[],
  putStatus,
}: {
  secrets?: Secret[];
  actions?: string[];
  /** The answer to a valid write, such as 503 for a locked vault. */
  putStatus?: number;
} = {}) => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(
      "/_hot-updater/vault/v1",
      "",
    );
    const body =
      request.method === "GET" ? undefined : await request.clone().json();
    requests.push({ method: request.method, path, body });
    const refuse = (status: number, code: string) =>
      Response.json({ error: { code, message: code } }, { status });
    if (request.method === "GET" && path === "/secrets") {
      return Response.json({ secrets });
    }
    if (request.method === "POST" && path === "/resolve") {
      if (!actions.includes("read")) return refuse(403, "forbidden");
      const names = (body as { names: string[] }).names;
      return Response.json({
        secrets: [],
        errors: names.map((name) => ({ name, code: "not_found" })),
      });
    }
    if (request.method === "PUT" && path.startsWith("/secrets/")) {
      if (!actions.includes("write")) return refuse(403, "forbidden");
      const { kind, value } = body as {
        kind: string;
        value: { p8?: string; keyId?: string; issuerId?: string };
      };
      if (!value.p8 || !value.keyId || !value.issuerId) {
        return refuse(400, "invalid_request");
      }
      if (putStatus) return refuse(putStatus, "vault_locked");
      const secret = {
        name: decodeURIComponent(path.slice("/secrets/".length)),
        kind,
        version: 1,
        metadata: { keyId: value.keyId, issuerId: value.issuerId },
      };
      secrets.push(secret);
      return Response.json({ secret }, { status: 201 });
    }
    return refuse(404, "not_found");
  });
  return requests;
};

const withTTY = async <T>(isTTY: boolean, run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

/**
 * An `IssueAscApiKey` that issues KEY1234567: what ensureAscApiKey depends
 * on, whichever sign-in implements it (apple-helper's specs cover asc's).
 */
const issued = {
  revoke: vi.fn(async () => true),
  dispose: vi.fn(async () => {}),
};
const issue = vi.fn(
  async (request: IssueAscApiKeyRequest): Promise<IssuedAscApiKey> => ({
    p8: P8,
    keyId: "KEY1234567",
    issuerId: "issuer-1",
    name: request.name,
    team: { appleId: request.appleId, developerTeamId: "ABCDE12345" },
    revoke: issued.revoke,
    dispose: issued.dispose,
  }),
);

/** ensureAscApiKey with the stand-in sign-in. */
const ensure = (options: Parameters<typeof ensureAscApiKey>[0]) =>
  ensureAscApiKey({ issue, ...options });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);
  for (const name of [
    "HOT_UPDATER_ASC_KEY_PATH",
    "HOT_UPDATER_ASC_KEY",
    "HOT_UPDATER_ASC_KEY_ID",
    "HOT_UPDATER_ASC_ISSUER_ID",
  ]) {
    vi.stubEnv(name, "");
  }
  text.mockResolvedValue("dev@example.com");
  confirm.mockResolvedValue(true);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ensureAscApiKey", () => {
  it("uses an environment override as it is, without the vault", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY");
    const requests = fakeConsole();
    await expect(ensure({ name: "asc-api-key" })).resolves.toEqual({
      status: "environment",
    });
    expect(requests).toEqual([]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses a stored key without a terminal or a sign-in, as CI does", async () => {
    const requests = fakeConsole({
      secrets: [
        { name: "asc-api-key", kind: "asc-api-key", version: 3, metadata: {} },
      ],
    });
    await expect(
      withTTY(false, () => ensure({ name: "asc-api-key", read: true })),
    ).resolves.toEqual({ status: "stored", version: 3 });
    expect(requests).toEqual([{ method: "GET", path: "/secrets" }]);
    expect(issue).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("finds a stored key with the connection only in .env.hotupdater", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", undefined);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "asc-key-"));
    try {
      await fs.writeFile(path.join(project, "package.json"), "{}");
      await fs.writeFile(
        path.join(project, ".env.hotupdater"),
        `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}\nHOT_UPDATER_VAULT_TOKEN=${TOKEN}\n`,
      );
      vi.spyOn(process, "cwd").mockReturnValue(project);
      const requests = fakeConsole({
        secrets: [
          {
            name: "asc-api-key",
            kind: "asc-api-key",
            version: 2,
            metadata: {},
          },
        ],
      });
      await expect(
        ensure({ name: "asc-api-key", read: true }),
      ).resolves.toEqual({ status: "stored", version: 2 });
      expect(requests).toEqual([{ method: "GET", path: "/secrets" }]);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("refuses without a terminal, with the command that signs in once", async () => {
    const requests = fakeConsole();
    await expect(
      withTTY(false, () => ensure({ name: "widget-asc", read: true })),
    ).rejects.toBeInstanceOf(AscApiKeyRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      "widget-asc is not in the vault yet. Hot Updater issues it when you sign in with your Apple Account, which needs a terminal. Run `npx hot-updater secrets put widget-asc --kind asc-api-key` in a terminal once, and builds use the stored key, also in a non-interactive shell.",
    );
    expect(ascApiKeySetupCommand("widget-asc")).toBe(
      "npx hot-updater secrets put widget-asc --kind asc-api-key",
    );
    expect(process.exitCode).toBe(1);
    // Nothing asked of the vault beyond the list, and no Apple prompt.
    expect(requests).toEqual([{ method: "GET", path: "/secrets" }]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a token that cannot store the key before any Apple sign-in", async () => {
    fakeConsole({ actions: ["read"] });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", read: true })),
    ).rejects.toThrow("The vault token cannot store asc-api-key");
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a build whose token could store the key but not read it back", async () => {
    fakeConsole({ actions: ["write"] });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", read: true })),
    ).rejects.toThrow("The vault token cannot read asc-api-key");
    expect(issue).not.toHaveBeenCalled();
  });

  it("says the vault is where the key goes when it is not connected", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", "");
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", "");
    const requests = fakeConsole();
    await expect(ensure({ name: "asc-api-key" })).rejects.toThrow(
      "keeps in the Console's vault, and HOT_UPDATER_CONSOLE_URL and HOT_UPDATER_VAULT_TOKEN are not set",
    );
    expect(requests).toEqual([]);
  });

  it("refuses a vault secret of another kind under the name", async () => {
    fakeConsole({
      secrets: [
        { name: "asc-api-key", kind: "generic", version: 1, metadata: {} },
      ],
    });
    await expect(ensure({ name: "asc-api-key" })).rejects.toThrow(
      "is a generic, not an asc-api-key",
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("issues a key after the checks, stores it as an asc-api-key, and reads it back", async () => {
    const requests = fakeConsole();

    await expect(
      withTTY(true, () =>
        ensure({
          name: "asc-api-key",
          bundleIdentifier: "com.example.app",
          read: true,
        }),
      ),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567", version: 1 });

    expect(requests).toEqual([
      { method: "GET", path: "/secrets" },
      // The write and read probes, before asc runs.
      {
        method: "PUT",
        path: "/secrets/asc-api-key",
        body: { kind: "asc-api-key", value: {}, expectedVersion: 0 },
      },
      { method: "POST", path: "/resolve", body: { names: ["asc-api-key"] } },
      {
        method: "PUT",
        path: "/secrets/asc-api-key",
        body: {
          kind: "asc-api-key",
          value: {
            p8: Buffer.from(P8).toString("base64"),
            keyId: "KEY1234567",
            issuerId: "issuer-1",
          },
          expectedVersion: 0,
        },
      },
      { method: "GET", path: "/secrets" },
    ]);
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "ADMIN",
        appleId: "dev@example.com",
        name: expect.stringMatching(
          /^hot-updater com\.example\.app \d{4}-\d{2}-\d{2}$/u,
        ),
      }),
    );
    // Hot Updater asks only for the Apple Account's email.
    expect(text).toHaveBeenCalledTimes(1);
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("revokes the key with its session when the Console does not keep it", async () => {
    fakeConsole({ putStatus: 503 });
    const error = await withTTY(true, () =>
      ensure({ name: "asc-api-key" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AscApiKeyNotStoredError);
    expect(error).toMatchObject({ keyId: "KEY1234567", revoked: true });
    expect((error as Error).message).toContain(
      "The App Store Connect API key KEY1234567 was not stored, so it was revoked again: The Console at https://console.example.com answered 503",
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    // Revoked before the session ends.
    expect(issued.revoke.mock.invocationCallOrder[0]!).toBeLessThan(
      issued.dispose.mock.invocationCallOrder[0]!,
    );
  });

  it("names the key to revoke by hand when the revoke fails too", async () => {
    fakeConsole({ putStatus: 503 });
    issued.revoke.mockResolvedValueOnce(false);
    const error = await withTTY(true, () =>
      ensure({ name: "asc-api-key" }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ revoked: false });
    expect((error as Error).message).toContain(
      "was not stored, and revoking it failed: revoke KEY1234567 at https://appstoreconnect.apple.com/access/integrations/api.",
    );
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("revokes the key when the vault does not list it as stored", async () => {
    fakeConsole();
    issue.mockImplementationOnce(async (request) => {
      // Another writer's metadata is listed right after the write.
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () =>
        Response.json(
          { secret: { name: "asc-api-key", version: 1 } },
          { status: 201 },
        ),
      );
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () =>
        Response.json({
          secrets: [
            {
              name: "asc-api-key",
              kind: "asc-api-key",
              version: 1,
              metadata: { keyId: "OTHER", issuerId: "issuer-1" },
            },
          ],
        }),
      );
      return {
        p8: P8,
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        name: request.name,
        team: {},
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toThrow(
      "The vault does not list asc-api-key as the key just stored.",
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
  });

  it("asks which team when the sign-in landed in another", async () => {
    fakeConsole();
    confirm.mockResolvedValueOnce(false);
    text
      .mockResolvedValueOnce("dev@example.com")
      .mockResolvedValueOnce(" OTHERTEAM ");
    let chosen: string | undefined;
    issue.mockImplementationOnce(async (request) => {
      chosen = await request.chooseTeam?.({ developerTeamId: "ABCDE12345" });
      return {
        p8: P8,
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        name: request.name,
        team: { teamId: chosen },
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    await withTTY(true, () => ensure({ name: "asc-api-key" }));
    expect(confirm).toHaveBeenCalledWith({
      message: "Create the key in the team ABCDE12345?",
    });
    expect(chosen).toBe("OTHERTEAM");
  });

  it("stores in the vault for secrets put even when the environment overrides the key", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY");
    fakeConsole();
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", environment: false })),
    ).resolves.toMatchObject({ status: "issued" });
  });
});
