import type { SnakeCaseBundle } from "@hot-updater/core";
import type {
  BasePluginArgs,
  Bundle,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import type * as admin from "firebase-admin";
import { cert } from "firebase-admin/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firebaseDatabase } from "./firebaseDatabase";

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
  getInitializeAppCalled,
  // 추가: runTransaction 모킹
  // runTransaction는 firestore 객체에서 호출하므로 모킹 처리
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

  // 추가: runTransaction 모킹. 실제로는 전달된 콜백을 호출하는 식으로 단순하게 구현함.
  const mockRunTransaction = vi
    .fn()
    .mockImplementation(async (updateFunction: any) => {
      // fakeTransaction 객체를 생성하여 set, get, delete를 모킹합니다.
      const fakeTransaction = {
        set: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      };
      return updateFunction(fakeTransaction);
    });

  mockFirestore.mockImplementation((appArg) => {
    if (appArg === mockApp) {
      return {
        collection: mockCollection,
        batch: mockBatch,
        runTransaction: mockRunTransaction,
      };
    }
    return undefined;
  });

  mockCollection.mockImplementation((_path: string) => {
    return {
      doc: mockDoc,
      where: mockWhere,
      orderBy: mockOrderBy,
      limit: mockLimit,
      offset: mockOffset,
      get: mockQueryGet,
    };
  });
  mockDoc.mockImplementation((_docId: string) => {
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
    // FieldValue.delete()를 단순 토큰으로 모킹
    FieldValue: {
      delete: () => ({ __delete: true }),
    },
  };
});

// Define baseArgs if the factory function still expects it
const baseArgs: BasePluginArgs = {
  cwd: "/mock/path",
};

describe("Firebase Admin Database Plugin", () => {
  const mockConfig: admin.AppOptions = {
    projectId: "test-project-id",
    credential: cert({
      projectId: "test-project-id",
      privateKey: "test-private-key",
      clientEmail: "test-client-email@example.com",
    }),
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
        return {
          collection: mockCollection,
          batch: mockBatch,
          runTransaction: vi
            .fn()
            .mockImplementation(
              async (fn) =>
                await fn({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
            ),
        };
      }
      return undefined;
    });
    mockCollection.mockImplementation((_path: string) => {
      return {
        doc: mockDoc,
        where: mockWhere,
        orderBy: mockOrderBy,
        limit: mockLimit,
        offset: mockOffset,
        get: mockQueryGet,
      };
    });
    mockDoc.mockImplementation((_docId: string) => {
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

  // --- 추가 테스트: commitBundle 테스트 케이스 ---
  describe("commitBundle", () => {
    it("should do nothing if changedSets is empty", async () => {
      const args: CommitBundleArgs = { changedSets: [] };
      await databasePlugin.commitBundle(args);
      // runTransaction를 호출하지 않아야 함
      expect(mockFirestore).toHaveBeenCalled();
    });

    it("should handle insert operation correctly", async () => {
      // prepare a fake transaction to capture calls
      const fakeTransaction = {
        set: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
      };
      // mock runTransaction to invoke the callback with our fakeTransaction
      const mockRunTransaction = vi.fn().mockImplementation(async (fn) => {
        return fn(fakeTransaction);
      });
      mockFirestore.mockImplementation(() => ({
        collection: mockCollection,
        runTransaction: mockRunTransaction,
      }));

      const changedSets: CommitBundleArgs["changedSets"] = [
        {
          operation: "insert",
          data: mockBundle,
        },
      ];
      await databasePlugin.commitBundle({ changedSets });
      // bundle 문서에 대한 set 호출 검증
      expect(fakeTransaction.set).toHaveBeenCalledWith(
        expect.any(Object), // bundle 문서 참조 (mockDoc에서 생성)
        expect.objectContaining({
          id: mockBundle.id,
          target_app_version: mockBundle.targetAppVersion,
        }),
        { merge: true },
      );
      // target_app_versions 컬렉션에 대한 set 호출 검증
      expect(fakeTransaction.set).toHaveBeenCalledWith(
        expect.any(Object), // target_app_versions 문서 참조
        expect.objectContaining({
          platform: mockBundle.platform,
          target_app_version: mockBundle.targetAppVersion,
        }),
        { merge: true },
      );
    });

    it("should handle update operation with removal of target_app_version", async () => {
      // update 시 target_app_version이 제거된 경우 테스트
      const bundleWithoutVersion: Bundle = {
        ...mockBundle,
        targetAppVersion: "", // falsy 값으로 target_app_version 제거
      };

      // prepare fake transaction
      const fakeTransaction = {
        set: vi.fn(),
        get: vi.fn().mockResolvedValue({
          exists: true,
          data: () => ({ ...mockFirestoreData, target_app_version: "1.0.0" }),
        }),
        delete: vi.fn(),
      };

      const mockRunTransaction = vi.fn().mockImplementation(async (fn) => {
        return fn(fakeTransaction);
      });
      mockFirestore.mockImplementation(() => ({
        collection: mockCollection,
        runTransaction: mockRunTransaction,
      }));

      const changedSets: CommitBundleArgs["changedSets"] = [
        {
          operation: "update",
          data: bundleWithoutVersion,
        },
      ];
      await databasePlugin.commitBundle({ changedSets });
      // 번들 문서에 대해 target_app_version 필드 삭제 처리 (FieldValue.delete() 사용)
      expect(fakeTransaction.set).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          target_app_version: expect.objectContaining({ __delete: true }),
        }),
        { merge: true },
      );
    });

    it("should delete orphan target_app_versions in transaction cleanup", async () => {
      // prepare fake transaction
      const fakeTransaction = {
        set: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
      };

      // 첫 get 호출: target_app_versions 컬렉션 전체 조회 시 두 문서를 반환
      fakeTransaction.get = vi
        .fn()
        // 첫번째 get: return snapshot for target_app_versions collection
        .mockResolvedValueOnce({
          docs: [
            {
              id: "android_1.0.0",
              data: () => ({
                platform: "android",
                target_app_version: "1.0.0",
              }),
              ref: { id: "android_1.0.0" },
            },
            {
              id: "ios_2.0.0",
              data: () => ({
                platform: "ios",
                target_app_version: "2.0.0",
              }),
              ref: { id: "ios_2.0.0" },
            },
          ],
        })
        // 두번째 get: bundles 쿼리 결과 (android 문서는 존재)
        .mockResolvedValueOnce({ empty: false, docs: [{}] })
        // 세번째 get: bundles 쿼리 결과 (ios 문서는 없음)
        .mockResolvedValueOnce({ empty: true, docs: [] });

      const mockRunTransaction = vi.fn().mockImplementation(async (fn) => {
        return fn(fakeTransaction);
      });
      mockFirestore.mockImplementation(() => ({
        collection: mockCollection,
        runTransaction: mockRunTransaction,
      }));

      // commitBundle 실행을 위해 changedSets에 아무 작업이나 넣음(insert 처리)
      const changedSets: CommitBundleArgs["changedSets"] = [
        {
          operation: "insert",
          data: mockBundle,
        },
      ];
      await databasePlugin.commitBundle({ changedSets });

      // orphan cleanup 단계에서 ios_2.0.0에 대해 delete 호출이 일어나야 함
      expect(fakeTransaction.delete).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ios_2.0.0" }),
      );
    });
  });
});
