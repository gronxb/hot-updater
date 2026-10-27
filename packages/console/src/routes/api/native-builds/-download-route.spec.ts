// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { downloadNativeBuildMock, prepareConfigMock } = vi.hoisted(() => ({
  downloadNativeBuildMock: vi.fn(),
  prepareConfigMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/server/config.server", () => ({
  prepareConfig: prepareConfigMock,
}));
vi.mock("@/lib/server/nativeBuilds", () => ({
  downloadNativeBuild: downloadNativeBuildMock,
}));

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

const denied = (status: 401 | 403) =>
  prepareConfigMock.mockRejectedValueOnce(
    new Response(status === 401 ? "Unauthorized" : "Forbidden", { status }),
  );

beforeEach(() => vi.clearAllMocks());

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

  it("sends a browser without a session to the build's page, under the console's path", async () => {
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
      // Relative to the route, so it never leaves the console.
      expect(new URL(location, url).href).toBe(
        `https://console.example.com/native-builds/${BUILD}`,
      );
      expect(
        new URL(
          location,
          `https://example.com/console/api/native-builds/${BUILD}/download`,
        ).href,
      ).toBe(`https://example.com/console/native-builds/${BUILD}`);
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
});
