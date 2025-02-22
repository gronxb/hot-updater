// s3Database.spec.ts
import { Buffer } from "buffer";
import { Readable } from "stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s3Database } from "./s3Database";

const DEFAULT_BUNDLE = {
  fileUrl: "http://example.com/bundle.zip",
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  enabled: true,
  shouldForceUpdate: false,
} as const;

const createBundleJson = (
  platform: "ios" | "android",
  targetAppVersion: string,
  id: string,
): Bundle => ({
  ...DEFAULT_BUNDLE,
  id,
  platform,
  targetAppVersion,
});

// fakeStore는 S3에 저장된 파일들을 시뮬레이션합니다.
let fakeStore: Record<string, string> = {};

// @aws-sdk/lib-storage의 Upload를 모킹하여 S3 업로드 시 fakeStore에 기록합니다.
vi.mock("@aws-sdk/lib-storage", () => {
  return {
    Upload: class {
      client: any;
      params: any;
      constructor({ client, params }: { client: any; params: any }) {
        this.client = client;
        this.params = params;
      }
      async done() {
        fakeStore[this.params.Key] = this.params.Body;
      }
    },
  };
});

// S3Client.send을 모킹하여 fakeStore를 기반으로 동작하도록 합니다.
beforeEach(() => {
  fakeStore = {};
  vi.spyOn(S3Client.prototype, "send").mockImplementation(
    async (command: any) => {
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        const keys = Object.keys(fakeStore).filter((key) =>
          key.startsWith(prefix),
        );
        return {
          Contents: keys.map((key) => ({ Key: key })),
          NextContinuationToken: undefined,
        };
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        if (key && fakeStore[key] !== undefined) {
          // Body 스트림은 Buffer를 반환하도록 함.
          return { Body: Readable.from([Buffer.from(fakeStore[key])]) };
        }
        const error = new Error("NoSuchKey");
        // S3 SDK의 NoSuchKey 에러 인스턴스로 만들기 위해 prototype을 설정합니다.
        Object.setPrototypeOf(error, NoSuchKey.prototype);
        throw error;
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        // DeleteObjectCommand를 처리: fakeStore에서 해당 키 삭제
        const key = command.input.Key;
        delete fakeStore[key];
        return {}; // 빈 응답 반환
      }
      throw new Error("Unsupported command in fake S3 client");
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("s3Database plugin", () => {
  const bucketName = "test-bucket";
  const s3Config = {};
  // 플러그인 생성: BasePluginArgs로 { cwd: "" }와 같이 전달합니다.
  const plugin = s3Database({ bucketName, ...s3Config })({ cwd: "" });

  it("should append a new bundle and commit to S3", async () => {
    // 새로운 번들 생성
    const bundleKey = "ios/1.0.0/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";
    const newBundle = createBundleJson(
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000001",
    );

    // 번들 추가 및 커밋
    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    // update.json 파일에 번들이 정상적으로 추가되었는지 확인
    const storedBundles = JSON.parse(fakeStore[bundleKey]);
    expect(storedBundles).toStrictEqual([newBundle]);

    // target-app-versions.json에 새 버전이 추가되었는지 확인
    const versions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(versions).toContain("1.0.0");

    // 메모리 캐시에서도 번들을 조회할 수 있는지 확인
    const fetchedBundle = await plugin.getBundleById(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(fetchedBundle).toStrictEqual(newBundle);
  });

  it("should update an existing bundle and reflect changes in S3", async () => {
    const bundleKey = "android/2.0.0/update.json";
    const targetVersionsKey = "android/target-app-versions.json";
    const initialBundle = createBundleJson(
      "android",
      "2.0.0",
      "00000000-0000-0000-0000-000000000002",
    );

    // 미리 fakeStore에 번들 데이터를 구성
    fakeStore[bundleKey] = JSON.stringify([initialBundle]);
    fakeStore[targetVersionsKey] = JSON.stringify(["2.0.0"]);

    // 번들 업데이트 및 커밋
    await plugin.getBundles(true);
    await plugin.updateBundle("00000000-0000-0000-0000-000000000002", {
      enabled: false,
    });
    await plugin.commitBundle();

    // update.json 파일에 변경사항이 반영되었는지 확인
    const updatedBundles = JSON.parse(fakeStore[bundleKey]);
    expect(updatedBundles).toStrictEqual([
      {
        ...initialBundle,
        enabled: false,
      },
    ]);
  });

  it("should return cached bundles when refresh is false", async () => {
    const bundleKey = "ios/3.0.0/update.json";
    const bundle = createBundleJson(
      "ios",
      "3.0.0",
      "00000000-0000-0000-0000-000000000003",
    );

    // 미리 fakeStore에 번들 데이터를 구성
    fakeStore[bundleKey] = JSON.stringify([bundle]);

    // refresh=true로 S3에서 번들을 읽어들임
    const bundlesFirst = await plugin.getBundles(true);
    expect(bundlesFirst).toStrictEqual([bundle]);

    // fakeStore의 데이터를 삭제해도 캐시된 데이터가 반환되는지 확인
    delete fakeStore[bundleKey];
    const bundlesSecond = await plugin.getBundles(false);
    expect(bundlesSecond).toStrictEqual([bundle]);
  });

  it("should throw an error when trying to update a non-existent bundle", async () => {
    await expect(
      plugin.updateBundle("nonexistent", { enabled: true }),
    ).rejects.toThrow("target bundle version not found");
  });

  it("should move a bundle from ios/1.x.x/update.json to ios/1.0.2/update.json when targetAppVersion is updated", async () => {
    const keyOld = "ios/1.x.x/update.json";
    const keyNew = "ios/1.0.2/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";

    // 미리 fakeStore에 번들 데이터를 구성합니다.
    const oldVersionBundles = [
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ];

    const newVersionBundles = [
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
    ];

    // update.json 파일 구성 (getBundles() 시 내부적으로 _updateJsonKey가 추가됩니다)
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // target-app-versions.json 초기 상태 설정
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    // S3의 모든 번들 정보를 메모리 캐시로 로드합니다.
    await plugin.getBundles(true);

    // ios/1.x.x의 번들 중 하나의 targetAppVersion을 1.0.2로 업데이트합니다.
    await plugin.updateBundle("00000000-0000-0000-0000-000000000003", {
      targetAppVersion: "1.0.2",
    });
    // 변경사항을 S3에 커밋합니다.
    await plugin.commitBundle();

    // ios/1.0.2/update.json에는 기존 2개 번들 + 이동된 번들로 총 3개가 있어야 합니다.
    const newFileBundles = JSON.parse(fakeStore[keyNew]);
    expect(newFileBundles).toStrictEqual([
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000003"),
    ]);

    // 그리고 ios/1.x.x/update.json에서는 이동된 번들이 제거되어 2개만 남아야 합니다.
    const oldFileBundles = JSON.parse(fakeStore[keyOld]);
    expect(oldFileBundles).toStrictEqual([
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ]);

    // target-app-versions.json에 새로운 버전이 추가되어야 합니다.
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x", "1.0.2"]);
  });

  it("should move all bundles from ios/1.0.2/update.json to ios/1.x.x/update.json when targetAppVersion is updated", async () => {
    const keyOld = "ios/1.x.x/update.json";
    const keyNew = "ios/1.0.2/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";

    // 미리 fakeStore에 번들 데이터를 구성합니다.
    const oldVersionBundles = [
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ];

    const newVersionBundles = [
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
    ];

    // update.json 파일 구성 (getBundles() 시 내부적으로 _updateJsonKey가 추가됩니다)
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // target-app-versions.json 초기 상태 설정
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    await plugin.getBundles(true);

    await plugin.updateBundle("00000000-0000-0000-0000-000000000004", {
      targetAppVersion: "1.x.x",
    });

    await plugin.updateBundle("00000000-0000-0000-0000-000000000005", {
      targetAppVersion: "1.x.x",
    });
    // 변경사항을 S3에 커밋합니다.
    await plugin.commitBundle();

    // ios/1.0.2/update.json 파일이 존재하지 않아야 합니다
    expect(fakeStore[keyNew]).toBeUndefined();

    // 그리고 ios/1.x.x/update.json에서는 이동된 번들이 제거되어 2개만 남아야 합니다.
    const oldFileBundles = JSON.parse(fakeStore[keyOld]);
    expect(oldFileBundles).toStrictEqual([
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000004"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ]);

    // target-app-versions.json에 새로운 버전이 추가되어야 합니다.
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x"]);
  });
});
