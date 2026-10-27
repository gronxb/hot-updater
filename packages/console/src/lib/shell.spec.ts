import { describe, expect, it } from "vitest";

import { shellQuote } from "./shell";

describe("shellQuote", () => {
  it("keeps a plain word as it is", () => {
    expect(shellQuote("app-release.apk")).toBe("app-release.apk");
    expect(shellQuote("https://storage.example.com/app.apk")).toBe(
      "https://storage.example.com/app.apk",
    );
  });

  it("single-quotes anything a shell would expand or split", () => {
    expect(shellQuote("My App.apk")).toBe("'My App.apk'");
    expect(shellQuote("$(touch x).apk")).toBe("'$(touch x).apk'");
    expect(shellQuote("`id`.apk")).toBe("'`id`.apk'");
    expect(shellQuote("it's.apk")).toBe("'it'\\''s.apk'");
    expect(shellQuote("")).toBe("''");
  });
});
