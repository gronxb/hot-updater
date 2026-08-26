import { describe, expect, it } from "vitest";

import { formatApiKeyNote } from "./apiKeyNote";

describe("formatApiKeyNote", () => {
  it("keeps the API key note limited to the key", () => {
    expect(formatApiKeyNote("issued-api-key")).toBe("issued-api-key");
  });
});
