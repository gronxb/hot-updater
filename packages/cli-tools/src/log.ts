import picocolors from "picocolors";

import { fitText } from "./messageLines";
import { maskSecretValues } from "./secretMasking";

type LogMessage = string | number | null | undefined;

const mask = (message: LogMessage) =>
  typeof message === "string" ? fitText(maskSecretValues(message)) : message;

export const log = {
  normal: (message: LogMessage) => console.log(mask(message)),
  success: (message: LogMessage) =>
    console.log(picocolors.green(mask(message))),
  info: (message: LogMessage) => console.log(picocolors.blue(mask(message))),
  error: (message: LogMessage) => console.log(picocolors.red(mask(message))),
  warn: (message: LogMessage) => console.log(picocolors.yellow(mask(message))),
  debug: (message: LogMessage) => console.log(picocolors.gray(mask(message))),
};
