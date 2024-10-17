import { version } from "@/packageJson";
import boxen from "boxen";
import picocolors from "picocolors";

export const banner = boxen(
  [
    `${picocolors.bold("Hot Updater - React Native OTA Solution")} v${version}`,
    "",
    `Github: ${picocolors.magenta(
      picocolors.underline("https://github.com/gronxb/hot-updater"),
    )}`,
    "Give a ⭐️ if you like it!",
  ].join("\n"),
  {
    padding: 1,
    borderStyle: "round",
    borderColor: "redBright",
    textAlignment: "center",
  },
);
