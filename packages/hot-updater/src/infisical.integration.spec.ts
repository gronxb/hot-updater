import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maskSecretValues, storeEnvFileSecrets } from "@hot-updater/cli-tools";
import {
  assertDockerComposeAvailable,
  findOpenPort,
  runCheckedCommand,
} from "@hot-updater/test-utils/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infisical, type InfisicalAuth } from "./infisical";

// A self-hosted Infisical in Docker (infisical.compose.yml). The oracle is
// Infisical's REST API read with the bootstrap admin's token, never the
// adapter itself.

assertDockerComposeAvailable(
  "infisical() on a self-hosted Infisical requires Docker Compose.",
);

const COMPOSE_FILE = path.join(import.meta.dirname, "infisical.compose.yml");
const PROJECT_NAME = `hot-updater-infisical-${process.pid}`;

let site = "";
let port = 0;
let admin = "";
let projectId = "";
let writer: { clientId: string; clientSecret: string };
let reader: { clientId: string; clientSecret: string };
let cwd = "";

const compose = (...args: string[]) =>
  runCheckedCommand({
    command: "docker",
    args: ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, ...args],
    cwd: import.meta.dirname,
    env: { HOT_UPDATER_INFISICAL_PORT: String(port) },
  });

/** A request as the bootstrap admin, which must succeed. */
const asAdmin = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${site}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${route}: ${JSON.stringify(answer)}`);
  }
  return answer as Record<string, any>;
};

/** What Infisical holds as `name`, read as the admin; undefined if nothing. */
const oracle = async (name: string, secretPath = "/", environment = "prod") => {
  const url = new URL(`${site}/api/v4/secrets/${encodeURIComponent(name)}`);
  url.search = new URLSearchParams({
    projectId,
    environment,
    secretPath,
    expandSecretReferences: "false",
  }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  if (response.status === 404) return undefined;
  expect(response.status).toBe(200);
  return ((await response.json()) as { secret: { secretValue: string } }).secret
    .secretValue;
};

const createIdentity = async (
  organizationId: string,
  name: string,
  role: string,
) => {
  const { identity } = await asAdmin("POST", "/api/v1/identities", {
    name,
    organizationId,
    role: "no-access",
  });
  const { identityUniversalAuth } = await asAdmin(
    "POST",
    `/api/v1/auth/universal-auth/identities/${identity.id}`,
    {},
  );
  const { clientSecret } = await asAdmin(
    "POST",
    `/api/v1/auth/universal-auth/identities/${identity.id}/client-secrets`,
    {},
  );
  await asAdmin(
    "POST",
    `/api/v1/projects/${projectId}/memberships/identities/${identity.id}`,
    { role },
  );
  return {
    clientId: identityUniversalAuth.clientId as string,
    clientSecret: clientSecret as string,
  };
};

const adapter = (
  auth: InfisicalAuth,
  options: { environment?: string; path?: string; projectId?: string } = {},
) =>
  infisical({
    siteUrl: site,
    projectId,
    environment: "prod",
    auth,
    ...options,
  });

const asWriter = (options?: Parameters<typeof adapter>[1]) =>
  adapter({ method: "universal-auth", ...writer }, options);
const asReader = (options?: Parameters<typeof adapter>[1]) =>
  adapter({ method: "universal-auth", ...reader }, options);

beforeAll(async () => {
  port = await findOpenPort();
  site = `http://127.0.0.1:${port}`;
  compose("up", "-d", "--quiet-pull");
  const deadline = Date.now() + 240_000;
  for (;;) {
    const ready = await fetch(`${site}/api/status`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error("Infisical did not start.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const bootstrap = await fetch(`${site}/api/v1/admin/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@hot-updater.test",
      password: `${crypto.randomUUID()}Aa1!`,
      organization: "hot-updater",
    }),
  });
  const { identity, organization } = (await bootstrap.json()) as {
    identity: { credentials: { token: string } };
    organization: { id: string };
  };
  admin = identity.credentials.token;
  const { project } = await asAdmin("POST", "/api/v1/projects", {
    projectName: "hot-updater",
    type: "secret-manager",
  });
  projectId = project.id;
  writer = await createIdentity(organization.id, "writer", "member");
  reader = await createIdentity(organization.id, "reader", "viewer");

  await asAdmin("POST", "/api/v2/folders", {
    projectId,
    environment: "prod",
    name: "hot-updater",
    path: "/",
  });
  // A name held only in staging's /shared, which prod's / imports.
  await asAdmin("POST", "/api/v2/folders", {
    projectId,
    environment: "staging",
    name: "shared",
    path: "/",
  });
  await asAdmin("POST", "/api/v4/secrets/IMPORTED_ONLY", {
    projectId,
    environment: "staging",
    secretPath: "/shared",
    secretValue: "from-import",
  });
  await asAdmin("POST", "/api/v2/secret-imports", {
    projectId,
    environment: "prod",
    path: "/",
    import: { environment: "staging", path: "/shared" },
  });
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-infisical-"));
}, 300_000);

afterAll(async () => {
  if (port) compose("down", "-v", "--remove-orphans");
  if (cwd) await fs.rm(cwd, { recursive: true, force: true });
}, 120_000);

describe("infisical() on a self-hosted Infisical", () => {
  it("reads a missing name as undefined, creates it, and updates it", async () => {
    const secrets = asWriter();
    const first = '{"keyId":"ABC123","issuerId":"i","p8":"-----BEGIN-----"}';
    const second = '{"keyId":"DEF456","issuerId":"i","p8":"-----BEGIN-----"}';

    expect({ ...(await secrets.get(["asc-api-key"], { cwd })) }).toEqual({
      "asc-api-key": undefined,
    });
    expect(await oracle("asc-api-key")).toBeUndefined();

    await secrets.set("asc-api-key", first, { cwd });
    expect(await oracle("asc-api-key")).toBe(first);
    expect({
      ...(await secrets.get(["asc-api-key", "release-keystore"], { cwd })),
    }).toEqual({ "asc-api-key": first, "release-keystore": undefined });

    await secrets.set("asc-api-key", second, { cwd });
    expect(await oracle("asc-api-key")).toBe(second);
  });

  it("reads back exactly a PEM, JSON with ${, and a base64 keystore", async () => {
    const secrets = asWriter();
    const values = {
      "bundle-signing-key":
        "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n",
      "play-service-account": '{"note":"${NOT_A_REFERENCE} ${prod.X}"}',
      "release-keystore": JSON.stringify({
        keystore: Buffer.alloc(8 * 1024, 7).toString("base64"),
        storePassword: "p",
        keyAlias: "upload",
        keyPassword: "p",
      }),
    };

    for (const [name, value] of Object.entries(values)) {
      await secrets.set(name, value, { cwd });
    }

    expect({ ...(await secrets.get(Object.keys(values), { cwd })) }).toEqual(
      values,
    );
    for (const [name, value] of Object.entries(values)) {
      expect(await oracle(name)).toBe(value);
    }
  });

  it("trims a value's surrounding whitespace, which set refuses for that reason", async () => {
    // The rule set() refuses by, checked on the server itself.
    for (const [value, stored] of [
      [" lead", "lead"],
      ["trail \n", "trail\n"],
      ["two\n\n", "two\n"],
      ["inner  \nkept", "inner  \nkept"],
    ] as const) {
      const name = `WHITESPACE_${crypto.randomUUID().slice(0, 8)}`;
      await asAdmin("POST", `/api/v4/secrets/${name}`, {
        projectId,
        environment: "prod",
        secretPath: "/",
        secretValue: value,
      });
      expect(await oracle(name)).toBe(stored);
    }

    await expect(asWriter().set("lead", " lead", { cwd })).rejects.toThrow(
      "Infisical trims whitespace around a value.",
    );
    expect(await oracle("lead")).toBeUndefined();
  });

  it("refuses a body over 1 MiB, as set() does before sending", async () => {
    const response = await fetch(`${site}/api/v4/secrets/TOO_LARGE`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        environment: "prod",
        secretPath: "/",
        secretValue: "A".repeat(1024 * 1024),
      }),
    });
    expect(response.status).toBe(413);

    await expect(
      asWriter().set("TOO_LARGE", "A".repeat(1024 * 1024), { cwd }),
    ).rejects.toThrow("Infisical takes requests up to 1 MiB.");
  });

  it("keeps secrets in the folder path names", async () => {
    await asWriter({ path: "/hot-updater" }).set("in-folder", "folder-value", {
      cwd,
    });

    expect(await oracle("in-folder", "/hot-updater")).toBe("folder-value");
    expect(await oracle("in-folder")).toBeUndefined();
    expect({
      ...(await asReader({ path: "hot-updater/" }).get(["in-folder"], { cwd })),
    }).toEqual({ "in-folder": "folder-value" });
  });

  it("reads as a Viewer, and refuses its writes without creating anything", async () => {
    await asWriter().set("viewer-check", "kept", { cwd });
    const secrets = asReader();

    expect({ ...(await secrets.get(["viewer-check"], { cwd })) }).toEqual({
      "viewer-check": "kept",
    });
    await expect(
      secrets.set("viewer-check", "changed", { cwd }),
    ).rejects.toThrow("does not let the identity update viewer-check");
    await expect(secrets.set("viewer-new", "created", { cwd })).rejects.toThrow(
      "does not let the identity create viewer-new",
    );
    expect(await oracle("viewer-check")).toBe("kept");
    expect(await oracle("viewer-new")).toBeUndefined();
  });

  it("reads a name an imported folder holds", async () => {
    expect({
      ...(await asReader().get(["IMPORTED_ONLY", "NOT_ANYWHERE"], { cwd })),
    }).toEqual({ IMPORTED_ONLY: "from-import", NOT_ANYWHERE: undefined });
  });

  it.each([
    ["environment", { environment: "nope" }],
    ["folder", { path: "/nope" }],
    ["project", { projectId: "00000000-0000-0000-0000-000000000000" }],
  ])(
    "throws for a missing %s instead of reading undefined",
    async (_, options) => {
      await expect(
        asReader(options).get(["asc-api-key"], { cwd }),
      ).rejects.toThrow("(404)");
    },
  );

  it("reports a wrong client secret (401) and a malformed token (403) as rejected credentials", async () => {
    const wrongSecret = adapter({
      method: "universal-auth",
      clientId: writer.clientId,
      clientSecret: "wrong-client-secret",
    });
    await expect(wrongSecret.get(["a"], { cwd })).rejects.toThrow(
      `Infisical at ${site} rejected the credentials to sign in with Universal Auth (401)`,
    );
    expect(maskSecretValues("wrong-client-secret")).not.toContain("wrong");

    await expect(
      adapter({ method: "token", token: "garbage" }).get(["a"], { cwd }),
    ).rejects.toThrow(
      `Infisical at ${site} rejected the credentials to list the secrets (403)`,
    );
  });

  it("signs in from .env.hotupdater and stores a project's deploy credentials there", async () => {
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-infisical-env-"),
    );
    try {
      await fs.writeFile(
        path.join(project, ".env.hotupdater"),
        [
          `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=${writer.clientId}`,
          `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=${writer.clientSecret}`,
          "HOT_UPDATER_API_KEY=hu_live_example",
          "CLOUDFLARE_API_TOKEN=cf-token-example",
          "",
        ].join("\n"),
      );
      const secrets = infisical({
        siteUrl: site,
        projectId,
        environment: "prod",
      });

      await expect(
        storeEnvFileSecrets(
          secrets,
          ["CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"],
          project,
        ),
      ).resolves.toEqual(["CLOUDFLARE_API_TOKEN", "HOT_UPDATER_API_KEY"]);

      expect(await oracle("HOT_UPDATER_API_KEY")).toBe("hu_live_example");
      expect(await oracle("CLOUDFLARE_API_TOKEN")).toBe("cf-token-example");
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
