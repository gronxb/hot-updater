import { ReleaseManagementError } from "@hot-updater/plugin-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createStandaloneCoreApi } from "./standaloneCore";
import { StandaloneDatabaseError } from "./standaloneHttp";

const BASE_URL = "http://localhost/hot-updater/admin";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const version = (adminProtocol?: number) =>
  http.get(`${BASE_URL}/version`, () =>
    HttpResponse.json(
      adminProtocol === undefined
        ? {}
        : { version: "1.0.0", adminProtocol, plugins: [] },
    ),
  );

const PROTOCOL_REFUSAL = `The server at ${BASE_URL} does not report Hot Updater admin API protocol 2 at /version. Set baseUrl to the path where the server mounts handlers.admin, such as https://example.com/hot-updater/admin.`;

describe("createStandaloneCoreApi", () => {
  it("refuses a baseUrl whose /version answers 404 before any read", async () => {
    let read = false;
    server.use(
      http.get(
        `${BASE_URL}/version`,
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(`${BASE_URL}/release-catalogs`, () => {
        read = true;
        return HttpResponse.json({ data: [] });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.ready()).rejects.toThrow(PROTOCOL_REFUSAL);
    expect(read).toBe(false);
  });

  it("refuses a /version without adminProtocol", async () => {
    server.use(version());
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    const refused = core.listChannels();
    await expect(refused).rejects.toBeInstanceOf(StandaloneDatabaseError);
    await expect(refused).rejects.toThrow(PROTOCOL_REFUSAL);
  });

  it("refuses a baseUrl at the client mount, whose /version lists no plugins, before any read", async () => {
    let read = false;
    server.use(
      http.get(`${BASE_URL}/version`, () =>
        HttpResponse.json({
          adminProtocol: 2,
          infrastructureGeneration: 1,
          version: "1.0.0",
        }),
      ),
      http.get(`${BASE_URL}/channels`, () => {
        read = true;
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.listChannels()).rejects.toThrow(
      `The server at ${BASE_URL} answered /version as its client mount, without the plugins list of handlers.admin.`,
    );
    expect(read).toBe(false);
  });

  it("checks the protocol once and pages by key", async () => {
    let versionChecks = 0;
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${BASE_URL}/version`, () => {
        versionChecks += 1;
        return HttpResponse.json({
          version: "1.0.0",
          adminProtocol: 2,
          plugins: [],
        });
      }),
      http.get(`${BASE_URL}/release-catalogs`, ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json({ data: [] });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await core.ready();
    await core.listReleaseCatalogs({ limit: 20, order: "desc", after: "k" });

    expect(versionChecks).toBe(1);
    expect(Object.fromEntries(queries[1]!)).toEqual({
      limit: "20",
      order: "desc",
      cursor: "k",
    });
  });

  it("names migrations when the server's schema fence answers 503", async () => {
    server.use(
      version(2),
      http.get(`${BASE_URL}/release-catalogs`, () =>
        HttpResponse.json({ error: "Service unavailable" }, { status: 503 }),
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.ready()).rejects.toThrow("hot-updater db migrate");
  });

  it("throws the refusal core names, as in process", async () => {
    server.use(
      version(2),
      http.post(`${BASE_URL}/releases/:id/promote`, () =>
        HttpResponse.json(
          {
            code: "VERSION_CONFLICT",
            error: "The release changed; reload it and retry.",
          },
          { status: 409 },
        ),
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    const refusal = core.promoteRelease({
      expectedRevision: 1,
      releaseId: "release-1",
      targetChannel: "beta",
    });
    await expect(refusal).rejects.toBeInstanceOf(ReleaseManagementError);
    await expect(refusal).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("asks for a server upgrade when the server has no native build routes", async () => {
    server.use(
      version(2),
      http.all(
        `${BASE_URL}/native-builds*`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });
    const upgrade = `The server at ${BASE_URL} has no native build route`;

    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: "fingerprint",
        appVersion: null,
      }),
    ).rejects.toThrow(upgrade);
    await expect(
      core.registerNativeBuild(
        {} as Parameters<typeof core.registerNativeBuild>[0],
      ),
    ).rejects.toThrow(upgrade);
    await expect(core.getNativeBuild("build-1")).rejects.toThrow(upgrade);
    await expect(core.deleteNativeBuild("build-1")).rejects.toThrow(
      `The server at ${BASE_URL} has no native build deletion route`,
    );
    // Such a server holds no native builds, so doctor's scan finds none.
    await expect(core.listNativeBuilds({ limit: 10 })).resolves.toEqual([]);
  });

  it("deletes a native build by ID, and answers an unknown ID as not_found", async () => {
    const deleted: string[] = [];
    server.use(
      version(2),
      http.delete(`${BASE_URL}/native-builds/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({
          data:
            params.id === "build-1"
              ? { deleted: true, nativeBuild: { id: "build-1" } }
              : { deleted: false, reason: "not_found" },
        });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.deleteNativeBuild("build-1")).resolves.toEqual({
      deleted: true,
      nativeBuild: { id: "build-1" },
    });
    await expect(core.deleteNativeBuild("build/2")).resolves.toEqual({
      deleted: false,
      reason: "not_found",
    });
    expect(deleted).toEqual(["build-1", "build/2"]);
  });

  it("reads a native build by ID, and an unknown ID as null", async () => {
    server.use(
      version(2),
      http.get(`${BASE_URL}/native-builds/:id`, ({ params }) =>
        HttpResponse.json({
          data: params.id === "build-1" ? { id: "build-1" } : null,
        }),
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.getNativeBuild("build-1")).resolves.toEqual({
      id: "build-1",
    });
    await expect(core.getNativeBuild("build-2")).resolves.toBeNull();
  });

  it("finds a native build by scope, and reads a scope without one as null", async () => {
    const queries: Record<string, string>[] = [];
    server.use(
      version(2),
      http.get(`${BASE_URL}/native-builds/latest`, ({ request }) => {
        const query = Object.fromEntries(new URL(request.url).searchParams);
        queries.push(query);
        return HttpResponse.json({
          data: query.appVersion === undefined ? { id: "build-1" } : null,
        });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(
      core.findNativeBuild({
        platform: "ios",
        channel: "production",
        fingerprintHash: "fingerprint",
        appVersion: null,
      }),
    ).resolves.toEqual({ id: "build-1" });
    await expect(
      core.findNativeBuild({
        platform: "android",
        channel: "beta",
        fingerprintHash: null,
        appVersion: "1.0.0",
      }),
    ).resolves.toBeNull();
    expect(queries).toEqual([
      {
        platform: "ios",
        channel: "production",
        fingerprintHash: "fingerprint",
      },
      { platform: "android", channel: "beta", appVersion: "1.0.0" },
    ]);
  });

  it("finds a native build by key, and reads an answer with another key as none", async () => {
    const key = `nbk1:${"a".repeat(64)}`;
    const queries: Record<string, string>[] = [];
    let answer: unknown;
    server.use(
      version(2),
      http.get(`${BASE_URL}/native-builds/latest`, ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json({ data: answer });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });
    const scope = {
      platform: "ios",
      channel: "production",
      fingerprintHash: "fingerprint",
      appVersion: null,
    } as const;

    answer = { id: "build-1", build_key: key };
    await expect(
      core.findNativeBuild(scope, { buildKey: key }),
    ).resolves.toEqual(answer);
    // A server that predates build keys ignores the parameter and answers
    // the scope's newest build: a row without the key is no match.
    answer = { id: "build-2" };
    await expect(
      core.findNativeBuild(scope, { buildKey: key }),
    ).resolves.toBeNull();
    answer = { id: "build-3", build_key: null };
    await expect(
      core.findNativeBuild(scope, { buildKey: key }),
    ).resolves.toBeNull();
    expect(queries[0]).toEqual({
      platform: "ios",
      channel: "production",
      fingerprintHash: "fingerprint",
      buildKey: key,
    });
  });
});
