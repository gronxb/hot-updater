import type { SnakeCaseBundle } from "@hot-updater/core";
import type {
  BasePluginArgs,
  Bundle,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FirebaseDatabaseConfig,
  firebaseDatabase,
} from "./firebaseDatabase";

const {
  mockFirestore,
  mockCollection,
  mockDoc,
  mockWhere,
  mockOrderBy,
  mockLimit,
  mockOffset,
  mockQueryGet,
  mockDocGet,
  mockBatch,
  mockBatchSet,
  mockBatchCommit,
  mockApp,
  mockInitializeApp,
  mockAppFn,
  mockCert,
  setInitializeAppCalled,
} = vi.hoisted(() => {
  const mockFirestore = vi.fn();
  const mockCollection = vi.fn();
  const mockDoc = vi.fn();
  const mockWhere = vi.fn();
  const mockOrderBy = vi.fn();
  const mockLimit = vi.fn();
  const mockOffset = vi.fn();
  const mockQueryGet = vi.fn();
  const mockDocGet = vi.fn();
  const mockBatch = vi.fn();
  const mockBatchSet = vi.fn();
  const mockBatchCommit = vi.fn();
  const mockCert = vi.fn(() => ({}));
  const mockApp = { name: "mock-app-stable-reference" };
  let _initializeAppHasBeenCalled = false;

  const setInitializeAppCalled = (called: boolean) => {
    _initializeAppHasBeenCalled = called;
  };
  const getInitializeAppCalled = () => _initializeAppHasBeenCalled;

  const mockInitializeApp = vi.fn().mockImplementation((_options) => {
    setInitializeAppCalled(true);
    return mockApp;
  });

  const mockAppFn = vi.fn().mockImplementation(() => {
    throw new Error("App not initialized (hoisted default)");
  });

  mockFirestore.mockImplementation((appArg) => {
    if (appArg === mockApp) {
      return {
        collection: mockCollection,
        batch: mockBatch,
      };
    }
    return undefined;
  });

  mockCollection.mockImplementation((_path) => {
    return {
      doc: mockDoc,
      where: mockWhere,
      orderBy: mockOrderBy,
      limit: mockLimit,
      offset: mockOffset,
      get: mockQueryGet,
    };
  });

  mockDoc.mockImplementation((_docId) => {
    return {
      get: mockDocGet,
    };
  });

  mockBatch.mockImplementation(() => {
    return {
      set: mockBatchSet,
      commit: mockBatchCommit,
    };
  });

  mockWhere.mockReturnThis();
  mockOrderBy.mockReturnThis();
  mockLimit.mockReturnThis();
  mockOffset.mockReturnThis();

  return {
    mockFirestore,
    mockCollection,
    mockDoc,
    mockWhere,
    mockOrderBy,
    mockLimit,
    mockOffset,
    mockQueryGet,
    mockDocGet,
    mockBatch,
    mockBatchSet,
    mockBatchCommit,
    mockApp,
    mockInitializeApp,
    mockAppFn,
    mockCert,
    setInitializeAppCalled,
    getInitializeAppCalled,
  };
});

// --- Mock firebase-admin module ---
vi.mock("firebase-admin", () => {
  return {
    initializeApp: mockInitializeApp,
    app: mockAppFn,
    credential: { cert: mockCert },
    firestore: mockFirestore,
  };
});

// Define baseArgs if the factory function still expects it
const baseArgs: BasePluginArgs = {
  cwd: "/mock/path",
};

describe("Firebase Admin Database Plugin", () => {
  const mockConfig: FirebaseDatabaseConfig = {
    projectId: "test-project-id",
    privateKey: "test-private-key",
    clientEmail: "test-client-email@example.com",
  };

  const mockHooks: DatabasePluginHooks = {};

  const mockBundle: Bundle = {
    id: "test-bundle-id",
    enabled: true,
    shouldForceUpdate: false,
    fileHash: "test-file-hash",
    gitCommitHash: "test-git-hash",
    message: "test-message",
    channel: "production",
    platform: "android",
    targetAppVersion: "1.0.0",
  };

  const mockFirestoreData: SnakeCaseBundle = {
    id: "test-bundle-id",
    enabled: true,
    should_force_update: false,
    file_hash: "test-file-hash",
    git_commit_hash: "test-git-hash",
    message: "test-message",
    channel: "production",
    platform: "android",
    target_app_version: "1.0.0",
  };

  type CommitBundleArgs = {
    changedSets: Array<{
      operation: "insert" | "update" | "delete";
      data: Bundle;
    }>;
  };

  let databasePlugin: ReturnType<ReturnType<typeof firebaseDatabase>>;

  beforeEach(() => {
    vi.resetAllMocks();

    setInitializeAppCalled(false);

    mockAppFn.mockImplementation(() => {
      throw new Error("App not initialized (beforeEach setup)");
    });

    mockInitializeApp.mockImplementation((_options) => {
      setInitializeAppCalled(true);
      mockAppFn.mockImplementation(() => {
        return mockApp;
      });
      return mockApp;
    });

    mockFirestore.mockImplementation((appArg) => {
      if (appArg === mockApp) {
        return { collection: mockCollection, batch: mockBatch };
      }
      return undefined;
    });

    mockCollection.mockImplementation((_path) => {
      return {
        doc: mockDoc,
        where: mockWhere,
        orderBy: mockOrderBy,
        limit: mockLimit,
        offset: mockOffset,
        get: mockQueryGet,
      };
    });

    mockDoc.mockImplementation((_docId) => {
      return { get: mockDocGet };
    });

    mockBatch.mockImplementation(() => {
      return { set: mockBatchSet, commit: mockBatchCommit };
    });

    mockWhere.mockReturnThis();
    mockOrderBy.mockReturnThis();
    mockLimit.mockReturnThis();
    mockOffset.mockReturnThis();

    mockQueryGet.mockResolvedValue({ empty: true, docs: [] });
    mockDocGet.mockResolvedValue({ exists: false, data: () => undefined });
    mockBatchCommit.mockResolvedValue(undefined);

    try {
      databasePlugin = firebaseDatabase(mockConfig, mockHooks)(baseArgs);
    } catch (error) {
      console.error("[beforeEach] Error during plugin instantiation:", error);
      throw error;
    }

    expect(mockCert).toHaveBeenCalledTimes(1);
    expect(mockCert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: mockConfig.projectId }),
    );
    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockFirestore).toHaveBeenCalledTimes(1);
    expect(mockFirestore).toHaveBeenCalledWith(mockApp);
  });

  afterEach(() => {
    vi.resetAllMocks();
    setInitializeAppCalled(false);
  });

  it("should instantiate without error", () => {
    expect(databasePlugin).toBeDefined();
    expect(databasePlugin.getBundles).toBeInstanceOf(Function);
  });

  it("should call firestore().collection() when getting bundles", async () => {
    const mockData1 = { ...mockFirestoreData, id: "b1" };
    const mockData2 = { ...mockFirestoreData, id: "b2" };
    mockQueryGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => mockData1 }, { data: () => mockData2 }],
    });

    const bundles = await databasePlugin.getBundles();

    expect(mockCollection).toHaveBeenCalledWith("bundles");
    expect(mockOrderBy).toHaveBeenCalledWith("id", "desc");
    expect(mockQueryGet).toHaveBeenCalledTimes(1);
    expect(bundles).toHaveLength(2);
    expect(bundles[0].id).toBe("b1");
    expect(bundles[1].id).toBe("b2");
  });

  describe("commitBundle", () => {
    it("should do nothing if changedSets is empty", async () => {
      const args: CommitBundleArgs = { changedSets: [] };
      await databasePlugin.commitBundle();
      expect(mockBatch).not.toHaveBeenCalled();
    });
  });

  describe("getBundleById", () => {
    it("should return null if bundle not found in Firestore", async () => {
      mockDocGet.mockResolvedValueOnce({
        exists: false,
        data: () => undefined,
      });
      const result = await databasePlugin.getBundleById("non-existent-id");
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockDoc).toHaveBeenCalledWith("non-existent-id");
      expect(mockDocGet).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it("should return bundle when found in Firestore", async () => {
      mockDocGet.mockResolvedValueOnce({
        exists: true,
        data: () => mockFirestoreData,
      });
      const result = await databasePlugin.getBundleById("test-bundle-id");
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockDoc).toHaveBeenCalledWith("test-bundle-id");
      expect(mockDocGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockBundle);
    });
  });

  describe("getBundles", () => {
    it("should return empty array when no bundles exist", async () => {
      mockQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
      const result = await databasePlugin.getBundles();
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockOrderBy).toHaveBeenCalledWith("id", "desc");
      expect(mockQueryGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it("should query Firestore and return converted bundles", async () => {
      const secondFirestoreData = {
        ...mockFirestoreData,
        id: "second-bundle-id",
      };
      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => mockFirestoreData },
          { data: () => secondFirestoreData },
        ],
      });
      const result = await databasePlugin.getBundles();
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockOrderBy).toHaveBeenCalledWith("id", "desc");
      expect(mockQueryGet).toHaveBeenCalledTimes(1);
      expect(result.length).toBe(2);
      expect(result[0]).toEqual(mockBundle);
      expect(result[1]).toEqual(
        expect.objectContaining({ id: "second-bundle-id" }),
      );
    });

    it("should apply filters (where, limit, offset) when options are provided", async () => {
      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ data: () => mockFirestoreData }],
      });
      await databasePlugin.getBundles({
        where: { channel: "production", platform: "android" },
        limit: 10,
        offset: 5,
      });
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockWhere).toHaveBeenCalledWith("channel", "==", "production");
      expect(mockWhere).toHaveBeenCalledWith("platform", "==", "android");
      expect(mockOrderBy).toHaveBeenCalledWith("id", "desc");
      expect(mockOffset).toHaveBeenCalledWith(5);
      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(mockQueryGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("getChannels", () => {
    it("should return empty array when no channels exist", async () => {
      mockQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
      const result = await databasePlugin.getChannels();
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockOrderBy).toHaveBeenCalledWith("channel");
      expect(mockQueryGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it("should return unique channels from Firestore data", async () => {
      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => ({ ...mockFirestoreData, channel: "production" }) },
          { data: () => ({ ...mockFirestoreData, id: "b2", channel: "beta" }) },
          {
            data: () => ({
              ...mockFirestoreData,
              id: "b3",
              channel: "production",
            }),
          },
          {
            data: () => ({ ...mockFirestoreData, id: "b4", channel: "alpha" }),
          },
        ],
      });
      const result = await databasePlugin.getChannels();
      expect(mockCollection).toHaveBeenCalledWith("bundles");
      expect(mockOrderBy).toHaveBeenCalledWith("channel");
      expect(mockQueryGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.arrayContaining(["production", "beta", "alpha"]),
      );
      expect(result).toHaveLength(3);
    });
  });
});
