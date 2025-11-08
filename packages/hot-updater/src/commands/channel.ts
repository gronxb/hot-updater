import { colors, p } from "@hot-updater/cli-tools";
import { getChannel, setChannel } from "@/utils/setChannel";

export const handleChannel = async () => {
  const androidChannel = await getChannel("android");
  const iosChannel = await getChannel("ios");
  p.log.info(`Current Android channel: ${colors.green(androidChannel.value)}`);

  p.log.info(`  from: ${colors.blue(androidChannel.paths[0])}`);
  p.log.info(`Current iOS channel: ${colors.green(iosChannel.value)}`);
  p.log.info(`  from: ${colors.blue(iosChannel.paths[0])}`);
};

export const handleSetChannel = async (channel: string) => {
  const { paths: androidPaths } = await setChannel("android", channel);
  p.log.success(`Set Android channel to: ${colors.green(channel)}`);
  if (androidPaths.length > 0) {
    p.log.info(colors.bold("Changed Android paths:"));
    for (const path of androidPaths) {
      p.log.info(`  ${colors.green(path)}`);
    }
  }

  const { paths: iosPaths } = await setChannel("ios", channel);
  p.log.success(`Set iOS channel to: ${colors.green(channel)}`);
  if (iosPaths.length > 0) {
    p.log.info(colors.bold("Changed iOS paths:"));
    for (const path of iosPaths) {
      p.log.info(`  ${colors.green(path)}`);
    }
  }

  p.log.success(
    "You need to rebuild the native app if the channel has changed.",
  );
};
