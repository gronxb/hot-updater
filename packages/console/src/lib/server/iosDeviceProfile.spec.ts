// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDeviceProfileToken,
  createDeviceReceipt,
  DEVICE_PROFILE_TOKEN_TTL_MS,
  verifyDeviceProfileToken,
  verifyDeviceReceipt,
} from "./deviceProfileToken";
import { receiveDeviceResponse, serveDeviceProfile } from "./iosDeviceProfile";

const SECRET = "s".repeat(40);
const BUILD = "019a0000-0000-7000-8000-00000000b001";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const CONSOLE = "https://console.example.com";

const cmsAnswer = (udid: string) => {
  const text = `\u0000\u0001<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>UDID</key><string>${udid}</string></dict></plist>\u0002`;
  return new Uint8Array(text.length).map((_, i) => text.charCodeAt(i));
};

const registerToken = () =>
  createDeviceProfileToken(SECRET, {
    m: "register",
    e: "kim@team.dev",
    n: "Kim's iPhone",
  });

const identifyToken = () =>
  createDeviceProfileToken(SECRET, {
    m: "identify",
    e: "kim@team.dev",
    b: BUILD,
  });

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("device profile tokens", () => {
  it("carry what they grant, and refuse another purpose, a change, or an expiry", async () => {
    const now = 1_000_000;
    const token = await createDeviceProfileToken(
      SECRET,
      { m: "register", e: "kim@team.dev", n: "김의 iPhone" },
      now,
    );
    expect(await verifyDeviceProfileToken(SECRET, token, now)).toEqual({
      m: "register",
      e: "kim@team.dev",
      n: "김의 iPhone",
    });
    expect(
      await verifyDeviceProfileToken(
        SECRET,
        token,
        now + DEVICE_PROFILE_TOKEN_TTL_MS,
      ),
    ).toBe("expired");
    expect(await verifyDeviceProfileToken("t".repeat(40), token, now)).toBe(
      "invalid",
    );
    const [body, signature] = token.split(".");
    expect(
      await verifyDeviceProfileToken(SECRET, `${body}x.${signature}`, now),
    ).toBe("invalid");
    // A receipt is no capability, and a capability no receipt.
    const receipt = await createDeviceReceipt(
      SECRET,
      { u: PHONE, e: "kim@team.dev" },
      now,
    );
    expect(await verifyDeviceProfileToken(SECRET, receipt, now)).toBe(
      "invalid",
    );
    expect(await verifyDeviceReceipt(SECRET, token, now)).toBe("invalid");
    expect(await verifyDeviceReceipt(SECRET, receipt, now)).toEqual({
      u: PHONE,
      e: "kim@team.dev",
    });
  });
});

describe("serveDeviceProfile", () => {
  it("refuses a request without a valid capability before anything else", async () => {
    for (const url of [
      `${CONSOLE}/_hot-updater/devices/device.mobileconfig`,
      `${CONSOLE}/_hot-updater/devices/device.mobileconfig?t=forged.${"a".repeat(43)}`,
    ]) {
      const response = await serveDeviceProfile(new Request(url));
      expect(response.status).toBe(403);
    }
  });

  it("is a Profile Service profile that asks for the UDID alone, and calls back with the same capability", async () => {
    const token = await registerToken();
    const response = await serveDeviceProfile(
      new Request(
        `${CONSOLE}/console/_hot-updater/devices/device.mobileconfig?t=${token}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-apple-aspen-config",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await response.text();
    expect(text).toContain("<string>Profile Service</string>");
    expect(text).toMatch(
      /<key>DeviceAttributes<\/key>\s*<array>\s*<string>UDID<\/string>\s*<\/array>/u,
    );
    expect(text).toContain(
      `<string>${CONSOLE}/console/_hot-updater/devices/device-response?t=${token}</string>`,
    );
    expect(text).toContain("to request this iPhone for ad hoc builds");
  });

  it("refuses a Console off HTTPS, which iOS needs", async () => {
    const response = await serveDeviceProfile(
      new Request(
        `http://console.local/_hot-updater/devices/device.mobileconfig?t=${await registerToken()}`,
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe("receiveDeviceResponse", () => {
  const post = (token: string | null, body: BodyInit) =>
    new Request(
      `${CONSOLE}/_hot-updater/devices/device-response${token === null ? "" : `?t=${token}`}`,
      { method: "POST", body },
    );

  it("refuses a missing or bad capability before it reads the body or the database", async () => {
    const loadCore = vi.fn();
    const read = vi.fn();
    for (const token of [null, `forged.${"a".repeat(43)}`]) {
      // No read ahead: a pull is a read of the body.
      const body = new ReadableStream({ pull: read }, { highWaterMark: 0 });
      const response = await receiveDeviceResponse(
        new Request(
          `${CONSOLE}/_hot-updater/devices/device-response${token === null ? "" : `?t=${token}`}`,
          { method: "POST", body, duplex: "half" } as RequestInit,
        ),
        loadCore,
      );
      expect(response.status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
    expect(loadCore).not.toHaveBeenCalled();
  });

  it("saves a registering iPhone as requested by the capability's email, and returns to the iOS devices page", async () => {
    const requestIosDevice = vi.fn(async () => ({}) as never);
    const response = await receiveDeviceResponse(
      post(await registerToken(), cmsAnswer(PHONE)),
      async () => ({ requestIosDevice }),
    );
    expect(response.status).toBe(301);
    expect(requestIosDevice).toHaveBeenCalledOnce();
    expect(requestIosDevice).toHaveBeenCalledWith({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: "kim@team.dev",
    });
    expect(response.headers.get("location")).toBe(
      `${CONSOLE}/native-builds/devices#udid=${PHONE}&requested=1`,
    );
  });

  it("identifies an iPhone with no database call, returning to the build its capability names with a receipt", async () => {
    const loadCore = vi.fn();
    const response = await receiveDeviceResponse(
      post(await identifyToken(), cmsAnswer(PHONE)),
      loadCore,
    );
    expect(response.status).toBe(301);
    expect(loadCore).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      `${CONSOLE}/native-builds/${BUILD}`,
    );
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("udid")).toBe(PHONE);
    expect(await verifyDeviceReceipt(SECRET, fragment.get("r")!)).toEqual({
      u: PHONE,
      e: "kim@team.dev",
    });
  });

  it("refuses a body with no UDID, and one over 64 KiB", async () => {
    const token = await registerToken();
    const loadCore = vi.fn();
    expect(
      (await receiveDeviceResponse(post(token, "<plist/>"), loadCore)).status,
    ).toBe(400);
    expect(
      (
        await receiveDeviceResponse(
          post(token, new Uint8Array(64 * 1024 + 1)),
          loadCore,
        )
      ).status,
    ).toBe(413);
    expect(loadCore).not.toHaveBeenCalled();
  });

  it("takes only POST", async () => {
    const response = await receiveDeviceResponse(
      new Request(`${CONSOLE}/_hot-updater/devices/device-response`),
      vi.fn(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
