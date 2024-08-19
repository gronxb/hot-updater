import type { Platform, UpdateSource } from "./types";
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
export declare const filterTargetVersion: (sources: UpdateSource[], targetVersion: string, platform?: Platform) => UpdateSource[];
