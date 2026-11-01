// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  receiveDeviceResponse,
  serveDevicePage,
  serveDeviceProfile,
} from "./nativeBuildDevice";

const BUILD = "019a0000-0000-7000-8000-00000000b001";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const ROUTES = `/_hot-updater/native-builds/${BUILD}`;
const CONSOLE = `https://console.example.com${ROUTES}`;

const cmsAnswer = (udid: string) => {
  const text = `\u0000\u0001<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>UDID</key><string>${udid}</string></dict></plist>\u0002`;
  return new Uint8Array(text.length).map((_, i) => text.charCodeAt(i));
};

const post = (body: BodyInit | null, init: RequestInit = {}) =>
  new Request(`${CONSOLE}/device-response`, {
    method: "POST",
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    ...init,
  } as RequestInit);

describe("serveDeviceProfile", () => {
  const profile = (
    url = `${CONSOLE}/device.mobileconfig`,
    init?: RequestInit,
  ) => serveDeviceProfile(new Request(url, init), BUILD);

  it("is a Profile Service profile that asks for the UDID alone", async () => {
    const response = profile();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-apple-aspen-config",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("<string>Profile Service</string>");
    expect(text).toMatch(
      /<key>DeviceAttributes<\/key>\s*<array>\s*<string>UDID<\/string>\s*<\/array>/u,
    );
    expect(text).toContain(`<string>${CONSOLE}/device-response</string>`);
    for (const other of ["IMEI", "SERIAL", "PRODUCT", "VERSION", "MDM"]) {
      expect(text).not.toContain(`<string>${other}</string>`);
    }
  });

  it.runIf(process.platform === "darwin")(
    "parses with plutil into the payload iOS expects",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-"));
      try {
        const file = path.join(directory, "device.mobileconfig");
        await fs.writeFile(file, await profile().text());
        const extract = (key: string) =>
          execFileSync("plutil", ["-extract", key, "raw", "-o", "-", file], {
            encoding: "utf8",
          }).trim();
        expect(
          execFileSync("plutil", ["-lint", file], { encoding: "utf8" }),
        ).toContain("OK");
        expect(extract("PayloadType")).toBe("Profile Service");
        expect(extract("PayloadVersion")).toBe("1");
        expect(extract("PayloadContent.URL")).toBe(
          `${CONSOLE}/device-response`,
        );
        expect(extract("PayloadContent.DeviceAttributes.0")).toBe("UDID");
        expect(extract("PayloadContent.Challenge")).toBe("hot-updater");
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps the console's own path, and HTTPS behind a proxy that ends TLS", async () => {
    const mounted = await profile(
      `https://example.com/console${ROUTES}/device.mobileconfig`,
    ).text();
    expect(mounted).toContain(
      `<string>https://example.com/console${ROUTES}/device-response</string>`,
    );
    const proxied = await profile(
      `http://console.example.com${ROUTES}/device.mobileconfig`,
      { headers: { "x-forwarded-proto": "https" } },
    ).text();
    expect(proxied).toContain(`<string>${CONSOLE}/device-response</string>`);
  });

  it("refuses a Console off HTTPS, which iOS would refuse after the download", async () => {
    const response = profile(
      `http://console.example.com${ROUTES}/device.mobileconfig`,
      { headers: { "x-forwarded-proto": "http" } },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("HTTPS");
  });

  it("refuses an ID that isn't one, and any method but GET and HEAD", async () => {
    const notAnId = serveDeviceProfile(
      new Request(`${CONSOLE}/device.mobileconfig`),
      "../../etc/passwd",
    );
    expect(notAnId.status).toBe(400);
    const posted = profile(undefined, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    expect(await profile(undefined, { method: "HEAD" }).text()).toBe("");
  });
});

describe("receiveDeviceResponse", () => {
  it("sends the device back with a 301 and the UDID in a fragment, keeping nothing", async () => {
    const response = await receiveDeviceResponse(post(cmsAnswer(PHONE)), BUILD);

    expect(response.status).toBe(301);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${CONSOLE}/device`);
    expect(location.search).toBe("");
    expect(location.hash).toBe(`#udid=${PHONE}`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("takes a body of exactly 64 KiB", async () => {
    const answer = cmsAnswer(PHONE);
    const body = new Uint8Array(64 * 1024);
    body.set(answer);
    const response = await receiveDeviceResponse(post(body), BUILD);
    expect(response.status).toBe(301);
  });

  it("refuses a body over 64 KiB by its length, without reading it", async () => {
    let pulled = false;
    const stream = new ReadableStream({
      pull() {
        pulled = true;
      },
    });
    const response = await receiveDeviceResponse(
      post(stream, { headers: { "content-length": String(64 * 1024 + 1) } }),
      BUILD,
    );
    expect(response.status).toBe(413);
    expect(pulled).toBe(false);
  });

  it("stops reading a body that grows past 64 KiB, whatever its length says", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await receiveDeviceResponse(post(stream), BUILD);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(80 * 1024);
  });

  it.each([
    ["no body", null],
    ["no UDID", cmsAnswer("").subarray(0, 8)],
    ["a malformed UDID", cmsAnswer("../../etc/passwd")],
    ["markup", cmsAnswer(`${PHONE}"><script>`)],
  ])("gives 400 for %s", async (_, body) => {
    const response = await receiveDeviceResponse(post(body), BUILD);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses any method but POST, and an ID that isn't one", async () => {
    const got = await receiveDeviceResponse(
      new Request(`${CONSOLE}/device-response`),
      BUILD,
    );
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST");
    const notAnId = await receiveDeviceResponse(post(cmsAnswer(PHONE)), "x");
    expect(notAnId.status).toBe(400);
  });
});

describe("serveDevicePage", () => {
  const page = (init?: RequestInit) =>
    serveDevicePage(new Request(`${CONSOLE}/device`, init), BUILD);

  it("is a page of its own, with the warning, a link back, and nothing from elsewhere", async () => {
    const response = page();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("Send this only if this is your iPhone.");
    expect(html).toContain(`href="../../../native-builds/${BUILD}"`);
    expect(html).toContain("hot-updater-ios-udid");
    expect(html).toContain("native-build devices add --udid ");
    // No script, style, image, or request from anywhere: its own inline ones.
    expect(html).not.toMatch(/<(?:link|img|iframe)\b/u);
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest/u);
  });

  it("lets only its own inline script and style run", async () => {
    const response = page();
    const policy = response.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)![1]!;

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    expect(policy).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(page().headers.get("content-security-policy")).not.toContain(nonce);
  });

  it("refuses an ID that isn't one, and any method but GET and HEAD", async () => {
    const notAnId = serveDevicePage(
      new Request(`${CONSOLE}/device`),
      '"><script>alert(1)</script>',
    );
    expect(notAnId.status).toBe(400);
    expect(await notAnId.text()).not.toContain("<script>");
    expect(page({ method: "POST" }).status).toBe(405);
    expect(await page({ method: "HEAD" }).text()).toBe("");
  });
});

/**
 * The page's own script, run in a browser's model of the page: what a tester
 * sees depends on it, and nothing else on this page can run.
 */
describe("the device page's script", () => {
  const STORAGE_KEY = "hot-updater-ios-udid";

  const open = async (hash: string, stored?: string) => {
    const { JSDOM } = await import("jsdom");
    const html = await serveDevicePage(
      new Request(`${CONSOLE}/device`),
      BUILD,
    ).text();
    const dom = new JSDOM(html, {
      url: `${CONSOLE}/device${hash}`,
      runScripts: "dangerously",
      beforeParse(window) {
        if (stored !== undefined) {
          window.localStorage.setItem(STORAGE_KEY, stored);
        }
      },
    });
    const { document, localStorage, location } = dom.window;
    const shown = (id: string) => {
      const element = document.getElementById(id)!;
      return element.hidden ? null : element.textContent;
    };
    return { document, localStorage, location, shown };
  };

  it("shows the UDID and one command, keeps it in localStorage, and drops the fragment", async () => {
    const { shown, localStorage, location } = await open(`#udid=${PHONE}`);

    expect(shown("udid")).toBe(PHONE);
    expect(shown("warning")).toBe("Send this only if this is your iPhone.");
    expect(shown("command")).toBe(
      `npx hot-updater native-build devices add --udid ${PHONE} --name "Teammate's iPhone"`,
    );
    expect(shown("copy")).toBe("Copy command");
    expect(shown("missing")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(PHONE);
    expect(location.hash).toBe("");
    expect(location.pathname).toBe(`${ROUTES}/device`);
  });

  it("shows the phone's own UDID again on a later visit, with no fragment", async () => {
    const { shown } = await open("", PHONE);
    expect(shown("udid")).toBe(PHONE);
  });

  it("says where to go without a UDID, keeping nothing", async () => {
    const { shown, localStorage } = await open("");

    expect(shown("missing")).toContain("No iPhone ID");
    expect(shown("retry")).toContain("Safari");
    expect(shown("udid")).toBeNull();
    expect(shown("command")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("never renders or keeps a crafted fragment as text or markup", async () => {
    const crafted = encodeURIComponent(`<img src=x onerror=alert(1)>`);
    const { shown, document, localStorage } = await open(`#udid=${crafted}`);

    expect(shown("udid")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("prefers the fragment over what it kept, so a new check replaces an old UDID", async () => {
    const other = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const { shown, localStorage } = await open(`#udid=${other}`, PHONE);

    expect(shown("udid")).toBe(other);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(other);
  });
});
