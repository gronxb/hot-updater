import { isUUIDv7 } from "@hot-updater/protocol";

import { nativeBuildDownloadPath } from "../native-builds";
import { qrCodePath } from "../qr-code";

/** The header that carries the download URL the QR code holds. */
export const DOWNLOAD_URL_HEADER = "x-hot-updater-download-url";

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
 * session. The response's `x-hot-updater-download-url` header is the URL.
 *
 * - 400: `build` is missing or not a UUIDv7;
 * - 405: a method other than GET or HEAD.
 */
export const serveNativeBuildQr = (request: Request): Response => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = refusal(405, "Method Not Allowed");
    response.headers.set("allow", "GET, HEAD");
    return response;
  }
  const id = new URL(request.url).searchParams.get("build");
  if (id === null || !isUUIDv7(id)) {
    return refusal(400, "Pass ?build=<native build ID>.");
  }
  const downloadUrl = nativeBuildDownloadUrl(request, id);
  const { size, path } = qrCodePath(downloadUrl);
  const pixels = size * MODULE_PX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect fill="#fff" width="${size}" height="${size}"/><path fill="#000" d="${path}"/></svg>`;
  return new Response(request.method === "HEAD" ? null : svg, {
    headers: {
      // The URL depends only on the build ID and the console's own address.
      "cache-control": "public, max-age=86400",
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      [DOWNLOAD_URL_HEADER]: downloadUrl,
    },
  });
};
