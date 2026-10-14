/**
 * Vercel's CDN keys a cached response on the request's exact
 * Accept-Encoding, so `Vary: Accept-Encoding` keeps one copy of a catalog
 * per client header, each refreshed on its own. The Function answers
 * uncompressed and the CDN compresses each delivery, so the header only
 * splits the cache: it is dropped, and the other varied headers stay.
 */
export const withoutEncodingVary = (response: Response): Response => {
  const vary = response.headers.get("vary");
  if (vary === null || !/accept-encoding/i.test(vary)) return response;
  const kept = vary
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header && header.toLowerCase() !== "accept-encoding");
  const headers = new Headers(response.headers);
  if (kept.length === 0) headers.delete("vary");
  else headers.set("vary", kept.join(", "));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
