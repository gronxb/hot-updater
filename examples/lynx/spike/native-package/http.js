export async function probeHttp() {
  const capabilities = {
    fetch: typeof fetch,
    globalFetch: typeof globalThis.fetch,
    lynxFetch: typeof lynx.fetch,
    abortController: typeof AbortController,
    nativeFetchModule: typeof NativeModules.LynxFetchModule,
  };
  console.log("HOT_UPDATER_HTTP_CAPABILITIES", JSON.stringify(capabilities));
  const summary = `fetch=${capabilities.fetch}; globalFetch=${capabilities.globalFetch}; AbortController=${capabilities.abortController}; nativeFetch=${capabilities.nativeFetchModule}`;
  if (typeof fetch !== "function" || typeof AbortController !== "function")
    return `HTTP unavailable; ${summary}`;

  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        const response = await fetch("http://127.0.0.1:18791/health", {
          signal: controller.signal,
        });
        const body = await response.text();
        return { status: response.status, body: body.slice(0, 500) };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("HTTP diagnostic timed out after 5000 ms"));
        }, 5000);
      }),
    ]);
    console.log("HOT_UPDATER_HTTP_RESULT", JSON.stringify(result));
    return `HTTP ${result.status}: ${result.body}; ${summary}`;
  } catch (error) {
    console.error("HOT_UPDATER_HTTP_FAILURE", String(error));
    return `HTTP failed: ${String(error)}; ${summary}`;
  } finally {
    clearTimeout(timer);
  }
}
