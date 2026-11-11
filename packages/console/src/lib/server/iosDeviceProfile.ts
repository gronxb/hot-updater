import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { readProfileServiceUdid } from "@hot-updater/protocol/native-artifact";

import {
  IOS_DEVICES_PATH,
  IOS_DEVICE_PROFILE_PATH,
  IOS_DEVICE_RESPONSE_PATH,
  IOS_DEVICE_TOKEN_PARAM,
  nativeBuildDetailPath,
} from "../native-builds";
import {
  createDeviceReceipt,
  type DeviceProfileGrant,
  verifyDeviceProfileToken,
} from "./deviceProfileToken";
import { readConsoleSecret } from "./nativeBuildDownloadLink";
import { escapePlistText } from "./plistText";
import { publicConsoleBase } from "./publicConsoleBase";

/** The most a Profile Service answer holds: a plist and a device's certificates. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const refusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });

const methodRefusal = (allow: string) => {
  const response = refusal(405, "Method Not Allowed");
  response.headers.set("allow", allow);
  return response;
};

/**
 * The grant a request's `t` carries, or the 403 that refuses it, checked
 * before anything else is read: the profile routes take no session.
 */
const grantOf = async (
  request: Request,
): Promise<
  | {
      readonly grant: DeviceProfileGrant;
      readonly token: string;
      readonly secret: string;
    }
  | Response
> => {
  const secret = readConsoleSecret(request);
  if (secret === undefined) {
    return refusal(
      403,
      "This Console can't register iPhones without its secret.",
    );
  }
  const token = new URL(request.url).searchParams.get(IOS_DEVICE_TOKEN_PARAM);
  const grant =
    token === null ? "invalid" : await verifyDeviceProfileToken(secret, token);
  if (grant === "expired") {
    return refusal(403, "This link has expired. Open the Console page again.");
  }
  if (grant === "invalid") {
    return refusal(403, "This link isn't valid. Open the Console page again.");
  }
  return { grant, token: token!, secret };
};

/**
 * The profile an iPhone installs to report its UDID, at
 * `/_hot-updater/devices/device.mobileconfig?t=<capability>`. It takes no
 * session, since Safari's download carries none here, and reads nothing:
 * the capability is all it answers to. The callback URL carries the same
 * capability. It asks for the UDID alone, and iOS keeps no profile afterwards.
 *
 * - 400: the Console isn't on HTTPS, which iOS needs;
 * - 403: no capability, or one that isn't valid or has expired;
 * - 405: a method other than GET or HEAD.
 */
export const serveDeviceProfile = async (
  request: Request,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodRefusal("GET, HEAD");
  }
  const checked = await grantOf(request);
  if (checked instanceof Response) return checked;
  const base = publicConsoleBase(request, IOS_DEVICE_PROFILE_PATH);
  if (!base.startsWith("https://")) {
    return refusal(
      400,
      "An iPhone needs this Console on HTTPS with a certificate it trusts.",
    );
  }
  const host = new URL(base).host;
  const callback = `${base}${IOS_DEVICE_RESPONSE_PATH}?${IOS_DEVICE_TOKEN_PARAM}=${encodeURIComponent(checked.token)}`;
  const purpose =
    checked.grant.m === "register"
      ? "to request this iPhone for ad hoc builds"
      : "to check whether a build can install on it";
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${escapePlistText(callback)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
    </array>
    <key>Challenge</key>
    <string>hot-updater</string>
  </dict>
  <key>PayloadOrganization</key>
  <string>Hot Updater</string>
  <key>PayloadDisplayName</key>
  <string>Hot Updater Device Profile</string>
  <key>PayloadDescription</key>
  <string>Sends this iPhone's ID (UDID) to ${escapePlistText(host)}, ${purpose}. Nothing stays installed.</string>
  <key>PayloadIdentifier</key>
  <string>dev.hot-updater.device-profile</string>
  <key>PayloadUUID</key>
  <string>6D3F4C0E-52C4-4C8B-9E0A-7B1E5A0C2F11</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
  return new Response(request.method === "HEAD" ? null : profile, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-apple-aspen-config",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};

/** A request's body, or null past `limit` bytes, which are never buffered. */
const readBoundedBody = async (
  request: Request,
  limit: number,
): Promise<Uint8Array | null> => {
  if (Number(request.headers.get("content-length") ?? 0) > limit) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const body = new Uint8Array(limit);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body.subarray(0, length);
      if (length + value.byteLength > limit) return null;
      body.set(value, length);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
};

/**
 * Where iOS posts the device's answer, at `/_hot-updater/devices/
 * device-response?t=<capability>`, without a session, since Settings has
 * none. The capability is checked before the body is read. It takes the
 * UDID's text and verifies no signature: a person approves every device.
 *
 * - `register`: saves the iPhone as requested by the capability's email, one
 *   read and at most one write, and goes back to the iOS devices page;
 * - `identify`: saves nothing and goes back to the build's page with a receipt
 *   of the UDID for that email, which Request access takes.
 *
 * Where it goes back to comes from the capability, never from the request.
 * iOS asks for a 301.
 *
 * - 400: no well-formed UDID;
 * - 403: no capability, or one that isn't valid or has expired;
 * - 405: a method other than POST;
 * - 413: a body over 64 KiB.
 */
export const receiveDeviceResponse = async (
  request: Request,
  loadCore: () => Promise<Pick<HotUpdaterCoreApi, "requestIosDevice">>,
): Promise<Response> => {
  if (request.method !== "POST") return methodRefusal("POST");
  const checked = await grantOf(request);
  if (checked instanceof Response) {
    await request.body?.cancel().catch(() => {});
    return checked;
  }
  const body = await readBoundedBody(request, MAX_RESPONSE_BYTES);
  if (body === null) return refusal(413, "This answer is too large.");
  const udid = readProfileServiceUdid(body);
  if (udid === null) return refusal(400, "This answer has no device ID.");
  const { grant, secret } = checked;
  const base = publicConsoleBase(request, IOS_DEVICE_RESPONSE_PATH);
  let location: string;
  if (grant.m === "register") {
    const core = await loadCore();
    await core.requestIosDevice({
      udid,
      name: grant.n ?? "iPhone",
      requestedBy: grant.e,
    });
    location = `${base}${IOS_DEVICES_PATH}#udid=${encodeURIComponent(udid)}&requested=1`;
  } else {
    const receipt = await createDeviceReceipt(secret, { u: udid, e: grant.e });
    const page =
      grant.b === undefined ? IOS_DEVICES_PATH : nativeBuildDetailPath(grant.b);
    location = `${base}${page}#udid=${encodeURIComponent(udid)}&r=${encodeURIComponent(receipt)}`;
  }
  return new Response(null, {
    status: 301,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      location,
    },
  });
};
