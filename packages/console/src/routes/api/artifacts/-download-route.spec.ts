// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { downloadBundleMock, prepareConfigMock } = vi.hoisted(() => ({
  downloadBundleMock: vi.fn(),
  prepareConfigMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/server/config.server", () => ({
  prepareConfig: prepareConfigMock,
}));
vi.mock("@/lib/server/downloadBundle", () => ({
  downloadBundle: downloadBundleMock,
}));

import { Route } from "./$artifactId/download";

type DownloadHandler = (input: {
  readonly params: { readonly artifactId: string };
  readonly request: Request;
}) => Promise<Response>;

const handler = (
  Route as unknown as {
    readonly options: {
      readonly server: { readonly handlers: { readonly GET: DownloadHandler } };
    };
  }
).options.server.handlers.GET;

describe("artifact download route authorization", () => {
  it("does not touch bundle storage when console access is denied", async () => {
    const request = new Request(
      "https://console.example.com/api/artifacts/bundle-1/download",
    );
    prepareConfigMock.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      handler({ params: { artifactId: "bundle-1" }, request }),
    ).rejects.toMatchObject({ status: 401 });

    expect(prepareConfigMock).toHaveBeenCalledWith(request);
    expect(downloadBundleMock).not.toHaveBeenCalled();
  });
});
