import { maskSecretValues } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { googleSecretManager } from "./googleSecretManager";

const API = "https://secretmanager.googleapis.com/v1/";
const TOKEN = "ya29.spec-access-token-gsm";
const context = { cwd: "/project" };

// Castagnoli CRC, independent of the adapter's: "123456789" is 0xE3069283.
const crc32c = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface FakeVersion {
  id: number;
  state: "ENABLED" | "DISABLED" | "DESTROYED";
  data: Buffer;
}

interface FakeSecret {
  versions: FakeVersion[];
  annotations: Record<string, string>;
  etag: number;
  /** Reads of `latest` that still resolve to the version before the newest. */
  staleReads: number;
}

const emptySecret = (): FakeSecret => ({
  versions: [],
  annotations: {},
  etag: 1,
  staleReads: 0,
});

const googleError = (code: number, status: string, message: string) =>
  Response.json({ error: { code, status, message } }, { status: code });

/**
 * Secret Manager's REST API over an in-memory store, which the specs read
 * to check what the adapter did.
 */
const createFakeSecretManager = () => {
  const secrets = new Map<string, FakeSecret>();
  const state = {
    permissions: [
      "secretmanager.versions.add",
      "secretmanager.versions.access",
      "secretmanager.versions.destroy",
      "secretmanager.secrets.update",
    ],
    failDestroy: new Set<number>(),
    failPatch: false,
    raceCreate: false,
    /** How many reads of `latest` lag behind each new version. */
    latestLag: 0,
    /** Runs once before the next PATCH, as another writer would. */
    beforePatch: undefined as (() => void) | undefined,
  };
  const requests: { method: string; url: string; init: RequestInit }[] = [];

  const addVersion = (secret: FakeSecret, data: Buffer) => {
    const version: FakeVersion = {
      id: secret.versions.length + 1,
      state: "ENABLED",
      data,
    };
    secret.versions.push(version);
    secret.staleReads = state.latestLag;
    return version;
  };

  const fetchMock = vi.fn(
    async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      requests.push({ method, url, init });
      if (!url.startsWith(API)) throw new Error(`unexpected ${url}`);
      const headers = new Headers(init.headers);
      if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return googleError(401, "UNAUTHENTICATED", "Invalid credentials.");
      }
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const path = new URL(url);
      const match =
        /^\/v1\/projects\/([^/]+)\/secrets(?:\/([^/:]+))?(?:\/versions\/([^/:]+))?(?::(\w+))?$/u.exec(
          path.pathname,
        );
      if (!match) throw new Error(`unexpected path ${path.pathname}`);
      const [, project, id, version, verb] = match;
      const key = `${project}/${id}`;
      const secret = secrets.get(key);

      if (!id && method === "POST") {
        const newId = path.searchParams.get("secretId") as string;
        expect(body).toEqual({ replication: { automatic: {} } });
        if (state.raceCreate) {
          secrets.set(`${project}/${newId}`, emptySecret());
          return googleError(409, "ALREADY_EXISTS", "Secret already exists.");
        }
        if (secrets.has(`${project}/${newId}`)) {
          return googleError(409, "ALREADY_EXISTS", "Secret already exists.");
        }
        secrets.set(`${project}/${newId}`, emptySecret());
        return Response.json({
          name: `projects/${project}/secrets/${newId}`,
          etag: '"1"',
        });
      }
      if (!secret) {
        return googleError(404, "NOT_FOUND", `Secret [${key}] not found.`);
      }
      if (version === "latest" && verb === "access") {
        let latest = secret.versions.at(-1);
        if (secret.staleReads > 0) {
          secret.staleReads -= 1;
          latest = secret.versions.at(-2);
        }
        if (!latest) return googleError(404, "NOT_FOUND", "No versions.");
        if (latest.state !== "ENABLED") {
          return googleError(400, "FAILED_PRECONDITION", "Not enabled.");
        }
        return Response.json({
          name: `projects/${project}/secrets/${id}/versions/${latest.id}`,
          payload: {
            data: latest.data.toString("base64"),
            dataCrc32c: String(crc32c(latest.data)),
          },
        });
      }
      if (version && verb === "destroy") {
        const target = secret.versions.find(
          (entry) => entry.id === Number(version),
        );
        if (!target) return googleError(404, "NOT_FOUND", "No version.");
        if (state.failDestroy.has(target.id)) {
          return googleError(503, "UNAVAILABLE", "Try again.");
        }
        if (target.state === "DESTROYED") {
          return googleError(400, "FAILED_PRECONDITION", "Destroyed.");
        }
        target.state = "DESTROYED";
        target.data = Buffer.alloc(0);
        return Response.json({ state: "DESTROYED" });
      }
      if (verb === "testIamPermissions") {
        return Response.json({
          permissions: body.permissions.filter((name: string) =>
            state.permissions.includes(name),
          ),
        });
      }
      if (verb === "addVersion") {
        const data = Buffer.from(body.payload.data, "base64");
        expect(Number(body.payload.dataCrc32c)).toBe(crc32c(data));
        const added = addVersion(secret, data);
        return Response.json({
          name: `projects/${project}/secrets/${id}/versions/${added.id}`,
          state: "ENABLED",
        });
      }
      if (method === "GET") {
        return Response.json({
          name: `projects/${project}/secrets/${id}`,
          etag: `"${secret.etag}"`,
          annotations: secret.annotations,
        });
      }
      if (method === "PATCH") {
        expect(path.searchParams.get("updateMask")).toBe("annotations");
        if (state.failPatch) {
          return googleError(403, "PERMISSION_DENIED", "Denied.");
        }
        const concurrent = state.beforePatch;
        state.beforePatch = undefined;
        concurrent?.();
        expect(body.etag).toMatch(/^"\d+"$/u);
        if (body.etag !== `"${secret.etag}"`) {
          return googleError(400, "FAILED_PRECONDITION", "Etag mismatch.");
        }
        secret.etag += 1;
        secret.annotations = body.annotations;
        return Response.json({ annotations: secret.annotations });
      }
      throw new Error(`unhandled ${method} ${url}`);
    },
  );

  return {
    fetchMock,
    requests,
    state,
    secrets,
    /** A version added outside the adapter, such as in the Cloud Console. */
    addUserVersion: (key: string, value: string) =>
      addVersion(secrets.get(key) as FakeSecret, Buffer.from(value)),
    createSecret: (key: string) => secrets.set(key, emptySecret()),
    enabled: (key: string) =>
      secrets
        .get(key)
        ?.versions.filter((entry) => entry.state !== "DESTROYED")
        .map((entry) => entry.id),
  };
};

let fake: ReturnType<typeof createFakeSecretManager>;

beforeEach(() => {
  fake = createFakeSecretManager();
  vi.stubGlobal("fetch", fake.fetchMock);
  vi.stubEnv("CLOUDSDK_AUTH_ACCESS_TOKEN", TOKEN);
  vi.stubEnv("GOOGLE_OAUTH_ACCESS_TOKEN", "");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("googleSecretManager get", () => {
  it("reads each name's latest version, and undefined for a missing secret", async () => {
    fake.createSecret("demo-project/hu-asc-api-key");
    fake.addUserVersion("demo-project/hu-asc-api-key", "old");
    fake.addUserVersion(
      "demo-project/hu-asc-api-key",
      '{"keyId":"K","p8":"🔑"}',
    );
    const secrets = googleSecretManager({
      project: "demo-project",
      prefix: "hu-",
    });

    await expect(
      secrets.get(["asc-api-key", "release-keystore"], context),
    ).resolves.toEqual({
      "asc-api-key": '{"keyId":"K","p8":"🔑"}',
      "release-keystore": undefined,
    });
    expect(fake.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${API}projects/demo-project/secrets/hu-asc-api-key/versions/latest:access`,
      `GET ${API}projects/demo-project/secrets/hu-release-keystore/versions/latest:access`,
    ]);
    for (const { init } of fake.requests) {
      expect(init.redirect).toBe("error");
    }
    expect(maskSecretValues(TOKEN)).toBe("********");
  });

  it("refuses a payload whose checksum does not match", async () => {
    fake.fetchMock.mockResolvedValueOnce(
      Response.json({
        payload: {
          data: Buffer.from("value").toString("base64"),
          dataCrc32c: "1",
        },
      }),
    );

    await expect(
      googleSecretManager({ project: "demo-project" }).get(["name"], context),
    ).rejects.toThrow("checksum that does not match");
  });

  it("checks names and the project before any request", async () => {
    await expect(
      googleSecretManager({ project: "demo-project" }).get(
        ["deploy.credentials"],
        context,
      ),
    ).rejects.toThrow(
      'Secret Manager\'s IDs take only letters, digits, "-", and "_"',
    );
    await expect(
      googleSecretManager({ project: "Demo Project" }).get(["name"], context),
    ).rejects.toThrow("project ID or number");
    await expect(
      googleSecretManager({ project: "demo-project", prefix: "a/b" }).get(
        ["name"],
        context,
      ),
    ).rejects.toThrow("prefix takes letters");
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      googleError(
        403,
        "PERMISSION_DENIED",
        "Permission 'secretmanager.versions.access' denied for resource.",
      ),
      "(403 PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied for resource.). The Google identity needs roles/secretmanager.secretAccessor on the secret.",
    ],
    [
      Response.json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Secret Manager API has not been used in project 1.",
            details: [{ reason: "SERVICE_DISABLED" }],
          },
        },
        { status: 403 },
      ),
      "Enable the Secret Manager API (secretmanager.googleapis.com)",
    ],
    [
      googleError(401, "UNAUTHENTICATED", "Invalid credentials."),
      "gcloud auth application-default login",
    ],
    [
      googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded."),
      "quota is exhausted",
    ],
    [new Response("bad gateway", { status: 502 }), "(502)."],
  ])(
    "maps a failed read to an error without the token",
    async (response, message) => {
      fake.fetchMock.mockResolvedValueOnce(response);

      const error = await googleSecretManager({ project: "demo-project" })
        .get(["name"], context)
        .catch((caught: unknown) => caught as Error);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(
        "googleSecretManager could not read projects/demo-project/secrets/name",
      );
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(TOKEN);
    },
  );

  it("describes where a name is kept", () => {
    expect(
      googleSecretManager({
        project: "demo-project",
        prefix: "hu-",
      }).describe?.("asc-api-key"),
    ).toBe(
      "projects/demo-project/secrets/hu-asc-api-key (https://console.cloud.google.com/security/secret-manager/secret/hu-asc-api-key/versions?project=demo-project)",
    );
  });
});

describe("googleSecretManager set", () => {
  const key = "demo-project/asc-api-key";

  it("creates the secret, adds a version, and reads it back", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });

    await secrets.set?.("asc-api-key", '{"p8":"one"}', context);

    expect(fake.enabled(key)).toEqual([1]);
    expect(fake.secrets.get(key)?.annotations).toEqual({
      "hot-updater-versions": "1",
    });
    await expect(secrets.get(["asc-api-key"], context)).resolves.toEqual({
      "asc-api-key": '{"p8":"one"}',
    });
  });

  it("destroys only the versions it added before, never another version", async () => {
    fake.createSecret(key);
    fake.addUserVersion(key, "added in the Cloud Console");
    fake.secrets.get(key)!.annotations = { team: "mobile" };
    const secrets = googleSecretManager({ project: "demo-project" });

    await secrets.set?.("asc-api-key", "two", context);
    fake.addUserVersion(key, "added with gcloud");
    await secrets.set?.("asc-api-key", "four", context);
    await secrets.set?.("asc-api-key", "five", context);

    // 1 and 3 were added by others; 2 and 4 were replaced by the adapter.
    expect(fake.enabled(key)).toEqual([1, 3, 5]);
    expect(fake.secrets.get(key)?.annotations).toEqual({
      team: "mobile",
      "hot-updater-versions": "5",
    });
    await expect(secrets.get(["asc-api-key"], context)).resolves.toEqual({
      "asc-api-key": "five",
    });
  });

  it("keeps a version it could not destroy listed for the next set", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    fake.state.failDestroy.add(1);

    await secrets.set?.("asc-api-key", "two", context);
    expect(fake.enabled(key)).toEqual([1, 2]);
    expect(fake.secrets.get(key)?.annotations["hot-updater-versions"]).toBe(
      "2,1",
    );

    fake.state.failDestroy.clear();
    await secrets.set?.("asc-api-key", "three", context);
    expect(fake.enabled(key)).toEqual([3]);
  });

  it("keeps a version listed when its destroy request fails to connect", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    const fetchFake = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/versions/1:destroy")) {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return fetchFake(input, init);
    });

    await secrets.set?.("asc-api-key", "two", context);

    expect(fake.enabled(key)).toEqual([1, 2]);
    expect(fake.secrets.get(key)?.annotations["hot-updater-versions"]).toBe(
      "2,1",
    );
  });

  it("treats a version destroyed by someone else as destroyed", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    fake.secrets.get(key)!.versions[0]!.state = "DESTROYED";

    await secrets.set?.("asc-api-key", "two", context);

    expect(fake.secrets.get(key)?.annotations["hot-updater-versions"]).toBe(
      "2",
    );
  });

  it("reads the secret another run created first", async () => {
    fake.state.raceCreate = true;

    await googleSecretManager({ project: "demo-project" }).set?.(
      "asc-api-key",
      "one",
      context,
    );

    expect(fake.enabled(key)).toEqual([1]);
  });

  it("checks its permissions before it writes anything", async () => {
    fake.state.permissions = ["secretmanager.versions.add"];

    await expect(
      googleSecretManager({ project: "demo-project" }).set?.(
        "asc-api-key",
        "one",
        context,
      ),
    ).rejects.toThrow(
      "lacks secretmanager.versions.access, secretmanager.versions.destroy, secretmanager.secrets.update on it: grant roles/secretmanager.editor and roles/secretmanager.secretAccessor",
    );
    expect(fake.enabled(key)).toEqual([]);
    expect(fake.requests.some(({ url }) => url.endsWith(":addVersion"))).toBe(
      false,
    );
  });

  it("names the stored version when listing it fails to connect", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    const fetchFake = fake.fetchMock.getMockImplementation()!;
    fake.fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return fetchFake(input, init);
    });

    await expect(secrets.set?.("asc-api-key", "two", context)).rejects.toThrow(
      "googleSecretManager could not list version 2, which it stored, in projects/demo-project/secrets/asc-api-key's hot-updater-versions annotation, so the next set will not destroy it (fetch failed: ECONNRESET).",
    );
  });

  it("names the stored version when it cannot list it", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    fake.state.failPatch = true;

    await expect(secrets.set?.("asc-api-key", "two", context)).rejects.toThrow(
      "could not list version 2, which it stored, in projects/demo-project/secrets/asc-api-key's hot-updater-versions annotation",
    );
    await expect(secrets.get(["asc-api-key"], context)).resolves.toEqual({
      "asc-api-key": "two",
    });
  });
  it("waits for latest to resolve to the new version before it destroys the old one", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    fake.state.latestLag = 2;

    await secrets.set?.("asc-api-key", "two", context);

    const latestReads = fake.requests.filter(({ url }) =>
      url.endsWith("/versions/latest:access"),
    );
    // One read for the first set, three for the second: two stale.
    expect(latestReads).toHaveLength(4);
    expect(fake.enabled(key)).toEqual([2]);
  });

  it("reads again while latest still names a disabled version", async () => {
    fake.createSecret(key);
    fake.addUserVersion(key, "revoked").state = "DISABLED";
    fake.state.latestLag = 1;
    const secrets = googleSecretManager({ project: "demo-project" });

    await secrets.set?.("asc-api-key", "two", context);

    expect(fake.secrets.get(key)?.annotations["hot-updater-versions"]).toBe(
      "2",
    );
    await expect(secrets.get(["asc-api-key"], context)).resolves.toEqual({
      "asc-api-key": "two",
    });
  });

  it("keeps every version when latest never resolves to the new one", async () => {
    vi.useFakeTimers();
    try {
      const secrets = googleSecretManager({ project: "demo-project" });
      const first = secrets.set?.("asc-api-key", "one", context);
      await vi.runAllTimersAsync();
      await first;
      fake.state.latestLag = 1000;

      const second = secrets.set?.("asc-api-key", "two", context).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      await vi.runAllTimersAsync();

      expect((await second)?.message).toBe(
        "googleSecretManager stored projects/demo-project/secrets/asc-api-key as version 2, and its latest alias does not resolve to that version yet, so it kept the versions it added before; the next set destroys them.",
      );
      expect(fake.enabled(key)).toEqual([1, 2]);
      expect(fake.secrets.get(key)?.annotations["hot-updater-versions"]).toBe(
        "2,1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the versions a concurrent set listed", async () => {
    const secrets = googleSecretManager({ project: "demo-project" });
    await secrets.set?.("asc-api-key", "one", context);
    // Another run adds version 3 and lists it while this run adds version 2.
    fake.state.beforePatch = () => {
      const secret = fake.secrets.get(key)!;
      fake.addUserVersion(key, "three");
      secret.annotations = {
        ...secret.annotations,
        "hot-updater-versions": "3",
        team: "mobile",
      };
      secret.etag += 1;
    };

    await secrets.set?.("asc-api-key", "two", context);
    expect(fake.secrets.get(key)?.annotations).toEqual({
      "hot-updater-versions": "2,3",
      team: "mobile",
    });

    await secrets.set?.("asc-api-key", "four", context);
    expect(fake.enabled(key)).toEqual([4]);
  });
});
