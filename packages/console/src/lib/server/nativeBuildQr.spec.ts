// @vitest-environment node

import { describe, expect, it } from "vitest";

import { qrCodePath } from "../qr-code";
import { serveNativeBuildQr, serveSandboxPreviewQr } from "./nativeBuildQr";

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

describe("serveSandboxPreviewQr", () => {
  const FINGERPRINT = "a".repeat(64);
  const url = (query: Record<string, string>) =>
    `https://console.example.com/_hot-updater/native-builds/preview-qr?${new URLSearchParams(query)}`;
  const valid = {
    app: "com.Example.App_tv",
    channel: "pr-12",
    fingerprint: FINGERPRINT,
  };
  const LINK = `hu-sandbox-com-example-app-tv://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}`;

  it("holds the link the three parts make, and says so", async () => {
    const response = serveSandboxPreviewQr(new Request(url(valid)));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-preview-link")).toBe(LINK);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    const { path } = qrCodePath(LINK);
    expect(await response.text()).toContain(`d="${path}"`);
  });

  it("answers HEAD with the link and no image, for a probe", async () => {
    const response = serveSandboxPreviewQr(
      new Request(url(valid), { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-preview-link")).toBe(LINK);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["no app", { ...valid, app: "" }],
    ["an app with a URL", { ...valid, app: "https://evil.example.com" }],
    ["an app with spaces", { ...valid, app: "buy now" }],
    ["an app past its length", { ...valid, app: "a".repeat(256) }],
    ["a channel with free text", { ...valid, channel: "visit evil.example" }],
    ["a channel with a URL", { ...valid, channel: "https://evil.example.com" }],
    ["a channel past its length", { ...valid, channel: "a".repeat(129) }],
    ["no channel", { ...valid, channel: "" }],
    ["a fingerprint with free text", { ...valid, fingerprint: "hello world" }],
    ["a short fingerprint", { ...valid, fingerprint: "abc123" }],
    ["a long fingerprint", { ...valid, fingerprint: "a".repeat(65) }],
    ["an upper-case fingerprint", { ...valid, fingerprint: "A".repeat(64) }],
  ])("refuses %s, so it holds no other text", (_, query) => {
    const response = serveSandboxPreviewQr(new Request(url(query)));

    expect(response.status).toBe(400);
    expect(response.headers.has("x-hot-updater-preview-link")).toBe(false);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("takes no link: a text parameter changes nothing it holds", () => {
    const response = serveSandboxPreviewQr(
      new Request(`${url(valid)}&link=https://evil.example.com&text=hello`),
    );

    expect(response.headers.get("x-hot-updater-preview-link")).toBe(LINK);
  });

  it("refuses a request that writes", () => {
    const response = serveSandboxPreviewQr(
      new Request(url(valid), { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
