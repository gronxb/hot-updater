import * as p from "@clack/prompts";
import picocolors from "picocolors";
import { getChannel, setChannel } from "@/utils/setChannel";

export const handleChannel = async () => {
  const androidChannel = await getChannel("android");
  const iosChannel = await getChannel("ios");
  p.log.info(
    `Current Android channel: ${picocolors.green(androidChannel.value)}`,
  );

  p.log.info(`  from: ${picocolors.blue(androidChannel.paths[0])}`);
  p.log.info(`Current iOS channel: ${picocolors.green(iosChannel.value)}`);
  p.log.info(`  from: ${picocolors.blue(iosChannel.paths[0])}`);
};

export const handleSetChannel = async (channel: string) => {
  const { paths: androidPaths } = await setChannel("android", channel);
  p.log.success(`Set Android channel to: ${picocolors.green(channel)}`);
  if (androidPaths.length > 0) {
    p.log.info(picocolors.bold("Changed Android paths:"));
    for (const path of androidPaths) {
      p.log.info(`  ${picocolors.green(path)}`);
    }
  }

  const { paths: iosPaths } = await setChannel("ios", channel);
  p.log.success(`Set iOS channel to: ${picocolors.green(channel)}`);
  if (iosPaths.length > 0) {
    p.log.info(picocolors.bold("Changed iOS paths:"));
    for (const path of iosPaths) {
      p.log.info(`  ${picocolors.green(path)}`);
    }
  }

  p.log.success(
    "You need to rebuild the native app if the channel has changed.",
  );
};
