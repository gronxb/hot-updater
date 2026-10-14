import { describe, expect, it } from "vitest";

import { withoutEncodingVary } from "./withoutEncodingVary";

describe("withoutEncodingVary", () => {
  it("keeps the other varied headers of a cacheable response", async () => {
    const response = withoutEncodingVary(
      new Response("{}", {
        headers: {
          "cdn-cache-control": "public, max-age=5",
          vary: "Accept-Encoding, x-api-key",
        },
        status: 200,
      }),
    );

    expect(response.headers.get("vary")).toBe("x-api-key");
    expect(response.headers.get("cdn-cache-control")).toBe("public, max-age=5");
    expect(await response.text()).toBe("{}");
  });

  it("drops a Vary that names only Accept-Encoding", () => {
    const response = withoutEncodingVary(
      new Response(null, { headers: { vary: "accept-encoding" }, status: 404 }),
    );

    expect(response.headers.has("vary")).toBe(false);
    expect(response.status).toBe(404);
  });

  it("returns a response without Accept-Encoding in Vary as it is", () => {
    const original = new Response(null, { headers: { vary: "x-api-key" } });

    expect(withoutEncodingVary(original)).toBe(original);
  });
});
