import type { SpikeModules } from "./bridge";

export { probeHttp } from "./native-package/http.js";

declare const NativeModules: SpikeModules;

export function readNativeModules(): SpikeModules {
  return typeof NativeModules === "undefined" ? {} : NativeModules;
}

export function loadProbeFont(url: string): Promise<void> {
  return new Promise((resolve) => {
    lynx.addFont(
      { "font-family": "ReleaseProbe", src: `url("${url}")` },
      resolve,
    );
  });
}

export function loadExternalBootstrap(
  url: string,
): Promise<{ lazyVariant: string }> {
  return new Promise((resolve, reject) => {
    lynx.requireModuleAsync<{ lazyVariant: string }>(url, (error, exports) => {
      if (error) reject(error);
      else if (exports) resolve(exports);
      else reject(new Error("External module returned no exports"));
    });
  });
}

export async function loadDynamicProbe(url: string): Promise<string> {
  const result = await lynx.loadDynamicComponent(url);
  if (result.code !== 0) throw new Error(JSON.stringify(result));
  const marker = lynx.getSharedData<string>("hotUpdaterG1Dynamic");
  console.log("HOT_UPDATER_G1_DYNAMIC", JSON.stringify({ result, marker }));
  return marker;
}
