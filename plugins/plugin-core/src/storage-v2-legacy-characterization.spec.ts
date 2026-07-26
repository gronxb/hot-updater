import { describe, expect, it } from "vitest";

import {
  createNodeStoragePlugin,
  type NodeStoragePlugin,
  type RuntimeStoragePlugin,
  type StoragePlugin,
} from "./index";

const createLegacyNodeStorage = createNodeStoragePlugin({
  name: "legacy",
  supportedProtocol: "legacy",
  factory: () => ({
    delete: async (_storageUri: string) => undefined,
    downloadFile: async (_storageUri: string, _filePath: string) => undefined,
    exists: async (_storageUri: string) => true,
    upload: async (_key: string, _filePath: string) => ({
      storageUri: "legacy://bundle",
    }),
  }),
});

const nodeStorage: NodeStoragePlugin = createLegacyNodeStorage({})();
const rootStorage: StoragePlugin = nodeStorage;

type Assert<T extends true> = T;
type RuntimeStorageFitsGenericRoot = Assert<
  RuntimeStoragePlugin<{ readonly requestId: string }> extends
    StoragePlugin<{ readonly requestId: string }>
    ? true
    : false
>;

void rootStorage;

describe("legacy storage compatibility", () => {
  it("retains the legacy node storage identity", () => {
    expect(rootStorage.name).toBe("legacy");
    expect(rootStorage.supportedProtocol).toBe("legacy");
  });
});
