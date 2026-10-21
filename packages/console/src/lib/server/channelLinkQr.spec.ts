// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { serveChannelLinkQr } from "./channelLinkQr";

const request = (query: string, method = "GET") =>
  new Request(
    `https://console.example.com/_hot-updater/preview/channel-qr${query}`,
    { method },
  );

describe("serveChannelLinkQr", () => {
  it("serves the QR code of the channel's link as a cacheable SVG, with the link in a header", async () => {
    const readPrefix = vi.fn(async () => "myapp://");

    const response = await serveChannelLinkQr(
      request("?channel=pr-12"),
      readPrefix,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("x-hot-updater-channel-link")).toBe(
      "myapp://hot-updater/channel/pr-12",
    );
    const svg = await response.text();
    // The link's 33 bytes take version 3 at level M (up to 42 bytes): 29
    // modules, with the four-module quiet zone on each side, at 6 px each.
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="222" height="222" viewBox="0 0 37 37" /,
    );
    expect(svg).toContain('<rect fill="#fff" width="37" height="37"/>');
    // The quiet zone stays light: no module starts left of or above it.
    const modules = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(
      ([, x, y]) => [Number(x), Number(y)],
    );
    expect(modules.length).toBeGreaterThan(100);
    for (const [x, y] of modules) {
      expect(x).toBeGreaterThanOrEqual(4);
      expect(x).toBeLessThan(33);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(y).toBeLessThan(33);
    }
    // A finder pattern's top-left module.
    expect(modules).toContainEqual([4, 4]);
  });

  it("joins a universal link's prefix with one slash", async () => {
    const response = await serveChannelLinkQr(
      request("?channel=preview"),
      async () => "https://example.com/app",
    );

    expect(response.headers.get("x-hot-updater-channel-link")).toBe(
      "https://example.com/app/hot-updater/channel/preview",
    );
  });

  it("answers HEAD with the link and no body", async () => {
    const response = await serveChannelLinkQr(
      request("?channel=pr-12", "HEAD"),
      async () => "myapp://",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hot-updater-channel-link")).toBe(
      "myapp://hot-updater/channel/pr-12",
    );
    expect(await response.text()).toBe("");
  });

  it("refuses a missing channel without reading the config", async () => {
    const readPrefix = vi.fn(async () => "myapp://");

    const response = await serveChannelLinkQr(request(""), readPrefix);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readPrefix).not.toHaveBeenCalled();
  });

  it.each(["", " pr-12", "a".repeat(256)])(
    "refuses %j, which is not a channel name",
    async (channel) => {
      const response = await serveChannelLinkQr(
        request(`?channel=${encodeURIComponent(channel)}`),
        async () => "myapp://",
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("x-hot-updater-channel-link")).toBeNull();
    },
  );

  it("answers 404 when the config sets no channel link prefix", async () => {
    const response = await serveChannelLinkQr(
      request("?channel=pr-12"),
      async () => undefined,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("console.channelLinkPrefix");
  });

  it("refuses other methods", async () => {
    const readPrefix = vi.fn(async () => "myapp://");

    const response = await serveChannelLinkQr(
      request("?channel=pr-12", "POST"),
      readPrefix,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(readPrefix).not.toHaveBeenCalled();
  });
});
