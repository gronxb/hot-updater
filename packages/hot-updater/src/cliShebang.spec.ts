import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

describe("cli entry shebang", () => {
  // Yarn Classic's Windows cmd shim reads the first token after `env` as the
  // interpreter, so any extra `env` argument becomes the program name.
  it("passes no extra arguments to /usr/bin/env", () => {
    const entryPath = path.join(__dirname, "index.ts");
    const [firstLine] = fs.readFileSync(entryPath, "utf-8").split(/\r?\n/);

    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});
