"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterTargetVersion = void 0;
const semver_1 = __importDefault(require("semver"));
/**
 *
 * Filters based on semver. And sorts by the highest bundle version.
 *
 * * Range Expression Table:
 *
 * | Range Expression | Who gets the update                                                    |
 * |------------------|------------------------------------------------------------------------|
 * | 1.2.3            | Only devices running the specific binary app store version 1.2.3 of your app |
 * | *                | Any device configured to consume updates from your CodePush app         |
 * | 1.2.x            | Devices running major version 1, minor version 2 and any patch version of your app |
 * | 1.2.3 - 1.2.7    | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (inclusive) |
 * | >=1.2.3 <1.2.7   | Devices running any binary version between 1.2.3 (inclusive) and 1.2.7 (exclusive) |
 * | 1.2              | Equivalent to >=1.2.0 <1.3.0                                            |
 * | ~1.2.3           | Equivalent to >=1.2.3 <1.3.0                                            |
 * | ^1.2.3           | Equivalent to >=1.2.3 <2.0.0                                            |
 */
const filterTargetVersion = (sources, targetVersion, platform) => {
    var _a;
    // coerce currentVersion to a semver-compatible version
    const currentVersionCoerce = (_a = semver_1.default.coerce(targetVersion)) === null || _a === void 0 ? void 0 : _a.version;
    // Filter sources by platform and if currentVersion satisfies the targetVersion range
    const filteredSources = sources
        .filter((source) => {
        if (platform) {
            return source.platform === platform;
        }
        return true;
    })
        .filter((source) => targetVersion === "*" ||
        semver_1.default.satisfies(currentVersionCoerce !== null && currentVersionCoerce !== void 0 ? currentVersionCoerce : "*", source.targetVersion));
    // Separate '*' versions from other versions
    const starVersions = filteredSources.filter((source) => source.targetVersion === "*");
    const otherVersions = filteredSources.filter((source) => source.targetVersion !== "*");
    // Sort other versions by their minimum semver value in descending order
    const sortedOtherVersions = otherVersions.sort((a, b) => {
        const minA = semver_1.default.minVersion(a.targetVersion);
        const minB = semver_1.default.minVersion(b.targetVersion);
        if (minA && minB) {
            return semver_1.default.rcompare(minA, minB);
        }
        return semver_1.default.rcompare(a.targetVersion, b.targetVersion);
    });
    // Combine '*' versions and sorted other versions
    const combinedSortedVersions = [...starVersions, ...sortedOtherVersions];
    // Sort by bundleVersion in descending order
    return combinedSortedVersions.sort((a, b) => b.bundleVersion - a.bundleVersion);
};
exports.filterTargetVersion = filterTargetVersion;
//# sourceMappingURL=filterTargetVersion.js.map