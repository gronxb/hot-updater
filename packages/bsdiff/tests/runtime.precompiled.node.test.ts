import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBspatch, equalsBytes, readFixtureHbc } from "./test-helpers.js";

type NodeRuntimeModule = typeof import("../src/node.js");
type CoreModule = typeof import("../src/hdiff.js");

describe.sequential("runtime: node precompiled entry", () => {
  afterEach(() => {
    clearHdiffGlobals();
    vi.resetModules();
    restoreWebAssemblyInstantiate();
  });

  it("succeeds even when BufferSource wasm instantiation is blocked", async () => {
    const [base, next] = await Promise.all([
      readFixtureHbc("one"),
      readFixtureHbc("two"),
    ]);

    blockBufferSourceInstantiate();
    const { hdiff } = await importFreshNodeRuntime();

    const patch = await hdiff(base, next);
    expect(Buffer.from(patch.subarray(0, 8)).toString("ascii")).toBe(
      "BSDIFF40",
    );
    expect(patch.byteLength).toBeGreaterThan(0);

    restoreWebAssemblyInstantiate();
    const restored = await applyBspatch(base, patch);
    expect(equalsBytes(restored, next)).toBe(true);
  });

  it("fails when bypassing runtime entry and importing core hdiff directly", async () => {
    const [base, next] = await Promise.all([
      readFixtureHbc("one"),
      readFixtureHbc("two"),
    ]);
    const { hdiff } = await importFreshCore();

    await expect(hdiff(base, next)).rejects.toThrow(
      /No precompiled .* WASM configured/,
    );
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
    imports?: WebAssembly.Imports,
  ) => {
    if (isBufferSource(source)) {
      throw new WebAssembly.CompileError(
        "Wasm code generation disallowed by embedder",
      );
    }
    return nativeInstantiate(source, imports);
  }) as typeof WebAssembly.instantiate;

  (WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate =
    patched;
  restoreInstantiateFn = () => {
    (
      WebAssembly as { instantiate: typeof WebAssembly.instantiate }
    ).instantiate = nativeInstantiate;
    restoreInstantiateFn = undefined;
  };
}

function restoreWebAssemblyInstantiate(): void {
  restoreInstantiateFn?.();
}

function isBufferSource(value: unknown): value is BufferSource {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

async function importFreshNodeRuntime(): Promise<NodeRuntimeModule> {
  vi.resetModules();
  return await import("../src/node.js");
}

async function importFreshCore(): Promise<CoreModule> {
  vi.resetModules();
  return await import("../src/hdiff.js");
}

function clearHdiffGlobals(): void {
  delete (globalThis as { __HDIFF_PRECOMPILED_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_WASM__;
  delete (globalThis as { __HDIFF_PRECOMPILED_HERMES_HBC_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_HERMES_HBC_WASM__;
  delete (globalThis as { __HDIFF_PRECOMPILED_BSDIFF_WASM__?: unknown })
    .__HDIFF_PRECOMPILED_BSDIFF_WASM__;
}
