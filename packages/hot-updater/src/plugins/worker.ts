import { getCwd, loadConfigSync } from "@hot-updater/plugin-core";
import { nativeFingerprint } from "@rnef/tools";
import { runAsWorker } from "synckit";

const getReleaseChannel = () => {
  const envChannel = process.env["HOT_UPDATER_CHANNEL"];
  if (envChannel) {
    return envChannel;
  }
  const { releaseChannel } = loadConfigSync(null);
  return releaseChannel;
};

runAsWorker(async () => {
  let data: {
    fingerprintHash: {
      ios: string;
      android: string;
    };
    releaseChannel: string;
  } | null = null;

  const [iosFingerprint, androidFingerprint] = await Promise.all([
    nativeFingerprint(getCwd(), {
      platform: "ios",
      extraSources: [],
      ignorePaths: [],
    }),
    nativeFingerprint(getCwd(), {
      platform: "android",
      extraSources: [],
      ignorePaths: [],
    }),
  ]);

  data = {
    fingerprintHash: {
      ios: iosFingerprint.hash,
      android: androidFingerprint.hash,
    },
    releaseChannel: getReleaseChannel(),
  };

  return data;
});
