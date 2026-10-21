// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

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

describe("native build download route authorization", () => {
  it("does not touch storage when console access is denied", async () => {
    const request = new Request(
      "https://console.example.com/api/native-builds/build-1/download",
    );
    prepareConfigMock.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      handler({ params: { buildId: "build-1" }, request }),
    ).rejects.toMatchObject({ status: 401 });

    expect(prepareConfigMock).toHaveBeenCalledWith(request);
    expect(downloadNativeBuildMock).not.toHaveBeenCalled();
  });
});
