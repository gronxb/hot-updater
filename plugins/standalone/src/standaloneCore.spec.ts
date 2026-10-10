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

  it("checks the protocol once and reads with protocol 2 parameters", async () => {
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
      v: "2",
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
});
