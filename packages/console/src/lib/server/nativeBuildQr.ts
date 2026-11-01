import { isUUIDv7 } from "@hot-updater/protocol";
import { createPreviewLink } from "@hot-updater/protocol/native-artifact";

import { nativeBuildDownloadPath } from "../native-builds";
import { qrCodePath } from "../qr-code";

/** The header that carries the download URL the QR code holds. */
export const DOWNLOAD_URL_HEADER = "x-hot-updater-download-url";

/** The header that carries the sandbox link the QR code holds. */
export const PREVIEW_LINK_HEADER = "x-hot-updater-preview-link";

/** The route that serves the QR code, under the console's own path. */
export const NATIVE_BUILD_QR_PATH = "/_hot-updater/native-builds/qr";

/** The pixel size of one module, so the image is legible at its own size. */
const MODULE_PX = 6;

const refusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

/** The image of a QR code, with the header that says what it holds. */
const qrImage = (
  request: Request,
  value: string,
  header: string,
  cacheControl: string,
) => {
  const { size, path } = qrCodePath(value);
  const pixels = size * MODULE_PX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect fill="#fff" width="${size}" height="${size}"/><path fill="#000" d="${path}"/></svg>`;
  return new Response(request.method === "HEAD" ? null : svg, {
    headers: {
      "cache-control": cacheControl,
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      [header]: value,
    },
  });
};

const refuseMethod = (request: Request) => {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const response = refusal(405, "Method Not Allowed");
  response.headers.set("allow", "GET, HEAD");
  return response;
};

/**
 * The URL of a native build's console download, under the console path the
 * QR request came to: the console answers it with a fresh storage URL on
 * each request, so it never expires.
 */
export const nativeBuildDownloadUrl = (request: Request, id: string) => {
  const url = new URL(request.url);
  const base = url.pathname.endsWith(NATIVE_BUILD_QR_PATH)
    ? url.pathname.slice(0, -NATIVE_BUILD_QR_PATH.length)
    : "";
  return `${url.origin}${base}${nativeBuildDownloadPath(id)}`;
};

/**
 * The QR code of a native build's download URL, `<console>/api/native-builds/
 * <id>/download`, as an SVG image, served at
 * `/_hot-updater/native-builds/qr?build=<id>` without a session: a pull
 * request comment shows it, and GitHub fetches a comment's images
 * anonymously. It reads nothing, no database and no storage, so it says
 * nothing about whether the build exists; the download itself asks for the
 * session. Anyone can ask for this image, so it never holds a signed link:
 * those come only to a caller the console let in. The response's
 * `x-hot-updater-download-url` header is the URL.
 *
 * - 400: `build` is missing or not a UUIDv7;
 * - 405: a method other than GET or HEAD.
 */
export const serveNativeBuildQr = (request: Request): Response => {
  const refused = refuseMethod(request);
  if (refused) return refused;
  const id = new URL(request.url).searchParams.get("build");
  if (id === null || !isUUIDv7(id)) {
    return refusal(400, "Pass ?build=<native build ID>.");
  }
  // The URL depends only on the build ID and the console's own address.
  return qrImage(
    request,
    nativeBuildDownloadUrl(request, id),
    DOWNLOAD_URL_HEADER,
    "public, max-age=86400",
  );
};

/** An app ID as `bundleIdentifier` and `packageName` hold one. */
const APP_ID = /^[A-Za-z][A-Za-z0-9._-]{0,254}$/;
/** A channel a pull request previews on, such as `pr-12` or `pr-12-tv`. */
const CHANNEL = /^[A-Za-z0-9._-]{1,128}$/;
/** A fingerprint hash: `@expo/fingerprint`'s SHA-1, or cli-tools' SHA-256. */
const FINGERPRINT = /^[a-f0-9]{40,64}$/;

/**
 * The QR code of a sandbox preview link, `hu-sandbox-<app ID>://hot-updater/
 * preview?channel=<channel>&fingerprint=<hash>`, as an SVG image, served at
 * `/_hot-updater/native-builds/preview-qr?app=&channel=&fingerprint=` without a
 * session, as a pull request comment shows it. The link holds no secret, this
 * reads nothing, and it mints nothing. It takes the link's three parts rather
 * than the link: each has a narrow alphabet, and `createPreviewLink` writes the
 * rest, so no request gets any other text into a QR code. The response's
 * `x-hot-updater-preview-link` header is the link.
 *
 * - 400: a part is missing or isn't what a sandbox build has;
 * - 405: a method other than GET or HEAD.
 */
export const serveSandboxPreviewQr = (request: Request): Response => {
  const refused = refuseMethod(request);
  if (refused) return refused;
  const query = new URL(request.url).searchParams;
  const appId = query.get("app");
  const channel = query.get("channel");
  const fingerprintHash = query.get("fingerprint");
  const usage = "Pass ?app=<app ID>&channel=<channel>&fingerprint=<hash>.";
  if (
    appId === null ||
    channel === null ||
    fingerprintHash === null ||
    !APP_ID.test(appId) ||
    !CHANNEL.test(channel) ||
    !FINGERPRINT.test(fingerprintHash)
  ) {
    return refusal(400, usage);
  }
  let link: string;
  try {
    link = createPreviewLink({ appId, channel, fingerprintHash });
  } catch {
    return refusal(400, usage);
  }
  // The link depends only on the query.
  return qrImage(request, link, PREVIEW_LINK_HEADER, "public, max-age=86400");
};
