import { version } from "@/packageJson";
import boxen from "boxen";
import picocolors from "picocolors";

export const link = (url: string) => {
  return picocolors.green(picocolors.underline(url));
};

export const banner = boxen(
  [
    `${picocolors.bold("Hot Updater - React Native OTA Solution")} v${version}`,
    "",
    `Github: ${link("https://github.com/gronxb/hot-updater")}`,
    "Give a ⭐️ if you like it!",
  ].join("\n"),
  {
    padding: 1,
    borderStyle: "round",
    borderColor: "green",
    textAlignment: "center",
  },
);

export const printBanner = () => {
  console.log(banner);
};
