/**
 * The console's address and path as a phone reached it, without a trailing
 * slash, from a request to `routePath` under it. A proxy that ends TLS says so
 * in `x-forwarded-proto`, which only upgrades the scheme: the answer goes back
 * to whoever sent the header, and is never cached.
 */
export const publicConsoleBase = (request: Request, routePath: string) => {
  const url = new URL(request.url);
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const base = url.pathname.endsWith(routePath)
    ? url.pathname.slice(0, -routePath.length)
    : "";
  return `${forwarded === "https" ? "https:" : url.protocol}//${url.host}${base}`;
};
