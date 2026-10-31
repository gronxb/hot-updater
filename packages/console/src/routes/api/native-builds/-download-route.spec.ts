// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadNativeBuildMock, loadConsoleMock, prepareConfigMock } =
  vi.hoisted(() => ({
    downloadNativeBuildMock: vi.fn(),
    loadConsoleMock: vi.fn(),
    prepareConfigMock: vi.fn(),
  }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  default: undefined,
}));
vi.mock("@/lib/server/config.server", () => ({
  loadConsole: loadConsoleMock,
  prepareConfig: prepareConfigMock,
}));
vi.mock("@/lib/server/nativeBuilds", () => ({
  downloadNativeBuild: downloadNativeBuildMock,
}));

import {
  CONSOLE_SECRET_ENV,
  createNativeBuildDownloadToken,
} from "@/lib/server/nativeBuildDownloadLink";

import { Route } from "./$buildId/download";

type DownloadHandler = (input: {
  readonly params: { readonly buildId: string };
  readonly request: Request;
}) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly GET: DownloadHandler } };
    };
  }
).options.server.handlers.GET;

const BUILD = "019a0000-0000-7000-8000-00000000b001";
const url = `https://console.example.com/api/native-builds/${BUILD}/download`;

const SECRET = "a-console-secret-of-at-least-32-characters";
const OTHER_BUILD = "019a0000-0000-7000-8000-00000000b002";
const signed = (token: string, id = BUILD) =>
  `https://console.example.com/api/native-builds/${id}/download?t=${encodeURIComponent(token)}`;
const tokenFor = (id: string, expiresInMs = 60_000, secret = SECRET) =>
  createNativeBuildDownloadToken(secret, id, Date.now() + expiresInMs);

const denied = (status: 401 | 403) =>
  prepareConfigMock.mockRejectedValueOnce(
    new Response(status === 401 ? "Unauthorized" : "Forbidden", { status }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(CONSOLE_SECRET_ENV, SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("native build download route", () => {
  it("redirects a signed-in caller to the storage, resolved per request", async () => {
    const deps = { core: {}, storage: {} };
    prepareConfigMock.mockResolvedValueOnce(deps);
    downloadNativeBuildMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://r2.example.com/app.apk?sig=1" },
      }),
    );

    const response = await handler({
      params: { buildId: BUILD },
      request: new Request(url),
    });

    expect(response.status).toBe(302);
    expect(downloadNativeBuildMock).toHaveBeenCalledWith(BUILD, deps);
  });

  it("sends a browser without a session to the build's page, to sign in and come back to the download, under the console's path", async () => {
    const navigations: Record<string, string>[] = [
      { "sec-fetch-mode": "navigate" },
      { accept: "text/html,application/xhtml+xml" },
    ];
    for (const headers of navigations) {
      denied(401);
      const response = await handler({
        params: { buildId: BUILD },
        request: new Request(url, { headers }),
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      // Relative to the route, so it never leaves the console, and the
      // page's returnTo, relative to the page, is this download.
      for (const download of [
        url,
        `https://example.com/console/api/native-builds/${BUILD}/download`,
      ]) {
        const page = new URL(location, download);
        expect(`${page.origin}${page.pathname}`).toBe(
          download.replace(
            `/api/native-builds/${BUILD}/download`,
            `/native-builds/${BUILD}`,
          ),
        );
        expect(new URL(page.searchParams.get("returnTo")!, page).href).toBe(
          download,
        );
      }
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(downloadNativeBuildMock).not.toHaveBeenCalled();
  });

  it("keeps a script's 401, and a signed-in caller's 403, without touching storage", async () => {
    denied(401);
    await expect(
      handler({
        params: { buildId: BUILD },
        request: new Request(url, { headers: { accept: "*/*" } }),
      }),
    ).rejects.toMatchObject({ status: 401 });
    denied(403);
    await expect(
      handler({
        params: { buildId: BUILD },
        request: new Request(url, {
          headers: { "sec-fetch-mode": "navigate" },
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(downloadNativeBuildMock).not.toHaveBeenCalled();
  });

  describe("with a signed link", () => {
    it("downloads without asking for a session", async () => {
      const deps = { core: {}, storage: {} };
      const answer = new Response(null, {
        status: 302,
        headers: { location: "https://r2.example.com/app.apk?sig=1" },
      });
      loadConsoleMock.mockResolvedValueOnce(deps);
      downloadNativeBuildMock.mockResolvedValueOnce(answer);
      const request = new Request(signed(await tokenFor(BUILD)));

      const response = await handler({ params: { buildId: BUILD }, request });

      expect(response).toBe(answer);
      expect(prepareConfigMock).not.toHaveBeenCalled();
      expect(loadConsoleMock).toHaveBeenCalledWith(request);
      expect(downloadNativeBuildMock).toHaveBeenCalledWith(BUILD, deps);
    });

    it("gives 403 for an expired, tampered, or other build's token, for a script and a browser alike, and reaches nothing", async () => {
      const valid = await tokenFor(BUILD);
      const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
      const tokens = [
        await tokenFor(BUILD, -1_000),
        tampered,
        await tokenFor(OTHER_BUILD),
        await tokenFor(BUILD, 60_000, `${SECRET}-other`),
        "",
        "not-a-token",
      ];
      for (const token of tokens) {
        for (const headers of [
          { accept: "*/*" },
          { "sec-fetch-mode": "navigate" },
        ] as Record<string, string>[]) {
          const response = await handler({
            params: { buildId: BUILD },
            request: new Request(signed(token), { headers }),
          });

          expect(response.status).toBe(403);
          expect(response.headers.get("location")).toBeNull();
          expect(response.headers.get("cache-control")).toBe("no-store");
          if (token) expect(await response.text()).not.toContain(token);
        }
      }
      expect(loadConsoleMock).not.toHaveBeenCalled();
      expect(prepareConfigMock).not.toHaveBeenCalled();
      expect(downloadNativeBuildMock).not.toHaveBeenCalled();
    });

    it("binds the route's build, so a token moved to another build's URL is refused", async () => {
      const response = await handler({
        params: { buildId: OTHER_BUILD },
        request: new Request(signed(await tokenFor(BUILD), OTHER_BUILD)),
      });

      expect(response.status).toBe(403);
      expect(downloadNativeBuildMock).not.toHaveBeenCalled();
    });

    it("gives 403 on a Console without the secret, whatever the token", async () => {
      const token = await tokenFor(BUILD);
      vi.stubEnv(CONSOLE_SECRET_ENV, "");

      const response = await handler({
        params: { buildId: BUILD },
        request: new Request(signed(token)),
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toContain(CONSOLE_SECRET_ENV);
      expect(downloadNativeBuildMock).not.toHaveBeenCalled();
    });
  });

  it("logs no token, on a refusal or a download", async () => {
    const logged = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const valid = await tokenFor(BUILD);
    loadConsoleMock.mockResolvedValueOnce({});
    downloadNativeBuildMock.mockResolvedValueOnce(new Response(null));

    for (const token of [valid, `${valid}x`]) {
      await handler({
        params: { buildId: BUILD },
        request: new Request(signed(token)),
      });
    }

    for (const spy of logged) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(valid);
      spy.mockRestore();
    }
  });
});
