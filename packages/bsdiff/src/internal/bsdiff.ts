import { HdiffError } from "../errors.js";

type BsdiffExports = {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  create_patch: (basePtr: number, baseLen: number, nextPtr: number, nextLen: number) => number;
  apply_patch: (basePtr: number, baseLen: number, patchPtr: number, patchLen: number) => number;
  output_ptr: () => number;
  output_len: () => number;
  free_output: () => void;
};

const enum BsdiffStatus {
  OK = 0,
  INVALID_INPUT = 1,
  PATCH_FAILED = 2,
  INVALID_PATCH = 3,
}

let wasmPromise: Promise<BsdiffExports> | undefined;

export async function createBsdiffPatch(base: Uint8Array, next: Uint8Array): Promise<Uint8Array> {
  const wasm = await getBsdiffWasm();

  const status = runBinaryOperation(wasm, base, next, (basePtr, baseLen, nextPtr, nextLen) =>
    wasm.create_patch(basePtr, baseLen, nextPtr, nextLen)
  );

  if (status !== BsdiffStatus.OK) {
    throw mapPatchError(status);
  }

  return readAndFreeOutput(wasm);
}

export async function applyBsdiffPatch(base: Uint8Array, patch: Uint8Array): Promise<Uint8Array> {
  const wasm = await getBsdiffWasm();

  const status = runBinaryOperation(wasm, base, patch, (basePtr, baseLen, patchPtr, patchLen) =>
    wasm.apply_patch(basePtr, baseLen, patchPtr, patchLen)
  );

  if (status !== BsdiffStatus.OK) {
    throw mapApplyError(status);
  }

  return readAndFreeOutput(wasm);
}

function runBinaryOperation(
  wasm: BsdiffExports,
  left: Uint8Array,
  right: Uint8Array,
  run: (leftPtr: number, leftLen: number, rightPtr: number, rightLen: number) => number
): number {
  const leftPtr = wasm.alloc(left.byteLength);
  const rightPtr = wasm.alloc(right.byteLength);

  try {
    writeBytesToMemory(wasm.memory, leftPtr, left);
    writeBytesToMemory(wasm.memory, rightPtr, right);
    return run(leftPtr, left.byteLength, rightPtr, right.byteLength);
  } finally {
    if (left.byteLength > 0) {
      wasm.dealloc(leftPtr, left.byteLength);
    }
    if (right.byteLength > 0) {
      wasm.dealloc(rightPtr, right.byteLength);
    }
  }
}

function writeBytesToMemory(memory: WebAssembly.Memory, ptr: number, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    return;
  }
  new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
}

function readAndFreeOutput(wasm: BsdiffExports): Uint8Array {
  const outPtr = wasm.output_ptr();
  const outLen = wasm.output_len();

  if (outLen === 0) {
    wasm.free_output();
    return new Uint8Array();
  }

  const output = new Uint8Array(wasm.memory.buffer, outPtr, outLen);
  const copied = new Uint8Array(output);
  wasm.free_output();
  return copied;
}

function mapPatchError(status: number): HdiffError {
  if (status === BsdiffStatus.INVALID_INPUT) {
    return new HdiffError("PATCH_FAILED", "Invalid input bytes provided to bsdiff wasm");
  }
  if (status === BsdiffStatus.PATCH_FAILED) {
    return new HdiffError("PATCH_FAILED", "Failed to generate BSDIFF40 patch");
  }
  if (status === BsdiffStatus.INVALID_PATCH) {
    return new HdiffError("PATCH_FAILED", "Unexpected patch-validation status while creating patch");
  }
  return new HdiffError("PATCH_FAILED", `Unknown bsdiff wasm status: ${status}`);
}

function mapApplyError(status: number): HdiffError {
  if (status === BsdiffStatus.INVALID_INPUT) {
    return new HdiffError("PATCH_FAILED", "Invalid input bytes provided to bspatch wasm");
  }
  if (status === BsdiffStatus.INVALID_PATCH) {
    return new HdiffError("PATCH_FAILED", "Invalid BSDIFF40 patch bytes");
  }
  if (status === BsdiffStatus.PATCH_FAILED) {
    return new HdiffError("PATCH_FAILED", "Unexpected patch-generation status while applying patch");
  }
  return new HdiffError("PATCH_FAILED", `Unknown bspatch wasm status: ${status}`);
}

async function getBsdiffWasm(): Promise<BsdiffExports> {
  wasmPromise ??= loadBsdiffWasm();
  return wasmPromise;
}

async function loadBsdiffWasm(): Promise<BsdiffExports> {
  const precompiled = getPrecompiledBsdiffModule();
  const directExports = asBsdiffExports(precompiled);
  if (directExports) {
    return directExports;
  }

  if (isWasmModuleLike(precompiled)) {
    const instance = await WebAssembly.instantiate(precompiled);
    return toBsdiffExports(instance.exports);
  }

  const instance = (await WebAssembly.instantiate(await loadWasmBytes(resolveBsdiffWasmUrl())))
    .instance;
  return toBsdiffExports(instance.exports);
}

async function loadWasmBytes(urlText: string): Promise<ArrayBuffer> {
  const url = safeUrl(urlText);

  if (url?.protocol === "file:") {
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  if (typeof fetch === "function") {
    const response = await fetch(urlText);
    if (response.ok) {
      return await response.arrayBuffer();
    }
  }

  throw new HdiffError("PATCH_FAILED", `Unable to load WASM from ${urlText}`);
}

function resolveBsdiffWasmUrl(): string {
  const overrideBase = (globalThis as { __HDIFF_WASM_BASE_URL__?: unknown }).__HDIFF_WASM_BASE_URL__;
  if (typeof overrideBase === "string" && overrideBase.length > 0) {
    try {
      return new URL("hdiff.wasm", overrideBase).toString();
    } catch {
      // ignore
    }
  }

  try {
    return new URL("../../assets/hdiff.wasm", import.meta.url).toString();
  } catch {
    // ignore
  }

  if (typeof location !== "undefined" && typeof location.origin === "string") {
    return new URL("/vendor/hermes-bundle-diff/hdiff.wasm", location.origin).toString();
  }

  return "hdiff.wasm";
}

function safeUrl(urlText: string): URL | undefined {
  try {
    return new URL(urlText);
  } catch {
    return undefined;
  }
}

function getPrecompiledBsdiffModule(): unknown {
  const mod = (globalThis as { __HDIFF_PRECOMPILED_BSDIFF_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_BSDIFF_WASM__;
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default?: unknown }).default;
  }
  return mod;
}

function isWasmModuleLike(mod: unknown): mod is WebAssembly.Module {
  if (mod instanceof WebAssembly.Module) {
    return true;
  }
  return Object.prototype.toString.call(mod) === "[object WebAssembly.Module]";
}

function isWasmMemoryLike(memory: unknown): memory is WebAssembly.Memory {
  if (memory instanceof WebAssembly.Memory) {
    return true;
  }
  return Object.prototype.toString.call(memory) === "[object WebAssembly.Memory]";
}

function toBsdiffExports(source: unknown): BsdiffExports {
  const direct = asBsdiffExports(source);
  if (direct) {
    return direct;
  }

  throw new HdiffError("PATCH_FAILED", "bsdiff wasm exports are incomplete");
}

function asBsdiffExports(source: unknown): BsdiffExports | undefined {
  if (source && typeof source === "object") {
    const maybe = source as Partial<BsdiffExports>;
    if (
      isWasmMemoryLike(maybe.memory) &&
      typeof maybe.alloc === "function" &&
      typeof maybe.dealloc === "function" &&
      typeof maybe.create_patch === "function" &&
      typeof maybe.apply_patch === "function" &&
      typeof maybe.output_ptr === "function" &&
      typeof maybe.output_len === "function" &&
      typeof maybe.free_output === "function"
    ) {
      return maybe as BsdiffExports;
    }
  }
  return undefined;
}
