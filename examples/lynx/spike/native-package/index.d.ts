export declare function readNativeModules(): {
  HotUpdaterLynxSpike?: Record<
    string,
    (
      callback: (
        reply:
          | { ok: true; data: Record<string, unknown> }
          | { ok: false; error: { code: string; message: string } },
      ) => void,
    ) => void
  >;
};

export declare function loadProbeFont(url: string): Promise<void>;

export declare function loadExternalBootstrap(
  url: string,
): Promise<{ lazyVariant: string }>;

export declare function loadDynamicProbe(url: string): Promise<string>;

export { probeHttp } from "./http.js";
