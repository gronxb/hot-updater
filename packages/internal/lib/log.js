"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
const picocolors_1 = __importDefault(require("picocolors"));
exports.log = {
    normal: (message) => console.log(message),
    success: (message) => console.log(picocolors_1.default.green(message)),
    info: (message) => console.log(picocolors_1.default.blue(message)),
    error: (message) => console.log(picocolors_1.default.red(message)),
    warn: (message) => console.log(picocolors_1.default.yellow(message)),
    debug: (message) => console.log(picocolors_1.default.gray(message)),
};
//# sourceMappingURL=log.js.map