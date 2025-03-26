import type { SnakeCaseBundle } from "@hot-updater/core";
import type {
  BasePluginArgs,
  Bundle,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  type QuerySnapshot,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  const mockCollectionRef = { id: "collection-ref" };
  const mockCollection = vi.fn(() => mockCollectionRef);
  const mockDoc = vi.fn(() => "document-ref");
  const mockSetDoc = vi.fn();
  const mockGetDoc = vi.fn(() => ({
    exists: () => false,
    data: () => null,
  }));
  const mockQuery = vi.fn((...args) => args);
  const mockOrderBy = vi.fn(() => "order-by");
  const mockGetDocs = vi.fn(() => ({
    empty: true,
    docs: [],
  }));

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

  const appName = "hot-updater";

  let databasePlugin: ReturnType<ReturnType<typeof firebaseDatabase>>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getApps).mockReturnValue([]);
    databasePlugin = firebaseDatabase(mockConfig, mockHooks)(baseArgs);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should return existing app if app with appName already exists", () => {
    vi.resetAllMocks();

    const mockExistingApp = { name: appName };
    (getApps as Mock).mockReturnValue([mockExistingApp]);
    (getApp as Mock).mockReturnValue(mockExistingApp);

    const app = getApps().find((app) => app.name === appName)
      ? getApp(appName)
      : initializeApp(mockConfig, appName);

    expect(getApps).toHaveBeenCalled();
    expect(getApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).not.toHaveBeenCalled();
    expect(app).toBe(mockExistingApp);
  });

  it("should initialize new app if app with appName does not exist", () => {
    const mockExistingApp = { name: appName };
    (initializeApp as Mock).mockReturnValue(mockExistingApp);

    const app = getApps().find((app) => app.name === appName)
      ? getApp(appName)
      : initializeApp(mockConfig, appName);

    expect(getApps).toHaveBeenCalled();
    expect(initializeApp).toHaveBeenCalledWith(mockConfig, appName);
    expect(getApp).not.toHaveBeenCalled();
    expect(app).toBe(mockExistingApp);
  });
  describe("commitBundle", () => {
    it("should do nothing if no IDs are changed", async () => {
      await databasePlugin.commitBundle();

      expect(doc).not.toHaveBeenCalled();
      expect(setDoc).not.toHaveBeenCalled();
      expect(mockHooks.onDatabaseUpdated).toHaveBeenCalled();
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

      vi.mocked(getDoc).mockResolvedValueOnce({
        exists: () => true,
        data: () => mockFirestoreData,
      } as any);

      await databasePlugin.getBundles();
      await databasePlugin.updateBundle("test-bundle-id", { enabled: false });

      await databasePlugin.commitBundle();

      expect(setDoc).toHaveBeenCalledWith(
        "document-ref",
        {
          id: "test-bundle-id",
          channel: "production",
          enabled: false,
          file_hash: "test-file-hash",
          git_commit_hash: "test-git-hash",
          message: "test-message",
          platform: "android",
          should_force_update: false,
          target_app_version: "1.0.0",
        },
        { merge: true },
      );
      expect(mockHooks.onDatabaseUpdated).toHaveBeenCalled();
    });
  });

  describe("updateBundle", () => {
    it("should throw error if target bundle not found", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        exists: () => false,
      } as any);

      await expect(
        databasePlugin.updateBundle("non-existent-id", {}),
      ).rejects.toThrow("targetBundleId not found");
    });

    it("should update bundle in memory", async () => {
      vi.mocked(getDoc).mockResolvedValueOnce({
        exists: () => true,
        data: () => mockFirestoreData,
      } as any);

      await databasePlugin.updateBundle("test-bundle-id", { enabled: false });

      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            data: () => ({ ...mockFirestoreData, enabled: false }),
          },
        ] as any,
      } as unknown as QuerySnapshot);

      const bundles = await databasePlugin.getBundles();
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

      await databasePlugin.getBundles();

      const newBundle: Bundle = {
        ...mockBundle,
        id: "new-bundle-id",
      };

      await databasePlugin.appendBundle(newBundle);

      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            data: () => ({ ...mockFirestoreData, id: "new-bundle-id" }),
          },
          {
            data: () => mockFirestoreData,
          },
        ] as any,
      } as unknown as QuerySnapshot);

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
        docs: [],
      } as any);

      const result = await databasePlugin.getBundles();
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

      const result = await databasePlugin.getBundles();

      expect(query).toHaveBeenCalled();
      expect(orderBy).toHaveBeenCalledWith("id", "desc");
      expect(result.length).toBe(2);
    });

    it("should use cached bundles when available and refresh is false", async () => {
      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [{ data: () => mockFirestoreData }],
      } as any);

      await databasePlugin.getBundles();

      vi.clearAllMocks();

      vi.mocked(getDocs).mockResolvedValueOnce({
        empty: false,
        docs: [{ data: () => mockFirestoreData }],
      } as any);

      const result = await databasePlugin.getBundles();

      expect(getDocs).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("test-bundle-id");
    });
  });
});
