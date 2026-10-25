import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, text, select, open } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  select: vi.fn(),
  open: vi.fn(async () => {}),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, select, isCancel: vi.fn(() => false) },
}));
vi.mock("open", () => ({ default: open }));

import type {
  IssuedPlayServiceAccount,
  IssuePlayServiceAccountRequest,
} from "@hot-updater/android-helper";

import {
  ensurePlayServiceAccount,
  PlayServiceAccountRefusedError,
  playServiceAccountSetupCommand,
} from "./playServiceAccount";

const CONSOLE_URL = "https://console.example.com";
const TOKEN = `hu_vault_${"T".repeat(43)}`;
const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "my-app",
  client_email: EMAIL,
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
});

type Secret = {
  name: string;
  kind: string;
  version: number;
  metadata: Record<string, string>;
};

/**
 * A Console vault as its routes answer (packages/console vaultRoutes.ts):
 * the token's scope decides before the value does, and only a service
 * account key file is stored, listed with its client email.
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
      // A token scoped by kind reads no name that no secret has.
      if (names.some((name) => !secrets.some((s) => s.name === name))) {
        return refuse(403, "forbidden");
      }
      return Response.json({
        secrets: secrets
          .filter((secret) => names.includes(secret.name))
          .map(({ name, kind, version }) => ({
            name,
            kind,
            version,
            value: { serviceAccount: Buffer.from(KEY_FILE).toString("base64") },
          })),
        errors: [],
      });
    }
    if (request.method === "PUT" && path.startsWith("/secrets/")) {
      if (!actions.includes("write")) return refuse(403, "forbidden");
      const { kind, value } = body as {
        kind: string;
        value: { serviceAccount?: string };
      };
      if (!value.serviceAccount) return refuse(400, "invalid_request");
      if (putStatus) return refuse(putStatus, "vault_locked");
      const { client_email } = JSON.parse(
        Buffer.from(value.serviceAccount, "base64").toString("utf-8"),
      ) as { client_email: string };
      const secret = {
        name: decodeURIComponent(path.slice("/secrets/".length)),
        kind,
        version: 1,
        metadata: { clientEmail: client_email, projectId: "my-app" },
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
 * An `IssuePlayServiceAccount` that issues EMAIL's key: what
 * ensurePlayServiceAccount depends on, whichever sign-in implements it
 * (android-helper's specs cover Google's).
 */
const issued = {
  revoke: vi.fn(async () => true),
  dispose: vi.fn(async () => {}),
};
const issue = vi.fn(
  async (
    request: IssuePlayServiceAccountRequest,
  ): Promise<IssuedPlayServiceAccount> => {
    await request.onSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?x");
    await request.askDeveloperId();
    await request.chooseProject([{ projectId: "my-app" }]);
    return {
      json: KEY_FILE,
      email: EMAIL,
      projectId: "my-app",
      developerId: "1234",
      keyId: "abc123",
      revoke: issued.revoke,
      dispose: issued.dispose,
    };
  },
);

const ensure = (options: Parameters<typeof ensurePlayServiceAccount>[0]) =>
  ensurePlayServiceAccount({ issue, ...options });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOT_UPDATER_CONSOLE_URL", CONSOLE_URL);
  vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", TOKEN);
  for (const name of [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
    "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
  ]) {
    vi.stubEnv(name, "");
  }
  text.mockImplementation(async ({ message }: { message: string }) =>
    message.includes("developer account") ? "1234" : "com.example.app",
  );
  select.mockResolvedValue("my-app");
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ensurePlayServiceAccount", () => {
  it("uses an environment override as it is, without the vault", async () => {
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON", KEY_FILE);
    const requests = fakeConsole();

    await expect(ensure({ name: "play-service-account" })).resolves.toEqual({
      status: "environment",
    });
    expect(requests).toEqual([]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses a stored key without a terminal or a sign-in, as CI does", async () => {
    const requests = fakeConsole({
      secrets: [
        {
          name: "play-service-account",
          kind: "play-service-account",
          version: 3,
          metadata: {},
        },
      ],
    });

    await expect(
      withTTY(false, () => ensure({ name: "play-service-account" })),
    ).resolves.toEqual({ status: "stored", version: 3 });
    expect(requests).toEqual([{ method: "GET", path: "/secrets" }]);
    expect(issue).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("finds a stored key with the connection only in .env.hotupdater", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", undefined);
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "play-key-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      await fs.writeFile(path.join(project, "package.json"), "{}");
      await fs.writeFile(
        path.join(project, ".env.hotupdater"),
        `HOT_UPDATER_CONSOLE_URL=${CONSOLE_URL}\nHOT_UPDATER_VAULT_TOKEN=${TOKEN}\n`,
      );
      fakeConsole({
        secrets: [
          {
            name: "play-service-account",
            kind: "play-service-account",
            version: 2,
            metadata: {},
          },
        ],
      });

      await expect(ensure({ name: "play-service-account" })).resolves.toEqual({
        status: "stored",
        version: 2,
      });
    } finally {
      cwd.mockRestore();
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("refuses without a terminal, with the command that signs in once, and no sign-in", async () => {
    const requests = fakeConsole();

    await expect(
      withTTY(false, () => ensure({ name: "play-service-account" })),
    ).rejects.toBeInstanceOf(PlayServiceAccountRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        playServiceAccountSetupCommand("play-service-account"),
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(requests).toEqual([{ method: "GET", path: "/secrets" }]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a vault secret of another kind under the name", async () => {
    fakeConsole({
      secrets: [
        {
          name: "play-service-account",
          kind: "generic",
          version: 1,
          metadata: {},
        },
      ],
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow("is a generic, not a play-service-account");
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a token that cannot store the key before the sign-in", async () => {
    fakeConsole({ actions: ["read"] });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow("The vault token cannot store play-service-account");
    expect(issue).not.toHaveBeenCalled();
  });

  it("keeps the stored key, and names the token, when a build's token cannot read it back", async () => {
    fakeConsole({ actions: ["write"] });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account", read: true })),
    ).rejects.toThrow(
      "play-service-account is stored (v1), but the vault token cannot read it",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("names the missing vault connection, and the override that works without one", async () => {
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", undefined);

    await expect(ensure({ name: "play-service-account" })).rejects.toThrow(
      /HOT_UPDATER_VAULT_TOKEN is not set.*HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON/su,
    );
  });

  it("checks the vault in order, signs in, stores the key, and reads it back", async () => {
    const requests = fakeConsole();

    await expect(
      withTTY(true, () =>
        ensure({
          name: "play-service-account",
          packageName: "com.example.app",
          read: true,
        }),
      ),
    ).resolves.toEqual({ status: "issued", email: EMAIL, version: 1 });

    // A token scoped by kind reads the name only once the secret exists,
    // so the read back comes after the store.
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /secrets",
      "PUT /secrets/play-service-account",
      "PUT /secrets/play-service-account",
      "GET /secrets",
      "POST /resolve",
    ]);
    // The probe stores nothing, and the key goes only to the vault.
    expect(requests[1]!.body).toEqual({
      kind: "play-service-account",
      value: {},
      expectedVersion: 0,
    });
    expect(requests[2]!.body).toEqual({
      kind: "play-service-account",
      value: { serviceAccount: Buffer.from(KEY_FILE).toString("base64") },
      expectedVersion: 0,
    });
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "com.example.app" }),
    );
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
    );
    expect(open).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?x",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("signs in with the OAuth client the environment names", async () => {
    vi.stubEnv(
      "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
      "mine.apps.googleusercontent.com",
    );
    vi.stubEnv("HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET", "GOCSPX-mine");
    fakeConsole();

    await withTTY(true, () => ensure({ name: "play-service-account" }));

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthClient: {
          clientId: "mine.apps.googleusercontent.com",
          clientSecret: "GOCSPX-mine",
        },
      }),
    );
  });

  it("deletes the key again when the vault refuses it, and says what remains", async () => {
    fakeConsole({ putStatus: 503 });

    const error = await withTTY(true, () =>
      ensure({ name: "play-service-account" }),
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toContain(
      "The vault did not store play-service-account",
    );
    expect(error?.message).toContain("The key abc123 was deleted again.");
    expect(error?.message).toContain(
      `The service account ${EMAIL} and its Play Console access remain`,
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("says where to delete a key the cleanup could not delete", async () => {
    fakeConsole({ putStatus: 503 });
    issued.revoke.mockResolvedValueOnce(false);

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow(
      "Deleting the key abc123 failed: delete it under the service account's keys at https://console.cloud.google.com/iam-admin/serviceaccounts?project=my-app.",
    );
  });

  it("deletes a key the vault does not list as stored", async () => {
    fakeConsole();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json({ secrets: [] });
      if (request.method === "PUT") {
        const body = (await request.json()) as { value: object };
        if (Object.keys(body.value).length === 0) {
          return Response.json(
            { error: { code: "invalid_request", message: "x" } },
            { status: 400 },
          );
        }
        return Response.json({
          secret: {
            name: "play-service-account",
            kind: "play-service-account",
            version: 1,
            metadata: {},
          },
        });
      }
      return Response.json({}, { status: 404 });
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow(
      "The vault does not list play-service-account as the key just stored.",
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
  });
});
