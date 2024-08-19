var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { lstatSync } from "fs";
import path from "path";
import { readdir } from "fs/promises";
export const readDir = (dir) => __awaiter(void 0, void 0, void 0, function* () {
    const files = yield readdir(dir, {
        recursive: true,
    });
    return files.filter((file) => !lstatSync(path.join(dir, file)).isDirectory());
});
//# sourceMappingURL=readDir.js.map