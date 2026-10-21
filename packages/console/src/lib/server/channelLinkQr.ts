import { createChannelLink } from "@hot-updater/protocol";

import { qrCodePath } from "../qr-code";

/** The header that carries the link the QR code holds. */
export const CHANNEL_LINK_HEADER = "x-hot-updater-channel-link";

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
 * The QR code of a channel's link, `<console.channelLinkPrefix>hot-updater/
 * channel/<channel>`, as an SVG image, served at
 * `/_hot-updater/preview/channel-qr?channel=<channel>` without a session: a
 * pull request comment shows it, and GitHub fetches the images of a comment
 * anonymously. It holds only the link, which the config's prefix and the
 * requested channel make, so it reads nothing else: no database, no storage.
 * The response's `x-hot-updater-channel-link` header is the link.
 *
 * - 400: `channel` is missing or not a channel name;
 * - 404: the console's config sets no `console.channelLinkPrefix`;
 * - 405: a method other than GET or HEAD.
 */
export const serveChannelLinkQr = async (
  request: Request,
  readPrefix: (request: Request) => Promise<string | undefined>,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = refusal(405, "Method Not Allowed");
    response.headers.set("allow", "GET, HEAD");
    return response;
  }
  const channel = new URL(request.url).searchParams.get("channel");
  if (channel === null) return refusal(400, "Pass ?channel=<channel>.");
  const prefix = await readPrefix(request);
  if (prefix === undefined) {
    return refusal(
      404,
      "This console's config sets no console.channelLinkPrefix.",
    );
  }
  let link: string;
  try {
    link = createChannelLink(prefix, channel);
  } catch {
    return refusal(400, "channel is not a channel name.");
  }

  const { size, path } = qrCodePath(link);
  const pixels = size * MODULE_PX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect fill="#fff" width="${size}" height="${size}"/><path fill="#000" d="${path}"/></svg>`;
  return new Response(request.method === "HEAD" ? null : svg, {
    headers: {
      // The link changes only with the config's prefix.
      "cache-control": "public, max-age=3600",
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      [CHANNEL_LINK_HEADER]: link,
    },
  });
};
