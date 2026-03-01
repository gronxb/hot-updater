import { HdiffError } from "../errors.js";

type HermesValidateExports = {
  memory: WebAssembly.Memory;
  validate: (ptr: number, len: number) => number;
  version: (ptr: number) => number;
  alloc?: (len: number) => number;
  dealloc?: (ptr: number, len: number) => void;
};

type ValidatedHbc = {
  version: number;
};

const enum ValidateCode {
  OK = 0,
  TOO_SMALL = 1,
  INVALID_MAGIC = 2,
  DELTA_MAGIC = 3,
  INVALID_LENGTH = 4,
}

let wasmPromise: Promise<HermesValidateExports> | undefined;

export async function validateExecutionHbc(input: Uint8Array): Promise<ValidatedHbc> {
  const wasm = await getHermesValidator();
  if (typeof wasm.alloc === "function" && typeof wasm.dealloc === "function") {
    const ptr = wasm.alloc(input.byteLength);
    try {
      if (input.byteLength > 0) {
        new Uint8Array(wasm.memory.buffer, ptr, input.byteLength).set(input);
      }

      const code = wasm.validate(ptr, input.byteLength);
      if (code !== ValidateCode.OK) {
        throw mapValidationError(code);
      }

      return { version: wasm.version(ptr) >>> 0 };
    } finally {
      if (input.byteLength > 0) {
        wasm.dealloc(ptr, input.byteLength);
      }
    }
  }

  ensureMemorySize(wasm.memory, input.byteLength);
  const view = new Uint8Array(wasm.memory.buffer, 0, input.byteLength);
  view.set(input);

  const code = wasm.validate(0, input.byteLength);
  if (code !== ValidateCode.OK) {
    throw mapValidationError(code);
  }

  return { version: wasm.version(0) >>> 0 };
}

async function getHermesValidator(): Promise<HermesValidateExports> {
  wasmPromise ??= loadHermesValidator();
  return wasmPromise;
}

async function loadHermesValidator(): Promise<HermesValidateExports> {
  const precompiled = getPrecompiledHermesModule();
  const directExports = asHermesExports(precompiled);
  if (directExports) {
    return directExports;
  }

  if (isWasmModuleLike(precompiled)) {
    const instance = await WebAssembly.instantiate(precompiled);
    return toHermesExports(instance.exports);
  }

  const instance = (await WebAssembly.instantiate(await loadWasmBytes(resolveHermesWasmUrl())))
    .instance;
  return toHermesExports(instance.exports);
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

  throw new HdiffError("INVALID_HBC", `Unable to load WASM from ${urlText}`);
}

function resolveHermesWasmUrl(): string {
  const overrideBase = (globalThis as { __HDIFF_WASM_BASE_URL__?: unknown }).__HDIFF_WASM_BASE_URL__;
  if (typeof overrideBase === "string" && overrideBase.length > 0) {
    try {
      return new URL("hdiff.wasm", overrideBase).toString();
    } catch {
      // ignore
    }
  }

  const forceWorkerShim =
    (globalThis as { __HDIFF_FORCE_WORKER_SHIM__?: unknown }).__HDIFF_FORCE_WORKER_SHIM__ ===
    true;
  if (forceWorkerShim && typeof location !== "undefined" && typeof location.origin === "string") {
    return new URL("/vendor/hermes-bundle-diff/hdiff.wasm", location.origin).toString();
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

function getPrecompiledHermesModule(): unknown {
  const mod = (globalThis as { __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_HERMES_HBC_WASM__;
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default?: unknown }).default;
  }
  return mod;
}

function ensureMemorySize(memory: WebAssembly.Memory, requiredBytes: number): void {
  const pageSize = 64 * 1024;
  const currentBytes = memory.buffer.byteLength;
  if (currentBytes >= requiredBytes) {
    return;
  }

  const bytesNeeded = requiredBytes - currentBytes;
  const additionalPages = Math.ceil(bytesNeeded / pageSize);
  memory.grow(additionalPages);
}

function mapValidationError(code: number): HdiffError {
  if (code === ValidateCode.DELTA_MAGIC) {
    return new HdiffError(
      "NON_EXECUTION_FORM",
      "Input HBC is delta-form. execution-form HBC is required."
    );
  }
  if (
    code === ValidateCode.TOO_SMALL ||
    code === ValidateCode.INVALID_MAGIC ||
    code === ValidateCode.INVALID_LENGTH
  ) {
    return new HdiffError("INVALID_HBC", "Input is not a valid execution-form HBC");
  }
  return new HdiffError("INVALID_HBC", `Unknown Hermes validation error: ${code}`);
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

function toHermesExports(source: unknown): HermesValidateExports {
  const direct = asHermesExports(source);
  if (direct) {
    return direct;
  }

  throw new HdiffError("INVALID_HBC", "Hermes validator WASM exports are incomplete");
}

function asHermesExports(source: unknown): HermesValidateExports | undefined {
  if (source && typeof source === "object") {
    const maybe = source as Partial<HermesValidateExports>;
    if (
      isWasmMemoryLike(maybe.memory) &&
      typeof maybe.validate === "function" &&
      typeof maybe.version === "function"
    ) {
      return maybe as HermesValidateExports;
    }
  }
  return undefined;
}
