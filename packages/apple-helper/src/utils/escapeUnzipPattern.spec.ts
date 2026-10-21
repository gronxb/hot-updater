import { describe, expect, it } from "vitest";

import { escapeUnzipPattern } from "./escapeUnzipPattern";

describe("escapeUnzipPattern", () => {
  it("escapes the wildcards unzip reads in a member name", () => {
    expect(escapeUnzipPattern("Payload/My[Dev]*?.app/Info.plist")).toBe(
      "Payload/My\\[Dev\\]\\*\\?.app/Info.plist",
    );
    expect(escapeUnzipPattern("Payload/C:\\App.app/main.jsbundle")).toBe(
      "Payload/C:\\\\App.app/main.jsbundle",
    );
  });

  it("leaves a plain name as it is", () => {
    expect(escapeUnzipPattern("Payload/My App.app/Info.plist")).toBe(
      "Payload/My App.app/Info.plist",
    );
  });
});
