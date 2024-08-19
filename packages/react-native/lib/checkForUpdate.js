var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { filterTargetVersion } from "@hot-updater/internal";
import { Platform } from "react-native";
import { getAppVersion, getBundleVersion } from "./native";
import { isNullable } from "./utils";
var findLatestSources = function (sources) {
    var _a, _b, _c;
    return ((_c = (_b = (_a = sources === null || sources === void 0 ? void 0 : sources.filter(function (item) { return item.enabled; })) === null || _a === void 0 ? void 0 : _a.sort(function (a, b) { return b.bundleVersion - a.bundleVersion; })) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : null);
};
var checkForRollback = function (sources, currentBundleVersion) {
    var _a, _b;
    var enabled = (_a = sources === null || sources === void 0 ? void 0 : sources.find(function (item) { return item.bundleVersion === currentBundleVersion; })) === null || _a === void 0 ? void 0 : _a.enabled;
    var availableOldVersion = (_b = sources === null || sources === void 0 ? void 0 : sources.find(function (item) { return item.bundleVersion < currentBundleVersion && item.enabled; })) === null || _b === void 0 ? void 0 : _b.enabled;
    if (isNullable(enabled)) {
        return availableOldVersion;
    }
    return !enabled;
};
var ensureUpdateSource = function (updateSource) { return __awaiter(void 0, void 0, void 0, function () {
    var source, response;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                source = null;
                if (!(typeof updateSource === "string")) return [3 /*break*/, 4];
                if (!updateSource.startsWith("http")) return [3 /*break*/, 3];
                return [4 /*yield*/, fetch(updateSource)];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json()];
            case 2:
                source = (_a.sent());
                _a.label = 3;
            case 3: return [3 /*break*/, 7];
            case 4:
                if (!(typeof updateSource === "function")) return [3 /*break*/, 6];
                return [4 /*yield*/, updateSource()];
            case 5:
                source = _a.sent();
                return [3 /*break*/, 7];
            case 6:
                source = updateSource;
                _a.label = 7;
            case 7:
                if (!source) {
                    throw new Error("Invalid source");
                }
                return [2 /*return*/, source];
        }
    });
}); };
export var checkForUpdate = function (updateSources) { return __awaiter(void 0, void 0, void 0, function () {
    var sources, currentAppVersion, platform, appVersionSources, currentBundleVersion, isRollback, latestSource;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, ensureUpdateSource(updateSources)];
            case 1:
                sources = _a.sent();
                return [4 /*yield*/, getAppVersion()];
            case 2:
                currentAppVersion = _a.sent();
                platform = Platform.OS;
                appVersionSources = currentAppVersion
                    ? filterTargetVersion(sources, currentAppVersion, platform)
                    : [];
                return [4 /*yield*/, getBundleVersion()];
            case 3:
                currentBundleVersion = _a.sent();
                isRollback = checkForRollback(appVersionSources, currentBundleVersion);
                return [4 /*yield*/, findLatestSources(appVersionSources)];
            case 4:
                latestSource = _a.sent();
                if (!latestSource) {
                    if (isRollback) {
                        return [2 /*return*/, {
                                bundleVersion: 0,
                                forceUpdate: true,
                                file: null,
                                hash: null,
                                status: "ROLLBACK",
                            }];
                    }
                    return [2 /*return*/, null];
                }
                if (latestSource.file)
                    if (isRollback) {
                        if (latestSource.bundleVersion === currentBundleVersion) {
                            return [2 /*return*/, null];
                        }
                        if (latestSource.bundleVersion > currentBundleVersion) {
                            return [2 /*return*/, {
                                    bundleVersion: latestSource.bundleVersion,
                                    forceUpdate: latestSource.forceUpdate,
                                    file: latestSource.file,
                                    hash: latestSource.hash,
                                    status: "UPDATE",
                                }];
                        }
                        return [2 /*return*/, {
                                bundleVersion: latestSource.bundleVersion,
                                forceUpdate: true,
                                file: latestSource.file,
                                hash: latestSource.hash,
                                status: "ROLLBACK",
                            }];
                    }
                if (latestSource.bundleVersion > currentBundleVersion) {
                    return [2 /*return*/, {
                            bundleVersion: latestSource.bundleVersion,
                            forceUpdate: latestSource.forceUpdate,
                            file: latestSource.file,
                            hash: latestSource.hash,
                            status: "UPDATE",
                        }];
                }
                return [2 /*return*/, null];
        }
    });
}); };
