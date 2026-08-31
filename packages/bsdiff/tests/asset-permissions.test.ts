import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HDIFF_WASM_PATH = path.resolve(__dirname, "../assets/hdiff.wasm");

it("stores hdiff.wasm as a non-executable asset", async () => {
  const { mode } = await stat(HDIFF_WASM_PATH);

  expect(mode & 0o111).toBe(0);
});
