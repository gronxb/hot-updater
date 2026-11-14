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
    await expect(
      core.findNativeBuildByBuiltInBundle("bundle-1"),
    ).rejects.toThrow(upgrade);
    await expect(core.deleteNativeBuild("build-1")).rejects.toThrow(
      `The server at ${BASE_URL} has no native build deletion route`,
    );
    // Such a server holds no native builds, so doctor's scan finds none.
    await expect(core.listNativeBuilds({ limit: 10 })).resolves.toEqual([]);
  });

  describe("the store build mark", () => {
    const scope = {
      platform: "ios",
      channel: "production",
      fingerprintHash: "fingerprint",
      appVersion: null,
    } as const;

    it("reads the mark and writes it through the admin routes", async () => {
      const queries: string[] = [];
      const marks: unknown[] = [];
      server.use(
        version(2),
        http.get(`${BASE_URL}/native-builds/latest`, ({ request }) => {
          queries.push(new URL(request.url).search);
          return HttpResponse.json({
            data: { id: "build-1", is_store_build: true },
          });
        }),
        http.post(
          `${BASE_URL}/native-builds/:id/store-build`,
          async ({ params, request }) => {
            marks.push([params.id, await request.json()]);
            return HttpResponse.json({
              data: { nativeBuild: { id: params.id }, previous: null },
            });
          },
        ),
      );
      const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

      await expect(
        core.findNativeBuild(scope, { storeBuild: true }),
      ).resolves.toMatchObject({ id: "build-1" });
      await core.findNativeBuild(scope, { builtInOlderThan: "bundle-1" });
      await expect(
        core.markNativeBuild("build/1", { storeBuild: true }),
      ).resolves.toEqual({
        nativeBuild: { id: "build/1" },
        previous: null,
      });

      expect(queries[0]).toContain("storeBuild=true");
      expect(queries[1]).toContain("builtInOlderThan=bundle-1");
      expect(marks).toEqual([["build/1", { storeBuild: true }]]);
    });

    it("names a sandbox scope in four query parameters, and finds no build of another on a server without them", async () => {
      const queries: URLSearchParams[] = [];
      let answer: Record<string, unknown> = {
        id: "build-1",
        is_sandbox: true,
        artifact_kind: "ipa",
        sandbox_url_scheme: "acme-preview",
      };
      server.use(
        version(2),
        http.get(`${BASE_URL}/native-builds/latest`, ({ request }) => {
          queries.push(new URL(request.url).searchParams);
          return HttpResponse.json({ data: answer });
        }),
      );
      const core = createStandaloneCoreApi({ baseUrl: BASE_URL });
      const sandboxScope = {
        ...scope,
        sandbox: {
          appId: "com.example.app",
          urlScheme: "acme-preview",
          artifactKind: "ipa",
          distribution: "direct",
        },
      } as const;

      await expect(core.findNativeBuild(sandboxScope)).resolves.toMatchObject({
        id: "build-1",
      });
      expect(Object.fromEntries(queries[0]!)).toMatchObject({
        sandboxAppId: "com.example.app",
        sandboxUrlScheme: "acme-preview",
        artifactKind: "ipa",
        distribution: "direct",
      });
      // An older server ignores them and answers the channel's newest build.
      answer = { id: "build-2", is_sandbox: false, artifact_kind: "ipa" };
      await expect(core.findNativeBuild(sandboxScope)).resolves.toBeNull();
      // A normal lookup names none of them.
      await core.findNativeBuild(scope);
      expect(queries[2]!.has("sandboxAppId")).toBe(false);
    });

    it("finds no mark on a server that answers its newest build instead", async () => {
      server.use(
        version(2),
        http.get(`${BASE_URL}/native-builds/latest`, () =>
          HttpResponse.json({ data: { id: "build-1" } }),
        ),
      );
      const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

      await expect(
        core.findNativeBuild(scope, { storeBuild: true }),
      ).resolves.toBeNull();
    });

    it("asks to upgrade a server without the mark's route", async () => {
      server.use(
        version(2),
        http.post(
          `${BASE_URL}/native-builds/:id/store-build`,
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
      const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

      await expect(
        core.markNativeBuild("build-1", { storeBuild: true }),
      ).rejects.toThrow(
        `The server at ${BASE_URL} has no native build store mark route`,
      );
    });
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

  it("reads the native build that compiled in a bundle, and none as null", async () => {
    server.use(
      version(2),
      http.get(`${BASE_URL}/native-builds/built-in/:bundleId`, ({ params }) =>
        HttpResponse.json({
          data:
            params.bundleId === "bundle-1"
              ? { id: "build-1", min_bundle_id: "bundle-1" }
              : null,
        }),
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(
      core.findNativeBuildByBuiltInBundle("bundle-1"),
    ).resolves.toEqual({ id: "build-1", min_bundle_id: "bundle-1" });
    await expect(
      core.findNativeBuildByBuiltInBundle("bundle-2"),
    ).resolves.toBeNull();
  });

  it("records a native build's store submission, and asks for an upgrade on a server without the route", async () => {
    const bodies: unknown[] = [];
    server.use(
      version(2),
      http.post(
        `${BASE_URL}/native-builds/:id/submission`,
        async ({ params, request }) => {
          bodies.push(await request.json());
          return params.id === "build-1"
            ? HttpResponse.json({
                data: { id: "build-1", submitted_to: "testflight" },
              })
            : HttpResponse.json({ data: null });
        },
      ),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });
    const submission = {
      destination: "testflight",
      version: "1.7.0 (66)",
    } as const;

    await expect(
      core.recordNativeBuildSubmission("build-1", submission),
    ).resolves.toEqual({ id: "build-1", submitted_to: "testflight" });
    await expect(
      core.recordNativeBuildSubmission("build-2", submission),
    ).resolves.toBeNull();
    expect(bodies).toEqual([submission, submission]);

    server.use(
      http.post(
        `${BASE_URL}/native-builds/:id/submission`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    await expect(
      core.recordNativeBuildSubmission("build-1", submission),
    ).rejects.toThrow(
      `The server at ${BASE_URL} has no native build submission route`,
    );
  });

  it("lists a channel's native builds with the channel in the query", async () => {
    const queries: Record<string, string>[] = [];
    server.use(
      version(2),
      http.get(`${BASE_URL}/native-builds`, ({ request }) => {
        queries.push(
          Object.fromEntries(new URL(request.url).searchParams.entries()),
        );
        return HttpResponse.json({ data: [{ id: "build-1" }] });
      }),
    );
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(
      core.listNativeBuilds({
        channelId: "channel:pr-130",
        order: "desc",
        after: "build-2",
        limit: 20,
      }),
    ).resolves.toEqual([{ id: "build-1" }]);
    await core.listNativeBuilds({ limit: 5 });
    expect(queries).toEqual([
      {
        channelId: "channel:pr-130",
        order: "desc",
        cursor: "build-2",
        limit: "20",
      },
      { limit: "5" },
    ]);
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
