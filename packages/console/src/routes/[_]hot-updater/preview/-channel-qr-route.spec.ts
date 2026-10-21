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

import { Route } from "./channel-qr";

type Handler = (input: { readonly request: Request }) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly ANY: Handler } };
    };
  }
).options.server.handlers.ANY;

describe("channel link QR route", () => {
  it("serves the QR code without a console session, from the config's prefix", async () => {
    loadConsoleMock.mockResolvedValue({
      config: { channelLinkPrefix: "myapp://" },
    });
    const request = new Request(
      "https://console.example.com/_hot-updater/preview/channel-qr?channel=pr-12",
    );

    const response = await handler({ request });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-channel-link")).toBe(
      "myapp://hot-updater/channel/pr-12",
    );
    expect(loadConsoleMock).toHaveBeenCalledWith(request);
    expect(prepareConfigMock).not.toHaveBeenCalled();
  });
});
