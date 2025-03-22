import { mockDatabase } from "@hot-updater/mock";

export default {
  database: mockDatabase({
    latency: { min: 500, max: 700 },
    initialBundles: [
      {
        id: "1",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "1234",
        gitCommitHash: "5678",
        platform: "ios",
        targetAppVersion: "",
        message: null,
      },
      {
        id: "2",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "1234",
        gitCommitHash: "5678",
        platform: "ios",
        targetAppVersion: "",
        message: null,
      },
    ],
  }),
};
