import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  BasePluginArgs,
  Bundle,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  query,
  orderBy,
  getDocs,
  type QuerySnapshot,
} from "firebase/firestore";
import { firebaseDatabase } from "./firebaseDatabase";

vi.mock("firebase/app", () => {
  const app = { name: "test-app" };
  return {
    initializeApp: vi.fn(() => app),
    getApps: vi.fn(() => []),
    getApp: vi.fn(() => app),
  };
});

vi.mock("firebase/firestore", () => {
  const mockFirestore = {};
  const mockCollection = vi.fn(() => undefined);
  const mockDoc = vi.fn(() => "document-ref");
  const mockSetDoc = vi.fn();
  const mockGetDoc = vi.fn();
  const mockQuery = vi.fn((...args) => args);
  const mockOrderBy = vi.fn(() => "order-by");
  const mockGetDocs = vi.fn();

  return {
    getFirestore: vi.fn(() => mockFirestore),
    collection: mockCollection,
    doc: mockDoc,
    setDoc: mockSetDoc,
    getDoc: mockGetDoc,
    query: mockQuery,
    orderBy: mockOrderBy,
    getDocs: mockGetDocs,
  };
});

const baseArgs: BasePluginArgs = {
  cwd: "/mock/path",
};

describe("Firebase Database Plugin", () => {
  const mockConfig = {
    apiKey: "test-api-key",
    projectId: "test-project-id",
    appName: "test-app",
  };

  const mockHooks: DatabasePluginHooks = {
    onDatabaseUpdated: vi.fn(),
  };

  const mockBundle: Bundle = {
    id: "test-bundle-id",
    enabled: true,
    fileUrl: "test-file-url",
    shouldForceUpdate: false,
    fileHash: "test-file-hash",
    gitCommitHash: "test-git-hash",
    message: "test-message",
    platform: "android",
    targetAppVersion: "1.0.0",
  };

  const mockFirestoreData = {
    id: "test-bundle-id",
    enabled: true,
    file_url: "test-file-url",
    should_force_update: false,
    file_hash: "test-file-hash",
    git_commit_hash: "test-git-hash",
    message: "test-message",
    platform: "android",
    target_app_version: "1.0.0",
  };

  let databasePlugin: ReturnType<ReturnType<typeof firebaseDatabase>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApps).mockReturnValue([]);
    databasePlugin = firebaseDatabase(mockConfig, mockHooks)(baseArgs);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should initialize Firebase with correct config", () => {
    expect(initializeApp).toHaveBeenCalledWith(mockConfig, "test-app");
    expect(getFirestore).toHaveBeenCalled();
    expect(collection).toHaveBeenCalledWith(expect.anything(), "bundles");
  });

  it("should use existing app if it already exists", () => {
    vi.mocked(getApps).mockReturnValue([{ name: "test-app" } as any]);

    firebaseDatabase(mockConfig, mockHooks)(baseArgs);

    expect(getApp).toHaveBeenCalledWith("test-app");
    expect(initializeApp).not.toHaveBeenCalledTimes(2);
  });

  describe("commitBundle", () => {
    it("should do nothing if no IDs are changed", async () => {
      await databasePlugin.commitBundle();

      expect(doc).not.toHaveBeenCalled();
      expect(setDoc).not.toHaveBeenCalled();
      expect(mockHooks.onDatabaseUpdated).not.toHaveBeenCalled();
    });

    it("should update changed bundles to Firestore", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            data: () => mockFirestoreData,
          },
        ] as any,
      } as unknown as QuerySnapshot);

      await databasePlugin.getBundles(true);
      await databasePlugin.updateBundle("test-bundle-id", { enabled: false });

      vi.clearAllMocks();

      await databasePlugin.commitBundle();

      expect(doc).toHaveBeenCalledWith(undefined, "test-bundle-id");
      expect(setDoc).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          id: "test-bundle-id",
          enabled: false,
        }),
        { merge: true },
      );
      expect(mockHooks.onDatabaseUpdated).toHaveBeenCalled();
    });
  });

  describe("updateBundle", () => {
    it("should throw error if target bundle not found", async () => {
      vi.mocked(getDocs).mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await expect(
        databasePlugin.updateBundle("non-existent-id", {}),
      ).rejects.toThrow("target bundle version not found");
    });

    it("should update bundle in memory", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            data: () => mockFirestoreData,
          },
        ] as any,
      } as unknown as QuerySnapshot);

      await databasePlugin.getBundles(true);
      await databasePlugin.updateBundle("test-bundle-id", { enabled: false });

      vi.clearAllMocks();

      const bundles = await databasePlugin.getBundles();
      expect(getDocs).not.toHaveBeenCalled();
      expect(bundles[0].enabled).toBe(false);
    });
  });

  describe("appendBundle", () => {
    it("should add new bundle to the beginning of the list", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            data: () => mockFirestoreData,
          },
        ] as any,
      } as unknown as QuerySnapshot);

      await databasePlugin.getBundles(true);

      const newBundle: Bundle = {
        ...mockBundle,
        id: "new-bundle-id",
      };

      await databasePlugin.appendBundle(newBundle);

      const bundles = await databasePlugin.getBundles();
      expect(bundles.length).toBe(2);
      expect(bundles[0].id).toBe("new-bundle-id");
    });
  });

  describe("getBundleById", () => {
    it("should return null if bundle not found", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        exists: () => false,
      } as any);

      const result = await databasePlugin.getBundleById("non-existent-id");
      expect(result).toBeNull();
    });

    it("should return bundle when found", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        exists: () => true,
        data: () => mockFirestoreData,
      } as any);

      const result = await databasePlugin.getBundleById("test-bundle-id");
      expect(result).toEqual(mockBundle);
    });
  });

  describe("getBundles", () => {
    it("should return empty array when no bundles exist", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: true,
      } as any);

      const result = await databasePlugin.getBundles(true);
      expect(result).toEqual([]);
    });

    it("should query Firestore and return bundles", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => mockFirestoreData },
          { data: () => ({ ...mockFirestoreData, id: "second-bundle-id" }) },
        ],
      } as any);

      const result = await databasePlugin.getBundles(true);

      expect(query).toHaveBeenCalled();
      expect(orderBy).toHaveBeenCalledWith("id", "desc");
      expect(result.length).toBe(2);
    });

    it("should use cached bundles when available and refresh is false", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [{ data: () => mockFirestoreData }],
      } as any);

      await databasePlugin.getBundles(true);

      vi.clearAllMocks();

      const result = await databasePlugin.getBundles(false);

      expect(getDocs).not.toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("test-bundle-id");
    });
  });
});
