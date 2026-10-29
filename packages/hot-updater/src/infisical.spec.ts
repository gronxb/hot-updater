import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maskSecretValues } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { infisical } from "./infisical";

const SITE = "https://infisical.example.com";
const PROJECT = "11111111-2222-3333-4444-555555555555";
const AUTH_ENV = [
  "INFISICAL_TOKEN",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  "INFISICAL_MACHINE_IDENTITY_ID",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly init: RequestInit;
}

type Route = (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const refusal = (status: number, error: string, message: string) =>
  json(status, { reqId: "req-1", statusCode: status, error, message });

const listed = (...keys: string[]) =>
  json(200, {
    secrets: keys.map((secretKey) => ({
      secretKey,
      secretValue: "<hidden-by-infisical>",
      secretValueHidden: true,
    })),
    imports: [],
  });

const secret = (secretKey: string, secretValue: string, hidden = false) =>
  json(200, {
    secret: { secretKey, secretValue, secretValueHidden: hidden },
  });

let calls: Call[];
let route: Route;
let cwd: string;

const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
  const call: Call = {
    method: init.method ?? "GET",
    url: new URL(String(input)),
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    init,
  };
  calls.push(call);
  return route(call);
});

/** A server holding `held` in `prod` at `/`, signing in with Universal Auth. */
const server =
  (
    held: Record<string, string>,
    overrides: Partial<Record<string, Route>> = {},
  ): Route =>
  (call) => {
    const key = `${call.method} ${call.url.pathname}`;
    const override = overrides[key];
    if (override) return override(call);
    if (key === "POST /api/v1/auth/universal-auth/login") {
      return json(200, {
        accessToken: "ua-access-token-1",
        expiresIn: 7200,
        tokenType: "Bearer",
      });
    }
    if (key === "GET /api/v4/secrets") return listed(...Object.keys(held));
    const name = decodeURIComponent(
      call.url.pathname.replace("/api/v4/secrets/", ""),
    );
    if (call.method === "GET") {
      return name in held
        ? secret(name, held[name]!)
        : refusal(404, "NotFound", `Secret with name '${name}' not found`);
    }
    if (call.method === "PATCH") {
      if (!(name in held)) {
        return refusal(404, "NotFound", `Secret with name ${name} not found`);
      }
      held[name] = (call.body as { secretValue: string }).secretValue;
      return secret(name, held[name]!);
    }
    if (call.method === "POST") {
      held[name] = (call.body as { secretValue: string }).secretValue;
      return secret(name, held[name]!);
    }
    return json(500, {});
  };

const universalAuthEnv = () => {
  process.env["INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"] = "client-id-1";
  process.env["INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"] = "client-secret-1";
};

const adapter = (options: Partial<Parameters<typeof infisical>[0]> = {}) =>
  infisical({
    siteUrl: SITE,
    projectId: PROJECT,
    environment: "prod",
    ...options,
  });

beforeEach(async () => {
  calls = [];
  route = server({});
  for (const name of AUTH_ENV) delete process.env[name];
  vi.stubGlobal("fetch", fetchMock);
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-infisical-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const name of AUTH_ENV) delete process.env[name];
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("infisical", () => {
  it("signs in with Universal Auth and reads each name once, listing the folder first", async () => {
    universalAuthEnv();
    route = server({ "asc-api-key": '{"keyId":"A"}', other: "unrelated" });

    const values = await adapter().get(
      ["asc-api-key", "missing", "asc-api-key"],
      { cwd },
    );

    expect({ ...values }).toEqual({
      "asc-api-key": '{"keyId":"A"}',
      missing: undefined,
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "GET /api/v4/secrets",
      "GET /api/v4/secrets/asc-api-key",
    ]);
    const [login, list, read] = calls;
    expect(login!.body).toEqual({
      clientId: "client-id-1",
      clientSecret: "client-secret-1",
    });
    expect(Object.fromEntries(list!.url.searchParams)).toEqual({
      projectId: PROJECT,
      environment: "prod",
      secretPath: "/",
      viewSecretValue: "false",
      include_imports: "true",
    });
    expect(Object.fromEntries(read!.url.searchParams)).toEqual({
      projectId: PROJECT,
      environment: "prod",
      secretPath: "/",
      type: "shared",
      expandSecretReferences: "false",
    });
    expect(read!.headers["authorization"]).toBe("Bearer ua-access-token-1");
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("reads a name an imported folder holds", async () => {
    universalAuthEnv();
    route = server(
      { shared: "from-import" },
      {
        "GET /api/v4/secrets": () =>
          json(200, {
            secrets: [],
            imports: [
              { secretPath: "/shared", secrets: [{ secretKey: "shared" }] },
            ],
          }),
      },
    );

    await expect(adapter().get(["shared"], { cwd })).resolves.toEqual({
      shared: "from-import",
    });
  });

  it("makes no request for no names", async () => {
    universalAuthEnv();
    await expect(adapter().get([], { cwd })).resolves.toEqual({});
    expect(calls).toEqual([]);
  });

  it("throws when the environment or folder is missing, instead of reading undefined", async () => {
    universalAuthEnv();
    route = server(
      {},
      {
        "GET /api/v4/secrets": () =>
          refusal(
            404,
            "SecretPathNotFound",
            "Folder with path '/ci' in environment 'prod' was not found.",
          ),
      },
    );

    await expect(
      adapter({ path: "ci/" }).get(["asc-api-key"], { cwd }),
    ).rejects.toThrow(
      `Infisical at ${SITE} found no project ${PROJECT}, environment prod, folder /ci to list the secrets (404): Folder with path '/ci' in environment 'prod' was not found. Check projectId, environment, and path.`,
    );
    expect(calls[1]!.url.searchParams.get("secretPath")).toBe("/ci");
  });

  it("updates a secret that exists, without creating it", async () => {
    universalAuthEnv();
    const held = { "asc-api-key": "old" };
    route = server(held);

    await adapter().set("asc-api-key", "new", { cwd });

    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
    expect(calls[1]!.body).toEqual({
      projectId: PROJECT,
      environment: "prod",
      secretPath: "/",
      secretValue: "new",
      type: "shared",
    });
    expect(held["asc-api-key"]).toBe("new");
  });

  it("creates a secret the update does not find", async () => {
    universalAuthEnv();
    const held: Record<string, string> = {};
    route = server(held);

    await adapter().set("release-keystore", '{"keystore":"AAAA"}', { cwd });

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "PATCH /api/v4/secrets/release-keystore",
      "POST /api/v4/secrets/release-keystore",
    ]);
    expect(calls[2]!.body).toEqual({
      projectId: PROJECT,
      environment: "prod",
      secretPath: "/",
      secretValue: '{"keystore":"AAAA"}',
      type: "shared",
    });
    expect(held["release-keystore"]).toBe('{"keystore":"AAAA"}');
  });

  it("reuses the access token across calls, and renews one about to expire", async () => {
    universalAuthEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    let issued = 0;
    route = server(
      { a: "1" },
      {
        "POST /api/v1/auth/universal-auth/login": () =>
          json(200, { accessToken: `token-${++issued}`, expiresIn: 600 }),
      },
    );
    const secrets = adapter();

    await secrets.get(["a"], { cwd });
    await secrets.set("a", "2", { cwd });
    expect(issued).toBe(1);

    vi.setSystemTime(Date.now() + 590_000);
    await secrets.get(["a"], { cwd });
    expect(issued).toBe(2);
    expect(calls.at(-1)!.headers["authorization"]).toBe("Bearer token-2");
  });

  it("signs in with GitHub OIDC with the job's ID token", async () => {
    process.env["INFISICAL_MACHINE_IDENTITY_ID"] = "identity-1";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] =
      "https://pipelines.actions.example.com/idtoken?api-version=2.0";
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "runner-request-token";
    route = server(
      { a: "1" },
      {
        "GET /idtoken": () => json(200, { value: "github.jwt.value" }),
        "POST /api/v1/auth/oidc-auth/login": () =>
          json(200, { accessToken: "oidc-access-token", expiresIn: 7200 }),
      },
    );

    await expect(
      adapter({
        auth: { method: "github-oidc", audience: "https://github.com/acme" },
      }).get(["a"], { cwd }),
    ).resolves.toEqual({ a: "1" });

    const [idToken, exchange, list] = calls;
    expect(idToken!.url.origin).toBe("https://pipelines.actions.example.com");
    expect(Object.fromEntries(idToken!.url.searchParams)).toEqual({
      "api-version": "2.0",
      audience: "https://github.com/acme",
    });
    expect(idToken!.headers["authorization"]).toBe(
      "bearer runner-request-token",
    );
    expect(idToken!.init.redirect).toBe("error");
    expect(exchange!.url.href).toBe(`${SITE}/api/v1/auth/oidc-auth/login`);
    expect(exchange!.body).toEqual({
      identityId: "identity-1",
      jwt: "github.jwt.value",
    });
    expect(list!.headers["authorization"]).toBe("Bearer oidc-access-token");
  });

  it("leaves the ID token's audience to GitHub's default when none is given", async () => {
    process.env["INFISICAL_MACHINE_IDENTITY_ID"] = "identity-1";
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] =
      "https://pipelines.actions.example.com/idtoken?api-version=2.0";
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "runner-request-token";
    route = server(
      {},
      {
        "GET /idtoken": () => json(200, { value: "github.jwt.value" }),
        "POST /api/v1/auth/oidc-auth/login": () =>
          json(200, { accessToken: "oidc-access-token" }),
      },
    );

    await adapter().get(["a"], { cwd });

    expect(calls[0]!.url.searchParams.has("audience")).toBe(false);
  });

  it("asks for id-token: write when the job cannot request an ID token", async () => {
    await expect(
      adapter({
        auth: { method: "github-oidc", identityId: "identity-1" },
      }).get(["a"], { cwd }),
    ).rejects.toThrow(
      "infisical() signs in with GitHub OIDC in a GitHub Actions job with `permissions: id-token: write`, and ACTIONS_ID_TOKEN_REQUEST_URL is not set.",
    );
    expect(calls).toEqual([]);
  });

  it("uses INFISICAL_TOKEN as it is, from .env.hotupdater too", async () => {
    await fs.writeFile(
      path.join(cwd, ".env.hotupdater"),
      "INFISICAL_TOKEN=user-session-token\n",
    );
    route = server({ a: "1" });

    await expect(adapter().get(["a"], { cwd })).resolves.toEqual({ a: "1" });

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v4/secrets",
      "/api/v4/secrets/a",
    ]);
    expect(calls[0]!.headers["authorization"]).toBe(
      "Bearer user-session-token",
    );
  });

  it("prefers INFISICAL_TOKEN, then Universal Auth, when auth is not given", async () => {
    universalAuthEnv();
    process.env["INFISICAL_TOKEN"] = "explicit-token";

    await adapter().get(["a"], { cwd });

    expect(calls[0]!.url.pathname).toBe("/api/v4/secrets");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer explicit-token");
  });

  it("names every way to sign in when none is set", async () => {
    await expect(adapter().get(["a"], { cwd })).rejects.toThrow(
      "infisical() found no way to sign in to Infisical: set INFISICAL_TOKEN, INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, or INFISICAL_MACHINE_IDENTITY_ID in GitHub Actions.",
    );
    expect(calls).toEqual([]);
  });

  it("masks the credentials, the tokens, and the values it reads", async () => {
    process.env["INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"] = "client-id-1";
    process.env["INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"] =
      "masked-client-secret";
    route = server(
      { a: "masked-secret-value" },
      {
        "POST /api/v1/auth/universal-auth/login": () =>
          json(200, { accessToken: "masked-access-token" }),
      },
    );

    await adapter().get(["a"], { cwd });

    expect(
      maskSecretValues(
        "masked-client-secret masked-access-token masked-secret-value",
      ),
    ).toBe("******** ******** ********");
  });

  it.each([
    [
      "a rejected sign-in",
      "POST /api/v1/auth/universal-auth/login",
      refusal(401, "UnauthorizedError", "Invalid credentials"),
      `Infisical at ${SITE} rejected the credentials to sign in with Universal Auth (401): Invalid credentials. Check the identity's credentials or the access token.`,
    ],
    [
      "a sign-in route that is not there",
      "POST /api/v1/auth/universal-auth/login",
      new Response("not found", { status: 404 }),
      `Infisical at ${SITE} answered 404 to sign in with Universal Auth. Check siteUrl and the identity's authentication settings.`,
    ],
    [
      "a malformed token",
      "GET /api/v4/secrets",
      refusal(403, "TokenError", "The provided access token is malformed."),
      `Infisical at ${SITE} rejected the credentials to list the secrets (403): The provided access token is malformed. Check the identity's credentials or the access token.`,
    ],
    [
      "a missing permission",
      "GET /api/v4/secrets",
      refusal(
        403,
        "PermissionDenied",
        "You are not allowed to read on secrets",
      ),
      `Infisical at ${SITE} does not let the identity list the secrets in project ${PROJECT}, environment prod, folder / (403): You are not allowed to read on secrets. Give it a project role that allows it: Viewer reads, Member stores.`,
    ],
    [
      "a server error",
      "GET /api/v4/secrets",
      new Response("<html>bad gateway</html>", { status: 502 }),
      `Infisical at ${SITE} answered 502 to list the secrets.`,
    ],
  ])("reports %s", async (_, key, response, message) => {
    universalAuthEnv();
    route = server({}, { [key]: () => response });

    await expect(adapter().get(["a"], { cwd })).rejects.toThrow(message);
  });

  it("refuses to write without the permission, and does not create instead", async () => {
    universalAuthEnv();
    route = server(
      {},
      {
        "PATCH /api/v4/secrets/a": () =>
          refusal(
            403,
            "PermissionDenied",
            "You are not allowed to edit on secrets",
          ),
      },
    );

    await expect(adapter().set("a", "1", { cwd })).rejects.toThrow(
      "does not let the identity update a in project",
    );
    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
  });

  it("refuses a value Infisical hides from the identity", async () => {
    universalAuthEnv();
    route = server(
      { a: "1" },
      {
        "GET /api/v4/secrets/a": () =>
          secret("a", "<hidden-by-infisical>", true),
      },
    );

    await expect(adapter().get(["a"], { cwd })).rejects.toThrow(
      "hides the value of a from the identity",
    );
  });

  it("names only the host when Infisical is unreachable", async () => {
    universalAuthEnv();
    route = () => {
      throw new TypeError("fetch failed: client-secret-1");
    };

    const error = await adapter()
      .get(["a"], { cwd })
      .catch((thrown: unknown) => thrown);

    expect(error).toEqual(
      new Error(`Could not reach ${SITE} to sign in with Universal Auth.`),
    );
  });

  it.each([
    "http://infisical.example.com",
    "https://user:pass@infisical.example.com",
    "https://infisical.example.com/?x=1",
    "https://infisical.example.com/#x",
    "not a url",
  ])("refuses siteUrl %s on first use", async (siteUrl) => {
    process.env["INFISICAL_TOKEN"] = "t";
    const secrets = adapter({ siteUrl });

    await expect(secrets.get(["a"], { cwd })).rejects.toThrow(
      "infisical() takes siteUrl as an HTTPS URL, or HTTP on a loopback address",
    );
    expect(calls).toEqual([]);
  });

  it("keeps a siteUrl's path, and allows HTTP on loopback", async () => {
    process.env["INFISICAL_TOKEN"] = "t";
    route = () => listed();
    await adapter({ siteUrl: "https://example.com/infisical/" }).get(["a"], {
      cwd,
    });
    await adapter({ siteUrl: "http://127.0.0.1:8080" }).get(["a"], { cwd });

    expect(calls.map((call) => call.url.origin + call.url.pathname)).toEqual([
      "https://example.com/infisical/api/v4/secrets",
      "http://127.0.0.1:8080/api/v4/secrets",
    ]);
  });

  it("defaults to Infisical Cloud (US)", async () => {
    process.env["INFISICAL_TOKEN"] = "t";
    await infisical({ projectId: PROJECT, environment: "prod" }).get(["a"], {
      cwd,
    });

    expect(calls[0]!.url.origin).toBe("https://us.infisical.com");
  });

  it("requires projectId and environment on first use, so a config loads without them", async () => {
    process.env["INFISICAL_TOKEN"] = "t";
    const noProject = infisical({ projectId: "", environment: "prod" });
    const noEnvironment = infisical({ projectId: PROJECT, environment: " " });

    await expect(noProject.get(["a"], { cwd })).rejects.toThrow(
      "infisical() needs the projectId of your project.",
    );
    await expect(noEnvironment.set("a", "1", { cwd })).rejects.toThrow(
      'infisical() needs the slug of the environment, such as "prod".',
    );
    expect(calls).toEqual([]);
  });

  it("creates a secret on a race when the update finds none but the create finds one", async () => {
    universalAuthEnv();
    const held: Record<string, string> = {};
    let patches = 0;
    route = server(held, {
      "PATCH /api/v4/secrets/a": (call) => {
        patches += 1;
        if (patches === 1) {
          return refusal(404, "NotFound", "Secret with name a not found");
        }
        held["a"] = (call.body as { secretValue: string }).secretValue;
        return secret("a", held["a"]);
      },
      "POST /api/v4/secrets/a": () =>
        refusal(
          400,
          "BadRequest",
          "Secret 'a' already exists in path '/' of environment 'prod'",
        ),
    });

    await adapter().set("a", "1", { cwd });

    expect(calls.map((call) => call.method)).toEqual([
      "POST",
      "PATCH",
      "POST",
      "PATCH",
    ]);
    expect(held["a"]).toBe("1");
  });

  it("reports a create Infisical refuses for another reason", async () => {
    universalAuthEnv();
    route = server(
      {},
      {
        "POST /api/v4/secrets/a": () =>
          refusal(400, "BadRequest", "Something else is wrong"),
      },
    );

    await expect(adapter().set("a", "1", { cwd })).rejects.toThrow(
      `Infisical at ${SITE} answered 400 to create a: Something else is wrong.`,
    );
    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH", "POST"]);
  });

  it("refuses to create without the permission, as a Viewer", async () => {
    universalAuthEnv();
    route = server(
      {},
      {
        "POST /api/v4/secrets/a": () =>
          refusal(
            403,
            "PermissionDenied",
            "You are not allowed to create on secrets",
          ),
      },
    );

    await expect(adapter().set("a", "1", { cwd })).rejects.toThrow(
      `Infisical at ${SITE} does not let the identity create a in project ${PROJECT}, environment prod, folder / (403): You are not allowed to create on secrets. Give it a project role that allows it: Viewer reads, Member stores.`,
    );
  });

  it("reports a write to a missing folder", async () => {
    universalAuthEnv();
    const missing = () =>
      refusal(
        404,
        "CreateSecret",
        "Folder with path '/ci' in environment with slug 'prod' not found",
      );
    route = server(
      {},
      {
        "PATCH /api/v4/secrets/a": missing,
        "POST /api/v4/secrets/a": missing,
      },
    );

    await expect(
      adapter({ path: "/ci" }).set("a", "1", { cwd }),
    ).rejects.toThrow(
      `found no project ${PROJECT}, environment prod, folder /ci to create a (404)`,
    );
  });

  it.each(["__proto__", "a/b", "a:b", " "])(
    "refuses the name %j before any request",
    async (name) => {
      universalAuthEnv();
      const secrets = adapter();

      await expect(secrets.get([name], { cwd })).rejects.toThrow(
        `infisical() cannot name a secret ${JSON.stringify(name)}: Infisical takes no colon or slash, and no __proto__.`,
      );
      await expect(secrets.set(name, "1", { cwd })).rejects.toThrow(
        "infisical() cannot name a secret",
      );
      expect(calls).toEqual([]);
    },
  );

  it("takes every name the CLI stores", async () => {
    universalAuthEnv();
    const held: Record<string, string> = {};
    route = server(held);
    const names = [
      "asc-api-key",
      "release-keystore",
      "play-service-account",
      "bundle-signing-key",
      "HOT_UPDATER_API_KEY",
      "CLOUDFLARE_API_TOKEN",
    ];

    for (const name of names)
      await adapter().set(name, `${name}-value`, { cwd });

    expect(Object.keys(held)).toEqual(names);
  });

  it.each([
    ["an empty value", ""],
    ["a blank value", " \n"],
  ])("refuses %s", async (_, value) => {
    universalAuthEnv();

    await expect(adapter().set("a", value, { cwd })).rejects.toThrow(
      "infisical() cannot store an empty a.",
    );
    expect(calls).toEqual([]);
  });

  it.each([" lead", "trail ", "two newlines\n\n", "crlf\r\n", "\ttab"])(
    "refuses %j, which Infisical would trim",
    async (value) => {
      universalAuthEnv();

      await expect(adapter().set("a", value, { cwd })).rejects.toThrow(
        "infisical() cannot store a as it is: Infisical trims whitespace around a value.",
      );
      expect(calls).toEqual([]);
    },
  );

  it("stores a PEM with its final newline, and JSON with ${ as it is", async () => {
    universalAuthEnv();
    const held: Record<string, string> = {};
    route = server(held);
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
    const json = '{"note":"${NOT_A_REFERENCE}"}';

    await adapter().set("bundle-signing-key", pem, { cwd });
    await adapter().set("asc-api-key", json, { cwd });

    expect(held).toEqual({ "bundle-signing-key": pem, "asc-api-key": json });
  });

  it("stores a base64 keystore, and refuses a value over Infisical's 1 MiB request limit", async () => {
    universalAuthEnv();
    const held: Record<string, string> = {};
    route = server(held);
    const keystore = JSON.stringify({
      keystore: Buffer.alloc(8 * 1024, 7).toString("base64"),
      storePassword: "p",
      keyAlias: "upload",
      keyPassword: "p",
    });

    await adapter().set("release-keystore", keystore, { cwd });
    expect(held["release-keystore"]).toBe(keystore);

    calls = [];
    await expect(
      adapter().set("too-large", "A".repeat(1024 * 1024), { cwd }),
    ).rejects.toThrow(
      "infisical() cannot store too-large: Infisical takes requests up to 1 MiB.",
    );
    expect(calls).toEqual([]);
  });

  it("describes where a name is", () => {
    expect(adapter({ path: "/ci" }).describe?.("asc-api-key")).toBe(
      "Infisical prod:/ci/asc-api-key",
    );
    expect(adapter().describe?.("asc-api-key")).toBe(
      "Infisical prod:/asc-api-key",
    );
  });
});
