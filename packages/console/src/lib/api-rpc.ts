import type { Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import type {
  DeleteBundleInput,
  GetBundleChildCountsInput,
  GetBundleChildrenInput,
  GetBundleDownloadUrlInput,
  GetBundleInput,
  GetBundlesInput,
  PromoteBundleInput,
  UpdateBundleInput,
} from "./server/api-operations.server";

// GET /api/config
export const getConfig = createServerFn().handler(async () => {
  try {
    const { getConfigOperation } =
      await import("./server/api-operations.server");
    return await getConfigOperation();
  } catch (error) {
    console.error("Error during config retrieval:", error);
    throw error;
  }
});

// GET /api/channels
export const getChannels = createServerFn().handler(async () => {
  try {
    const { getChannelsOperation } =
      await import("./server/api-operations.server");
    return await getChannelsOperation();
  } catch (error) {
    console.error("Error during channel retrieval:", error);
    throw error;
  }
});

// GET /api/config-loaded
export const getConfigLoaded = createServerFn().handler(async () => {
  try {
    const { getConfigLoadedOperation } =
      await import("./server/api-operations.server");
    return await getConfigLoadedOperation();
  } catch (error) {
    console.error("Error during config loaded retrieval:", error);
    throw error;
  }
});

export const getTelemetryKeyState = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      const { getTelemetryKeyStateOperation } =
        await import("./server/api-operations.server");
      return await getTelemetryKeyStateOperation();
    } catch (error) {
      console.error("Error during telemetry key retrieval:", error);
      throw error;
    }
  },
);

export const issueTelemetryKey = createServerFn({ method: "POST" }).handler(
  async () => {
    try {
      const { issueTelemetryKeyOperation } =
        await import("./server/api-operations.server");
      return await issueTelemetryKeyOperation();
    } catch (error) {
      console.error("Error during telemetry key issue:", error);
      throw error;
    }
  },
);

export const rotateTelemetryKey = createServerFn({ method: "POST" }).handler(
  async () => {
    try {
      const { rotateTelemetryKeyOperation } =
        await import("./server/api-operations.server");
      return await rotateTelemetryKeyOperation();
    } catch (error) {
      console.error("Error during telemetry key rotation:", error);
      throw error;
    }
  },
);

// GET /api/bundles
export const getBundles = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundlesInput | undefined) => input)
  .handler(async ({ data }) => {
    try {
      const { getBundlesOperation } =
        await import("./server/api-operations.server");
      return await getBundlesOperation(data);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

// GET /api/bundles/:bundleId
export const getBundle = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { getBundleOperation } =
        await import("./server/api-operations.server");
      return await getBundleOperation(data);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      throw error;
    }
  });

export const getBundleChildren = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildrenInput) => input)
  .handler(async ({ data }) => {
    try {
      const { getBundleChildrenOperation } =
        await import("./server/api-operations.server");
      return await getBundleChildrenOperation(data);
    } catch (error) {
      console.error("Error during bundle children retrieval:", error);
      throw error;
    }
  });

export const getBundleChildCounts = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleChildCountsInput) => input)
  .handler(async ({ data }) => {
    try {
      const { getBundleChildCountsOperation } =
        await import("./server/api-operations.server");
      return await getBundleChildCountsOperation(data);
    } catch (error) {
      console.error("Error during bundle child count retrieval:", error);
      throw error;
    }
  });

export const getBundleDownloadUrl = createServerFn({ method: "GET" })
  .inputValidator((input: GetBundleDownloadUrlInput) => input)
  .handler(async ({ data }) => {
    try {
      const { getBundleDownloadUrlOperation } =
        await import("./server/api-operations.server");
      return await getBundleDownloadUrlOperation(data);
    } catch (error) {
      console.error("Error during bundle download URL retrieval:", error);
      throw error;
    }
  });

// PATCH /api/bundles/:bundleId
export const updateBundle = createServerFn({ method: "POST" })
  .inputValidator((input: UpdateBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { updateBundleOperation } =
        await import("./server/api-operations.server");
      return await updateBundleOperation(data);
    } catch (error) {
      console.error("Error during bundle update:", error);
      throw error;
    }
  });

export const promoteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: PromoteBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { promoteBundleOperation } =
        await import("./server/api-operations.server");
      return await promoteBundleOperation(data);
    } catch (error) {
      console.error("Error during bundle promotion:", error);
      throw error;
    }
  });

// POST /api/bundles
export const createBundle = createServerFn({ method: "POST" })
  .inputValidator((input: Bundle) => input)
  .handler(async ({ data }) => {
    try {
      const { createBundleOperation } =
        await import("./server/api-operations.server");
      return await createBundleOperation(data);
    } catch (error) {
      console.error("Error during bundle creation:", error);
      throw error;
    }
  });

// DELETE /api/bundles/:bundleId
export const deleteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteBundleInput) => input)
  .handler(async ({ data }) => {
    try {
      const { deleteBundleOperation } =
        await import("./server/api-operations.server");
      return await deleteBundleOperation(data);
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      throw error;
    }
  });
