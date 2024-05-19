import { getAppVersion, getBundleVersion } from "./native";
import type { UpdateInfo } from "./types";
import { isNullable } from "./utils";

export const checkForUpdate = async (
	updateInfo: UpdateInfo | (() => Promise<UpdateInfo>) | (() => UpdateInfo),
) => {
	const info =
		typeof updateInfo === "function" ? await updateInfo() : updateInfo;

	const currentAppVersion = await getAppVersion();
	const latestAppVersionInfo = currentAppVersion
		? info?.[currentAppVersion]
		: null;

	if (isNullable(latestAppVersionInfo)) {
		return null;
	}

	const currentBundleVersion = await getBundleVersion();
	const latestBundleVersion = latestAppVersionInfo?.bundleVersion;

	if (
		isNullable(latestBundleVersion) ||
		isNullable(currentBundleVersion) ||
		latestBundleVersion <= currentBundleVersion
	) {
		return null;
	}

	return {
		bundleVersion: latestBundleVersion,
		forceUpdate: latestAppVersionInfo.forceUpdate,
	};
};
