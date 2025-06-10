import { getChannel, setChannel } from "@/utils/setChannel";
import * as p from "@clack/prompts";
import picocolors from "picocolors";

export const handleChannel = async () => {
  const androidChannel = await getChannel("android");
  const iosChannel = await getChannel("ios");
  p.log.info(
    `Current Android channel: ${picocolors.green(androidChannel.value)}`,
  );
  p.log.info(`  from: ${picocolors.blue(androidChannel.path)}`);
  p.log.info(`Current iOS channel: ${picocolors.green(iosChannel.value)}`);
  p.log.info(`  from: ${picocolors.blue(iosChannel.path)}`);
};

export const handleSetChannel = async (channel: string) => {
  const { path: androidPath } = await setChannel("android", channel);
  p.log.success(`Set Android channel to: ${picocolors.green(channel)}`);
  p.log.info(`  from: ${picocolors.blue(androidPath)}`);

  const { path: iosPath } = await setChannel("ios", channel);
  p.log.success(`Set iOS channel to: ${picocolors.green(channel)}`);
  p.log.info(`  from: ${picocolors.blue(iosPath)}`);

  p.log.success(
    "You need to rebuild the native app if the channel has changed.",
  );
};
