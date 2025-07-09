import { NativeBuildIosScheme, RequiredDeep } from "@hot-updater/plugin-core";
import * as p from "@clack/prompts";

export const installAndLaunchIOS = ({}: {
  schemeConfig: RequiredDeep<NativeBuildIosScheme>;
}) =>  {
  // TODO: implement iOS logic
  p.log.warn("iOS is not supported yet.");
}
