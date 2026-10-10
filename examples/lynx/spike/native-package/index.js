// Real native access, deferred until a background-owned application callback.
// This private dependency tests compiler handling of packaged SDK code.
export { probeHttp } from "./http.js";

export function readNativeModules() {
  return typeof NativeModules === "undefined" ? {} : NativeModules;
}

export function loadProbeFont(url) {
  return new Promise((resolve) => {
    lynx.addFont({ "font-family": "ReleaseProbe", src: `url("${url}")` }, resolve);
  });
}

export function loadExternalBootstrap(url) {
  return new Promise((resolve, reject) => {
    lynx.requireModuleAsync(url, (error, exports) => {
      if (error) reject(error);
      else if (exports) resolve(exports);
      else reject(new Error("External module returned no exports"));
    });
  });
}

export async function loadDynamicProbe(url) {
  const result = await lynx.loadDynamicComponent(url);
  if (result.code !== 0) throw new Error(JSON.stringify(result));
  const marker = lynx.getSharedData("hotUpdaterG1Dynamic");
  console.log("HOT_UPDATER_G1_DYNAMIC", JSON.stringify({ result, marker }));
  return marker;
}
