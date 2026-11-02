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

import { Route } from "./preview-qr";

type Handler = (input: { readonly request: Request }) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly ANY: Handler } };
    };
  }
).options.server.handlers.ANY;

describe("sandbox preview QR route", () => {
  it("serves the link's QR code without a session or any read", async () => {
    const fingerprint = "b".repeat(40);
    const response = await handler({
      request: new Request(
        `https://console.example.com/_hot-updater/native-builds/preview-qr?app=com.example.app&channel=pr-12&fingerprint=${fingerprint}`,
      ),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-preview-link")).toBe(
      `hu-sandbox-com-example-app://hot-updater/preview?channel=pr-12&fingerprint=${fingerprint}`,
    );
    expect(loadConsoleMock).not.toHaveBeenCalled();
    expect(prepareConfigMock).not.toHaveBeenCalled();
  });

  it("refuses a request that isn't a sandbox link's parts", async () => {
    const response = await handler({
      request: new Request(
        "https://console.example.com/_hot-updater/native-builds/preview-qr?app=com.example.app&channel=pr-12&fingerprint=not%20a%20hash",
      ),
    });

    expect(response.status).toBe(400);
    expect(loadConsoleMock).not.toHaveBeenCalled();
  });
});
