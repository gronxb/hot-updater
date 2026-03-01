import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBspatch, equalsBytes, readFixtureHbc } from "./test-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const HDIFF_WASM_PATH = path.resolve(ROOT, "assets/hdiff.wasm");

type HdiffModule = typeof import("../src/index.js");

describe.sequential("runtime: precompiled wasm fallback", () => {
  afterEach(() => {
    clearHdiffGlobals();
    vi.resetModules();
    restoreWebAssemblyInstantiate();
  });

  it("fails when BufferSource wasm instantiation is blocked and precompiled modules are absent", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");

    blockBufferSourceInstantiate();
    const { hdiff } = await importFreshHdiff();

    await expect(hdiff(base, next)).rejects.toThrow(/Wasm code generation disallowed by embedder/);
  });

  it("succeeds with precompiled modules when BufferSource wasm instantiation is blocked", async () => {
    const [base, next, hdiffWasmBytes] = await Promise.all([
      readFixtureHbc("one"),
      readFixtureHbc("two"),
      fs.readFile(HDIFF_WASM_PATH),
    ]);

    const hdiffModule = await WebAssembly.compile(hdiffWasmBytes);

    (
      globalThis as {
        __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: WebAssembly.Module;
        __HDIFF_PRECOMPILED_BSDIFF_WASM__?: WebAssembly.Module;
      }
    ).__HDIFF_PRECOMPILED_HERMES_HBC_WASM__ = hdiffModule;

    (
      globalThis as {
        __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: WebAssembly.Module;
        __HDIFF_PRECOMPILED_BSDIFF_WASM__?: WebAssembly.Module;
      }
    ).__HDIFF_PRECOMPILED_BSDIFF_WASM__ = hdiffModule;

    blockBufferSourceInstantiate();
    const { hdiff } = await importFreshHdiff();

    const patch = await hdiff(base, next);
    expect(Buffer.from(patch.subarray(0, 8)).toString("ascii")).toBe("BSDIFF40");
    expect(patch.byteLength).toBeGreaterThan(0);

    restoreWebAssemblyInstantiate();
    const restored = await applyBspatch(base, patch);
    expect(equalsBytes(restored, next)).toBe(true);
  });
});

let restoreInstantiateFn: (() => void) | undefined;

function blockBufferSourceInstantiate(): void {
  if (restoreInstantiateFn) {
    restoreInstantiateFn();
  }

  const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  const patched = ((
    source: BufferSource | WebAssembly.Module,
    imports?: WebAssembly.Imports
  ) => {
    if (isBufferSource(source)) {
      throw new WebAssembly.CompileError("Wasm code generation disallowed by embedder");
    }
    return nativeInstantiate(source, imports);
  }) as typeof WebAssembly.instantiate;

  (WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate = patched;
  restoreInstantiateFn = () => {
    (WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate = nativeInstantiate;
    restoreInstantiateFn = undefined;
  };
}

function restoreWebAssemblyInstantiate(): void {
  restoreInstantiateFn?.();
}

function isBufferSource(value: unknown): value is BufferSource {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

async function importFreshHdiff(): Promise<HdiffModule> {
  vi.resetModules();
  return await import("../src/index.js");
}

function clearHdiffGlobals(): void {
  delete (globalThis as { __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_HERMES_HBC_WASM__;
  delete (globalThis as { __HDIFF_PRECOMPILED_BSDIFF_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_BSDIFF_WASM__;
  delete (globalThis as { __HDIFF_WASM_BASE_URL__?: unknown }).__HDIFF_WASM_BASE_URL__;
  delete (globalThis as { __HDIFF_FORCE_WORKER_SHIM__?: unknown }).__HDIFF_FORCE_WORKER_SHIM__;
}
