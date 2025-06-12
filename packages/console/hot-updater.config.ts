import { mockDatabase, mockStorage } from "@hot-updater/mock";

export default {
  storage: mockStorage(),
  database: mockDatabase({
    latency: { min: 500, max: 700 },
    initialBundles: [
      {
        id: "0195c7c0-8bbe-7885-ae58-09bcab7f7a87",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "1234",
        gitCommitHash: "5678",
        platform: "ios",
        targetAppVersion: "1.0.x",
        message: "channel dev",
        channel: "dev",
      },
      {
        id: "0195c7bf-e8f2-7546-8aba-8bad8243afeb",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "1234",
        gitCommitHash: "5678",
        platform: "ios",
        targetAppVersion: "1.0.x",
        message: "test2",
        channel: "production",
        storageUri:
          "https://storage.googleapis.com/hot-updater-dev/0195c7bf-e8f2-7546-8aba-8bad8243afeb.zip",
        fingerprintHash: "1234",
      },
      {
        id: "0195c7bf-d48d-7785-9295-15b154d271a3",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "1234",
        gitCommitHash: "5678",
        platform: "ios",
        targetAppVersion: "1.0.x",
        message: "test",
        channel: "production",
        storageUri:
          "https://storage.googleapis.com/hot-updater-dev/0195c7bf-e8f2-7546-8aba-8bad8243afeb.zip",
        fingerprintHash: "1234",
      },
    ],
  }),
};
