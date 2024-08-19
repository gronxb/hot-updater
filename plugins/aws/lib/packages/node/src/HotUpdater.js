var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import Sqids from "sqids";
export class HotUpdater {
    constructor({ config }) {
        this.sqids = new Sqids({
            alphabet: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
        });
        this.config = config;
    }
    encodeVersion(version) {
        return this.sqids.encode(version.split(".").map(Number));
    }
    decodeVersion(hash) {
        const version = this.sqids.decode(hash);
        return version.join(".");
    }
    getVersionList() {
        return __awaiter(this, void 0, void 0, function* () {
            const files = yield this.config.getListObjects();
            const versionSet = new Set(files.map((file) => {
                const url = new URL(file);
                const [prefix] = url.pathname.split("/").filter(Boolean);
                const version = this.decodeVersion(prefix);
                return version;
            }));
            return Array.from(versionSet);
        });
    }
    getMetaData(_a) {
        return __awaiter(this, arguments, void 0, function* ({ version, reloadAfterUpdate = false, }) {
            const prefix = `${this.encodeVersion(version)}/`;
            return {
                files: yield this.config.getListObjects(prefix),
                id: this.encodeVersion(version),
                version,
                reloadAfterUpdate,
            };
        });
    }
    static create(options) {
        return new HotUpdater(options);
    }
}
//# sourceMappingURL=HotUpdater.js.map