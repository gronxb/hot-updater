import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readFixtureHbc,
  toDeltaMagic,
  withFileLength,
} from "./test-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const HDIFF_WASM_PATH = path.resolve(ROOT, "assets/hdiff.wasm");

type HermesWasmExports = {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  validate: (ptr: number, len: number) => number;
  version: (ptr: number) => number;
};

describe("hermes-hbc wasm validator", () => {
  it("returns expected codes for header validation", async () => {
    const exports = await loadHermesWasmExports();

    const valid = await readFixtureHbc("one");
    expect(runValidate(exports, valid)).toBe(0);

    expect(runValidate(exports, valid.subarray(0, 16))).toBe(1);
    expect(runValidate(exports, new Uint8Array(128))).toBe(2);
    expect(runValidate(exports, toDeltaMagic(valid))).toBe(3);
    expect(
      runValidate(exports, withFileLength(valid, valid.byteLength + 1)),
    ).toBe(4);
  });

  it("reads version field from offset 8", async () => {
    const exports = await loadHermesWasmExports();
    const valid = await readFixtureHbc("one");

    const ptr = exports.alloc(valid.byteLength);
    try {
      writeToMemory(exports.memory, ptr, valid);

      const expected = new DataView(
        valid.buffer,
        valid.byteOffset,
        valid.byteLength,
      ).getUint32(8, true);
      expect(exports.version(ptr) >>> 0).toBe(expected >>> 0);
    } finally {
      exports.dealloc(ptr, valid.byteLength);
    }
  });
});

async function loadHermesWasmExports(): Promise<HermesWasmExports> {
  const bytes = await fs.readFile(HDIFF_WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports as unknown as HermesWasmExports;
}

function runValidate(exports: HermesWasmExports, input: Uint8Array): number {
  const ptr = exports.alloc(input.byteLength);
  try {
    if (input.byteLength > 0) {
      writeToMemory(exports.memory, ptr, input);
    }
    return exports.validate(ptr, input.byteLength);
  } finally {
    if (input.byteLength > 0) {
      exports.dealloc(ptr, input.byteLength);
    }
  }
}

function writeToMemory(
  memory: WebAssembly.Memory,
  ptr: number,
  input: Uint8Array,
): void {
  new Uint8Array(memory.buffer, ptr, input.byteLength).set(input);
}
