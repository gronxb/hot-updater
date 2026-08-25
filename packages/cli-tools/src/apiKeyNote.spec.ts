import { describe, expect, it } from "vitest";

import { formatApiKeyNote } from "./apiKeyNote";

describe("formatApiKeyNote", () => {
  it("shows the plaintext API key with separate storage guidance", () => {
    expect(formatApiKeyNote("issued-api-key")).toBe(
      "issued-api-key\n\nStore this API key separately in a secure place.",
    );
  });
});
