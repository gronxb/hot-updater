import { createServerFn } from "@tanstack/react-start";

export type { BundleSigningInspection } from "./server/bundle-signing.server";

export const getBundleSigningInspection = async () => {
  const [{ prepareConfig }, { inspectBundleSigning }] = await Promise.all([
    import("./server/config.server"),
    import("./server/bundle-signing.server"),
  ]);
  const { config } = await prepareConfig();
  return inspectBundleSigning(config.signing);
};

export const getBundleSigningInspectionRpc = createServerFn({
  method: "GET",
}).handler(getBundleSigningInspection);
