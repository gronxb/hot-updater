import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBsdiffPatch } from "../src/internal/bsdiff.js";
import { type Bytes } from "../src/internal/bytes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

export async function readFixtureHbc(name: "one" | "two"): Promise<Bytes> {
  const fixturePath = path.resolve(
    ROOT,
    "fixture",
    name,
    "index.ios.bundle.hbc",
  );
  const bytes = await fs.readFile(fixturePath);
  return new Uint8Array(bytes);
}

export async function applyBspatch(
  base: Bytes,
  patch: Bytes,
): Promise<Bytes> {
  return await applyBsdiffPatch(base, patch);
}

export function toDeltaMagic(input: Uint8Array): Uint8Array {
  const copy = new Uint8Array(input);
  setU64Le(copy, 0, 0xe0e6fc3efc43e039n);
  return copy;
}

export function withVersion(input: Uint8Array, version: number): Uint8Array {
  const copy = new Uint8Array(input);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(8, version >>> 0, true);
  return copy;
}

export function withFileLength(
  input: Uint8Array,
  fileLength: number,
): Uint8Array {
  const copy = new Uint8Array(input);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(32, fileLength >>> 0, true);
  return copy;
}

export function equalsBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function setU64Le(buffer: Uint8Array, offset: number, value: bigint): void {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  view.setUint32(offset, Number(value & 0xffff_ffffn), true);
  view.setUint32(offset + 4, Number((value >> 32n) & 0xffff_ffffn), true);
}
