import { p } from "@hot-updater/cli-tools";

import { warnIfExpoCNG } from "@/utils/expoDetection";
import { setChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";

export const handleSetChannel = async (channel: string) => {
  warnIfExpoCNG();
  const { paths: androidPaths } = await setChannel("android", channel);
  p.log.success(ui.line(["Set", ui.platform("Android"), ui.channel(channel)]));
  if (androidPaths.length > 0) {
    p.log.message(
      ui.block(
        "Android paths",
        androidPaths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
      ),
    );
  }

  const { paths: iosPaths } = await setChannel("ios", channel);
  p.log.success(ui.line(["Set", ui.platform("iOS"), ui.channel(channel)]));
  if (iosPaths.length > 0) {
    p.log.message(
      ui.block(
        "iOS paths",
        iosPaths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
      ),
    );
  }

  p.log.warn("Rebuild native app after changing channel.");
};
