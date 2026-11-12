// @vitest-environment node

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDeviceReceipt,
  createKeptDeviceReceipt,
  KEPT_DEVICE_RECEIPT_TTL_MS,
} from "./deviceProfileToken";
import {
  handleIosDeviceReceipt,
  handleIosDeviceRequest,
  IOS_DEVICE_COOKIE,
} from "./iosDeviceCookie";
import type { IosDeviceViewer } from "./iosDevices";

const SECRET = "s".repeat(40);
const PHONE = "00008030-001c2d3e4f5a6b7c";
const OTHER = "00008110-001a2b3c4d5e6f70";
const CONSOLE = "https://console.example.com/console";
const KIM: IosDeviceViewer = {
  email: "kim@team.dev",
  canApprove: false,
  approversConfigured: true,
};

const coreOf = () =>
  createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    storage: { name: "none", protocol: "none" },
    plugins: [],
    clientAccess: "public",
  }).core;

/** A request from this Console's own page, as Safari sends it. */
const call = (
  route: "receipt" | "request",
  {
    method = "POST",
    body,
    cookie,
    site = "same-origin",
    origin = "https://console.example.com",
    base = CONSOLE,
  }: {
    method?: string;
    body?: unknown;
    cookie?: string;
    site?: string | null;
    origin?: string | null;
    base?: string;
  } = {},
) =>
  new Request(`${base}/_hot-updater/devices/${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined
        ? {}
        : { cookie: `other=1; ${IOS_DEVICE_COOKIE}=${cookie}` }),
      ...(site === null ? {} : { "sec-fetch-site": site }),
      ...(origin === null ? {} : { origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const depsOf = (core = coreOf(), viewer: IosDeviceViewer | Response = KIM) => ({
  viewer: async () => {
    if (viewer instanceof Response) throw viewer;
    return viewer;
  },
  core: async () => core,
});

const cookieValue = (response: Response) =>
  /^hot-updater-ios-device=([^;]*)/u.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1] ?? null;

beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("trading the profile's receipt for the cookie", () => {
  it("sets an HttpOnly, Secure, SameSite=Strict cookie scoped to the device routes, for 30 days", async () => {
    const receipt = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    const response = await handleIosDeviceReceipt(
      call("receipt", { body: { receipt } }),
      depsOf(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ udid: PHONE });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/console/_hot-updater/devices;");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    // Not the fragment's one-hour receipt: a kept one of its own.
    expect(cookieValue(response)).not.toBe(receipt);
  });

  it("refuses another person's receipt, an expired one, and a forged one, setting nothing", async () => {
    const others = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: "mallory@team.dev",
    });
    const expired = await createDeviceReceipt(
      SECRET,
      { u: PHONE, e: KIM.email },
      Date.now() - 2 * 60 * 60 * 1000,
    );
    for (const receipt of [others, expired, `forged.${"a".repeat(43)}`]) {
      const response = await handleIosDeviceReceipt(
        call("receipt", { body: { receipt } }),
        depsOf(),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("takes no trade from another site, nor one that isn't JSON", async () => {
    const receipt = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    for (const request of [
      call("receipt", { body: { receipt }, site: "cross-site" }),
      call("receipt", {
        body: { receipt },
        site: null,
        origin: "https://evil.example",
      }),
      call("receipt", { body: { receipt }, site: null, origin: null }),
    ]) {
      expect((await handleIosDeviceReceipt(request, depsOf())).status).toBe(
        403,
      );
    }
    const form = new Request(`${CONSOLE}/_hot-updater/devices/receipt`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: `receipt=${receipt}`,
    });
    expect((await handleIosDeviceReceipt(form, depsOf())).status).toBe(400);
  });

  it("answers no one who isn't signed in", async () => {
    const response = await handleIosDeviceReceipt(
      call("receipt", { method: "GET" }),
      depsOf(coreOf(), new Response("Unauthorized", { status: 401 })),
    );
    expect(response.status).toBe(401);
  });
});

describe("reading the cookie", () => {
  const read = async (cookie: string, viewer = KIM) =>
    (await (
      await handleIosDeviceReceipt(
        call("receipt", { method: "GET", cookie }),
        depsOf(coreOf(), viewer),
      )
    ).json()) as { udid: string | null };

  it("names the iPhone this Safari proved, for the same person only", async () => {
    const kept = await createKeptDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    expect(await read(kept)).toEqual({ udid: PHONE });
    expect(await read(kept, { ...KIM, email: "lee@team.dev" })).toEqual({
      udid: null,
    });
  });

  it("names nothing for an expired cookie, a forged one, or the fragment's short receipt", async () => {
    const expired = await createKeptDeviceReceipt(
      SECRET,
      { u: PHONE, e: KIM.email },
      Date.now() - KEPT_DEVICE_RECEIPT_TTL_MS - 1,
    );
    const short = await createDeviceReceipt(SECRET, { u: PHONE, e: KIM.email });
    const otherSecret = await createKeptDeviceReceipt("o".repeat(40), {
      u: PHONE,
      e: KIM.email,
    });
    for (const cookie of [expired, short, otherSecret, "forged"]) {
      expect(await read(cookie)).toEqual({ udid: null });
    }
  });

  it("forgets the cookie on DELETE, as sign-out asks", async () => {
    const response = await handleIosDeviceReceipt(
      call("receipt", { method: "DELETE" }),
      depsOf(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /^hot-updater-ios-device=; Path=\/console\/_hot-updater\/devices; Max-Age=0;/u,
    );
  });
});

describe("requesting this iPhone again", () => {
  it("requests the cookie's iPhone after its row was removed, with no profile and no UDID from the page", async () => {
    const core = coreOf();
    const kept = await createKeptDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    await core.requestIosDevice({
      udid: PHONE,
      name: "Kim's iPhone",
      requestedBy: KIM.email,
    });
    const [row] = await core.listIosDevices({ limit: 10 });
    await core.deleteIosDevice(row!.id);

    const response = await handleIosDeviceRequest(
      call("request", {
        cookie: kept,
        // A UDID in the body is never taken.
        body: { name: "Kim's iPhone", udid: OTHER },
      }),
      depsOf(core),
    );

    expect(response.status).toBe(200);
    expect(await core.listIosDevices({ limit: 10 })).toEqual([
      expect.objectContaining({
        udid: PHONE,
        status: "pending",
        requested_by: KIM.email,
      }),
    ]);
  });

  it("takes the fragment's fresh receipt over the cookie when the page has one", async () => {
    const core = coreOf();
    const receipt = await createDeviceReceipt(SECRET, {
      u: OTHER,
      e: KIM.email,
    });
    const response = await handleIosDeviceRequest(
      call("request", { body: { name: "Kim's iPad", receipt } }),
      depsOf(core),
    );
    expect(response.status).toBe(200);
    expect(await core.listIosDevices({ limit: 10 })).toEqual([
      expect.objectContaining({ udid: OTHER }),
    ]);
  });

  it("falls back to the cookie when the page's fragment receipt has expired, as on a page left open past its hour", async () => {
    const core = coreOf();
    const kept = await createKeptDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    const stale = await createDeviceReceipt(
      SECRET,
      { u: PHONE, e: KIM.email },
      Date.now() - 2 * 60 * 60 * 1000,
    );
    const response = await handleIosDeviceRequest(
      call("request", {
        cookie: kept,
        body: { name: "Kim's iPhone", receipt: stale },
      }),
      depsOf(core),
    );
    expect(response.status).toBe(200);
    expect(await core.listIosDevices({ limit: 10 })).toEqual([
      expect.objectContaining({ udid: PHONE }),
    ]);
  });

  it("refuses with no cookie, a forged or expired one, another person's, or from another site", async () => {
    const core = coreOf();
    const kim = await createKeptDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    const expired = await createKeptDeviceReceipt(
      SECRET,
      { u: PHONE, e: KIM.email },
      Date.now() - KEPT_DEVICE_RECEIPT_TTL_MS - 1,
    );
    const mallory = await createKeptDeviceReceipt(SECRET, {
      u: PHONE,
      e: "mallory@team.dev",
    });
    const body = { name: "Kim's iPhone" };
    for (const request of [
      call("request", { body }),
      call("request", { body, cookie: "forged" }),
      call("request", { body, cookie: expired }),
      call("request", { body, cookie: mallory }),
      call("request", { body, cookie: kim, site: "cross-site" }),
      call("request", {
        body,
        cookie: kim,
        site: null,
        origin: "https://evil.example",
      }),
    ]) {
      expect((await handleIosDeviceRequest(request, depsOf(core))).status).toBe(
        403,
      );
    }
    expect(await core.listIosDevices({ limit: 10 })).toEqual([]);
  });

  it("works the same on the local Console, at the root of its host", async () => {
    const core = coreOf();
    const receipt = await createDeviceReceipt(SECRET, {
      u: PHONE,
      e: KIM.email,
    });
    const traded = await handleIosDeviceReceipt(
      call("receipt", {
        body: { receipt },
        base: "http://localhost:3000",
        origin: "http://localhost:3000",
      }),
      depsOf(core),
    );
    expect(traded.headers.get("set-cookie")).toContain(
      "Path=/_hot-updater/devices;",
    );
    const response = await handleIosDeviceRequest(
      call("request", {
        body: { name: "Kim's iPhone" },
        cookie: cookieValue(traded)!,
        base: "http://localhost:3000",
        origin: "http://localhost:3000",
      }),
      depsOf(core),
    );
    expect(response.status).toBe(200);
  });
});
