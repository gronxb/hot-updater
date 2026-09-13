// Private G1 probe. Importing this module never reads or invokes NativeModules.
type Reply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

export type SpikeModules = {
  HotUpdaterLynxSpike?: Record<
    string,
    (callback: (reply: Reply) => void) => void
  >;
};

declare const __SPIKE_VARIANT__: string;
declare const __SPIKE_BEHAVIOR__: string;
declare const __SPIKE_RESOURCES__: boolean;
declare const __SPIKE_LAZY__: boolean;
declare const __SPIKE_EXTERNAL__: boolean;
declare const __SPIKE_DYNAMIC__: boolean;
declare const __SPIKE_HTTP__: boolean;
declare const __SPIKE_ASSET_PREFIX__: string;

export const variant = __SPIKE_VARIANT__;
export const imageUrl = `${__SPIKE_ASSET_PREFIX__}assets/probe.png`;
export const resources = __SPIKE_RESOURCES__;
let imageReady = false;
let completeImage: (() => void) | undefined;

export function imageLoaded() {
  imageReady = true;
  completeImage?.();
}

function call(modules: SpikeModules, method: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    if (!modules.HotUpdaterLynxSpike?.[method]) {
      reject(new Error(`Native bridge unavailable: ${method}`));
      return;
    }
    modules.HotUpdaterLynxSpike[method](resolve);
  });
}

export async function startSpike(
  status: (message: string) => void,
  readModules: () => SpikeModules,
  loadFont?: (url: string) => Promise<void>,
  fontRegistered?: () => void,
  importBootstrap?: () => Promise<{ lazyVariant: string }>,
  loadExternal?: (url: string) => Promise<{ lazyVariant: string }>,
  loadDynamic?: (url: string) => Promise<string>,
  probeHttp?: () => Promise<string>,
) {
  try {
    status(`Bundle ${variant}: background bootstrap`);
    const http = __SPIKE_HTTP__ ? await probeHttp?.() : undefined;
    if (http) status(http);
    const modules = readModules();
    const [launch, failure] = await Promise.all([
      call(modules, "getLaunchInfo"),
      call(modules, "probeError"),
    ]);
    if (!launch.ok) throw new Error(launch.error.message);
    if (failure.ok) throw new Error("Expected asynchronous native error reply");
    console.log(
      "HOT_UPDATER_G1_BRIDGE",
      JSON.stringify({ variant, launch, failure }),
    );
    status(`Bundle ${variant}: bridge OK; waiting for image`);
    if (!imageReady)
      await new Promise<void>((resolve) => {
        completeImage = resolve;
      });
    if (__SPIKE_RESOURCES__) {
      if (!loadFont) throw new Error("Font loader not supplied");
      const font = `${__SPIKE_ASSET_PREFIX__}assets/probe.ttf`;
      await loadFont(font);
      fontRegistered?.();
      if (__SPIKE_DYNAMIC__) {
        const marker = await loadDynamic?.(
          `${__SPIKE_ASSET_PREFIX__}dynamic/component.lynx.bundle`,
        );
        if (marker !== variant)
          throw new Error("Missing or mixed release native dynamic component");
      }
      const lazy = __SPIKE_EXTERNAL__
        ? await loadExternal?.(`${__SPIKE_ASSET_PREFIX__}assets/bootstrap.js`)
        : __SPIKE_LAZY__
          ? await importBootstrap?.()
          : undefined;
      if (
        (__SPIKE_LAZY__ || __SPIKE_EXTERNAL__) &&
        lazy?.lazyVariant !== variant
      )
        throw new Error("Missing or mixed release lazy chunk");
      console.log(
        "HOT_UPDATER_G1_RESOURCES",
        JSON.stringify({ variant, lazy: lazy?.lazyVariant, font }),
      );
    }
    if (__SPIKE_BEHAVIOR__ === "fatal")
      throw new Error("G1 intentional startup failure");
    if (__SPIKE_BEHAVIOR__ === "unconfirmed") {
      status(`Bundle ${variant}: ready deliberately withheld`);
      return;
    }
    const ready = await call(modules, "notifyReady");
    if (!ready.ok) throw new Error(ready.error.message);
    if (__SPIKE_BEHAVIOR__ === "double-ready") {
      const repeated = await call(modules, "notifyReady");
      if (!repeated.ok) throw new Error(repeated.error.message);
      console.log(
        "HOT_UPDATER_G1_REPEATED_READY",
        JSON.stringify({ variant, repeated }),
      );
    }
    console.log("HOT_UPDATER_G1_READY", JSON.stringify({ variant, ready }));
    status(http ?? `Bundle ${variant}: image + bridge + app ready`);
  } catch (error) {
    status(`Bundle ${variant}: ${String(error)}`);
    console.error("HOT_UPDATER_G1_FAILURE", String(error));
    if (__SPIKE_BEHAVIOR__ === "fatal") throw error;
  }
}
