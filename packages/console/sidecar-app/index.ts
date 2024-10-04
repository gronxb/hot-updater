import { program } from "commander";
import { ret } from "./ret";
import type { UpdateSource } from "@hot-updater/core";

const data: UpdateSource[] = [];

program.command("getUpdateJson").action(async () => {
  ret(data);
});

program.command("push").action(async () => {
  data.push({
    platform: "ios",
    targetVersion: "1.x.x",
    enabled: true,
    bundleVersion: 1,
    forceUpdate: false,
    file: "http://example.com/bundle.zip",
    hash: "hash",
  });
  ret(data);
});

program.parse(process.argv);
