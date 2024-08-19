import picocolors from "picocolors";
export const log = {
    normal: (message) => console.log(message),
    success: (message) => console.log(picocolors.green(message)),
    info: (message) => console.log(picocolors.blue(message)),
    error: (message) => console.log(picocolors.red(message)),
    warn: (message) => console.log(picocolors.yellow(message)),
    debug: (message) => console.log(picocolors.gray(message)),
};
//# sourceMappingURL=log.js.map