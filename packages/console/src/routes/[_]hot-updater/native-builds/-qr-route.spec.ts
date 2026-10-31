// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { loadConsoleMock, prepareConfigMock } = vi.hoisted(() => ({
  loadConsoleMock: vi.fn(),
  prepareConfigMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/server/config.server", () => ({
  loadConsole: loadConsoleMock,
  prepareConfig: prepareConfigMock,
}));

import { Route } from "./qr";

type Handler = (input: { readonly request: Request }) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly ANY: Handler } };
    };
  }
).options.server.handlers.ANY;

const BUILD = "019a0000-0000-7000-8000-00000000b001";

describe("native build QR route", () => {
  it("serves the QR code of the build's console download without a session or any read", async () => {
    const request = new Request(
      `https://console.example.com/_hot-updater/native-builds/qr?build=${BUILD}`,
    );

    const response = await handler({ request });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-hot-updater-download-url")).toBe(
      `https://console.example.com/api/native-builds/${BUILD}/download`,
    );
    expect(await response.text()).toMatch(/^<svg /);
    // No config, no core, no storage: the ID is all it reads.
    expect(loadConsoleMock).not.toHaveBeenCalled();
    expect(prepareConfigMock).not.toHaveBeenCalled();
  });

  it("refuses anything but a native build ID, and methods other than GET and HEAD", async () => {
    for (const query of ["", "?build=", "?build=build-1", "?build=../x"]) {
      const response = await handler({
        request: new Request(
          `https://console.example.com/_hot-updater/native-builds/qr${query}`,
        ),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("x-hot-updater-download-url")).toBeNull();
    }
    const post = await handler({
      request: new Request(
        `https://console.example.com/_hot-updater/native-builds/qr?build=${BUILD}`,
        { method: "POST" },
      ),
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
