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
        ? { version: "0.30.0" }
        : { version: "1.0.0", adminProtocol },
    ),
  );

describe("createStandaloneCoreApi", () => {
  it("refuses a server older than admin API protocol 2 before any read", async () => {
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

    await expect(core.ready()).rejects.toThrow(
      `The server at ${BASE_URL} speaks admin API protocol 1, and this CLI needs 2.`,
    );
    expect(read).toBe(false);
  });

  it("refuses a server that reports an older protocol", async () => {
    server.use(version());
    const core = createStandaloneCoreApi({ baseUrl: BASE_URL });

    await expect(core.listChannels()).rejects.toBeInstanceOf(
      StandaloneDatabaseError,
    );
  });

  it("checks the protocol once and reads with protocol 2 parameters", async () => {
    let versionChecks = 0;
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${BASE_URL}/version`, () => {
        versionChecks += 1;
        return HttpResponse.json({ version: "1.0.0", adminProtocol: 2 });
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
