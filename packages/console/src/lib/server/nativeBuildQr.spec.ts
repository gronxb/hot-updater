// @vitest-environment node

import { describe, expect, it } from "vitest";

import { serveNativeBuildQr } from "./nativeBuildQr";

const BUILD = "019a0000-0000-7000-8000-00000000b001";

describe("serveNativeBuildQr", () => {
  it("keeps the console's own path in the download URL", () => {
    const response = serveNativeBuildQr(
      new Request(
        `https://example.com/console/_hot-updater/native-builds/qr?build=${BUILD}`,
      ),
    );

    expect(response.headers.get("x-hot-updater-download-url")).toBe(
      `https://example.com/console/api/native-builds/${BUILD}/download`,
    );
  });

  it("holds the build's page with target=page, under the console's own path", () => {
    const response = serveNativeBuildQr(
      new Request(
        `https://example.com/console/_hot-updater/native-builds/qr?build=${BUILD}&target=page`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-download-url")).toBe(
      `https://example.com/console/native-builds/${BUILD}`,
    );
  });

  it("answers HEAD with the URL and no image, for a probe", async () => {
    const response = serveNativeBuildQr(
      new Request(
        `https://console.example.com/_hot-updater/native-builds/qr?build=${BUILD}`,
        { method: "HEAD" },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-download-url")).toContain(
      `/api/native-builds/${BUILD}/download`,
    );
    expect(await response.text()).toBe("");
  });

  it("never holds a signed link, since anyone can ask for this image", () => {
    const response = serveNativeBuildQr(
      new Request(
        `https://console.example.com/_hot-updater/native-builds/qr?build=${BUILD}&t=1.forged`,
      ),
    );

    const url = response.headers.get("x-hot-updater-download-url")!;
    expect(new URL(url).search).toBe("");
  });
});
