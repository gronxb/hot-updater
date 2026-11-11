import { sameSecret } from "./local-console";

/**
 * Signed, short-lived tokens for an iPhone's profile flow, which runs where
 * the Console's session isn't: Safari's profile download and the Settings app's
 * answer carry no cookie. A token holds what it grants and its expiry, and the
 * Console stores nothing.
 *
 * - The capability (`t`) lets the profile routes serve one profile and take
 *   one answer for a signed-in person: `register` saves the iPhone as
 *   requested, `identify` only tells the build page which iPhone it is.
 * - The receipt (`r`) is what `identify` hands back: it names the UDID the
 *   profile read and whose session asked, so Request access takes the UDID
 *   from it, never from a link anyone can craft.
 */

/** Separates these tokens' key from every other use of the Console's secret. */
const KEY_CONTEXT = "hot-updater/console/device-profile/v1";

/** How long a capability works: one profile install. */
export const DEVICE_PROFILE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** How long a receipt works, from the profile's answer to Request access. */
export const DEVICE_RECEIPT_TTL_MS = 60 * 60 * 1000;

/** What a capability lets its bearer do. */
export interface DeviceProfileGrant {
  readonly m: "register" | "identify";
  /** The signed-in email that asked, lower-cased. */
  readonly e: string;
  /** The device name a `register` saves. */
  readonly n?: string;
  /** The build page an `identify` returns to. */
  readonly b?: string;
}

/** What a receipt says: this UDID answered this person's profile. */
export interface DeviceReceipt {
  readonly u: string;
  readonly e: string;
}

type Signed<T> = T & { readonly p: string; readonly x: number };

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );

const hmac = async (key: BufferSource, message: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(message),
    ),
  );

const signatureOf = async (secret: string, body: string) =>
  base64Url(await hmac(await hmac(encoder.encode(secret), KEY_CONTEXT), body));

const sign = async <T extends object>(
  secret: string,
  purpose: string,
  payload: T,
  expiresAtMs: number,
): Promise<string> => {
  const body = base64Url(
    encoder.encode(
      JSON.stringify({ ...payload, p: purpose, x: Math.floor(expiresAtMs) }),
    ),
  );
  return `${body}.${await signatureOf(secret, body)}`;
};

const TOKEN = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/u;

/**
 * The payload of a token signed for `purpose`, `expired`, or `invalid`. The
 * expiry counts only under a signature that holds.
 */
const verify = async <T extends object>(
  secret: string,
  purpose: string,
  token: string,
  now: number,
): Promise<Signed<T> | "expired" | "invalid"> => {
  const match = TOKEN.exec(token);
  if (match === null) return "invalid";
  const [, body, signature] = match as unknown as [string, string, string];
  if (!sameSecret(signature, await signatureOf(secret, body))) {
    return "invalid";
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return "invalid";
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { p?: unknown }).p !== purpose ||
    typeof (payload as { x?: unknown }).x !== "number"
  ) {
    return "invalid";
  }
  return now >= (payload as { x: number }).x
    ? "expired"
    : (payload as Signed<T>);
};

const PROFILE_PURPOSE = "device-profile";
const RECEIPT_PURPOSE = "device-receipt";

export const createDeviceProfileToken = (
  secret: string,
  grant: DeviceProfileGrant,
  now: number = Date.now(),
) => sign(secret, PROFILE_PURPOSE, grant, now + DEVICE_PROFILE_TOKEN_TTL_MS);

export const verifyDeviceProfileToken = async (
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<DeviceProfileGrant | "expired" | "invalid"> => {
  const verified = await verify<DeviceProfileGrant>(
    secret,
    PROFILE_PURPOSE,
    token,
    now,
  );
  if (typeof verified === "string") return verified;
  if (
    (verified.m !== "register" && verified.m !== "identify") ||
    typeof verified.e !== "string" ||
    (verified.n !== undefined && typeof verified.n !== "string") ||
    (verified.b !== undefined && typeof verified.b !== "string")
  ) {
    return "invalid";
  }
  return {
    m: verified.m,
    e: verified.e,
    ...(verified.n === undefined ? {} : { n: verified.n }),
    ...(verified.b === undefined ? {} : { b: verified.b }),
  };
};

export const createDeviceReceipt = (
  secret: string,
  receipt: DeviceReceipt,
  now: number = Date.now(),
) => sign(secret, RECEIPT_PURPOSE, receipt, now + DEVICE_RECEIPT_TTL_MS);

export const verifyDeviceReceipt = async (
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<DeviceReceipt | "expired" | "invalid"> => {
  const verified = await verify<DeviceReceipt>(
    secret,
    RECEIPT_PURPOSE,
    token,
    now,
  );
  if (typeof verified === "string") return verified;
  if (typeof verified.u !== "string" || typeof verified.e !== "string") {
    return "invalid";
  }
  return { u: verified.u, e: verified.e };
};
