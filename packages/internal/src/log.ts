import picocolors from "picocolors";

export const log = {
  normal: (message: string | number | null | undefined) => console.log(message),
  success: (message: string | number | null | undefined) =>
    console.log(picocolors.green(message)),
  info: (message: string | number | null | undefined) =>
    console.log(picocolors.blue(message)),
  error: (message: string | number | null | undefined) =>
    console.log(picocolors.red(message)),
  warn: (message: string | number | null | undefined) =>
    console.log(picocolors.yellow(message)),
  debug: (message: string | number | null | undefined) =>
    console.log(picocolors.gray(message)),
};
