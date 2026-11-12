import type { HotUpdaterCoreApi, IosDeviceRow } from "@hot-updater/plugin-core";

import {
  createKeptDeviceReceipt,
  type DeviceReceipt,
  KEPT_DEVICE_RECEIPT_TTL_MS,
  verifyDeviceReceipt,
  verifyKeptDeviceReceipt,
} from "./deviceProfileToken";
import { deviceName, type IosDeviceViewer } from "./iosDevices";
import { readConsoleSecret } from "./nativeBuildDownloadLink";
import { publicConsoleBase } from "./publicConsoleBase";

/**
 * This iPhone's proof, kept by Safari: after the profile's answer, the page
 * trades the fragment's one-hour receipt for a 30-day one in an HttpOnly
 * cookie, so the same person can request this iPhone again, after a removal,
 * without the profile. The Console stores nothing: the cookie is a receipt
 * signed with its secret, checked against the session on every use.
 *
 * The cookie is `Secure`, `SameSite=Strict`, and scoped to these routes, so
 * no other request carries it and no other site's request does either. Every
 * route here needs the Console's session, and a POST or DELETE only from this
 * Console's own pages.
 */

export const IOS_DEVICE_COOKIE = "hot-updater-ios-device";

/** The routes the cookie is sent to, under the Console's path. */
export const IOS_DEVICE_COOKIE_ROUTES = "/_hot-updater/devices";

export const IOS_DEVICE_RECEIPT_ROUTE = `${IOS_DEVICE_COOKIE_ROUTES}/receipt`;
export const IOS_DEVICE_REQUEST_ROUTE = `${IOS_DEVICE_COOKIE_ROUTES}/request`;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

const refusal = (status: number, message: string) =>
  json({ error: message }, status);

const cookieOf = (request: Request): string | null => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === IOS_DEVICE_COOKIE) return value.join("=") || null;
  }
  return null;
};

/** The cookie's `Path`: these routes, under the Console's own path. */
const cookiePath = (request: Request, route: string) =>
  `${new URL(publicConsoleBase(request, route)).pathname.replace(/\/$/u, "")}${IOS_DEVICE_COOKIE_ROUTES}`;

const setCookie = (request: Request, route: string, value: string) =>
  [
    `${IOS_DEVICE_COOKIE}=${value}`,
    `Path=${cookiePath(request, route)}`,
    `Max-Age=${value === "" ? 0 : Math.floor(KEPT_DEVICE_RECEIPT_TTL_MS / 1000)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");

/**
 * Whether a request that changes something comes from this Console's own
 * pages: a browser says so in `Sec-Fetch-Site` and `Origin`. With the
 * cookie's `SameSite=Strict`, another site's form or script gets nowhere.
 */
const sameOrigin = (request: Request, route: string) => {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return site === "same-origin";
  return (
    origin === new URL(request.url).origin ||
    origin === new URL(publicConsoleBase(request, route)).origin
  );
};

const readJson = async (request: Request) => {
  if (
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  ) {
    return null;
  }
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The cookie's receipt, for this person only; null when it holds none. */
const keptReceipt = async (
  request: Request,
  secret: string,
  viewer: IosDeviceViewer,
  now: number,
): Promise<DeviceReceipt | null> => {
  const cookie = cookieOf(request);
  if (cookie === null) return null;
  const receipt = await verifyKeptDeviceReceipt(secret, cookie, now);
  return typeof receipt === "string" || receipt.e !== viewer.email
    ? null
    : receipt;
};

export interface IosDeviceCookieDeps {
  /** The signed-in viewer, or the access check's 401/403. */
  readonly viewer: () => Promise<IosDeviceViewer>;
  readonly core: () => Promise<Pick<HotUpdaterCoreApi, "requestIosDevice">>;
  readonly now?: number;
}

const withViewer = async (
  deps: IosDeviceCookieDeps,
  run: (viewer: IosDeviceViewer) => Promise<Response>,
) => {
  let viewer: IosDeviceViewer;
  try {
    viewer = await deps.viewer();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  return run(viewer);
};

/**
 * `/_hot-updater/devices/receipt`:
 *
 * - GET: the UDID this Safari proved for this person, or null.
 * - POST `{ receipt }`: trades the fragment's receipt, for this person, for
 *   the cookie; 403 for anyone else's, an expired one, or a forged one.
 * - DELETE: forgets the cookie, as sign-out does.
 */
export const handleIosDeviceReceipt = async (
  request: Request,
  deps: IosDeviceCookieDeps,
): Promise<Response> =>
  withViewer(deps, async (viewer) => {
    const now = deps.now ?? Date.now();
    const route = IOS_DEVICE_RECEIPT_ROUTE;
    if (request.method === "DELETE") {
      if (!sameOrigin(request, route)) return refusal(403, "Forbidden");
      return json({ udid: null }, 200, {
        "set-cookie": setCookie(request, route, ""),
      });
    }
    const secret = readConsoleSecret(request);
    if (request.method === "GET") {
      const receipt =
        secret === undefined
          ? null
          : await keptReceipt(request, secret, viewer, now);
      return json({ udid: receipt?.u ?? null });
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST, DELETE" },
      });
    }
    if (!sameOrigin(request, route)) return refusal(403, "Forbidden");
    if (secret === undefined) {
      return refusal(409, "This Console has no secret to sign with.");
    }
    const body = await readJson(request);
    if (body === null || typeof body.receipt !== "string") {
      return refusal(400, "Send this iPhone's receipt.");
    }
    const receipt = await verifyDeviceReceipt(secret, body.receipt, now);
    if (typeof receipt === "string" || receipt.e !== viewer.email) {
      return refusal(403, "Check this iPhone again from this account.");
    }
    return json({ udid: receipt.u }, 200, {
      "set-cookie": setCookie(
        request,
        route,
        await createKeptDeviceReceipt(secret, receipt, now),
      ),
    });
  });

/**
 * `/_hot-updater/devices/request`, POST `{ name, receipt? }`: requests the
 * iPhone a receipt names, for the signed-in person, under `name`. The UDID
 * comes from the fragment's receipt when the page has one, else from the
 * cookie, never from the request's own words.
 */
export const handleIosDeviceRequest = async (
  request: Request,
  deps: IosDeviceCookieDeps,
): Promise<Response> =>
  withViewer(deps, async (viewer) => {
    const now = deps.now ?? Date.now();
    const route = IOS_DEVICE_REQUEST_ROUTE;
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (!sameOrigin(request, route)) return refusal(403, "Forbidden");
    const secret = readConsoleSecret(request);
    const body = await readJson(request);
    if (body === null) return refusal(400, "Send this iPhone's name.");
    let name: string;
    try {
      name = deviceName(body.name);
    } catch (error) {
      return refusal(400, (error as Error).message);
    }
    let udid: string | null = null;
    if (secret !== undefined) {
      if (typeof body.receipt === "string") {
        const receipt = await verifyDeviceReceipt(secret, body.receipt, now);
        udid =
          typeof receipt === "string" || receipt.e !== viewer.email
            ? null
            : receipt.u;
      } else {
        udid = (await keptReceipt(request, secret, viewer, now))?.u ?? null;
      }
    }
    if (udid === null) {
      return refusal(403, "Check this iPhone again from this account.");
    }
    const core = await deps.core();
    const result: { device: IosDeviceRow; created: boolean } =
      await core.requestIosDevice({ udid, name, requestedBy: viewer.email });
    return json(result);
  });
