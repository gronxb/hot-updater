import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./checkForUpdate";

vi.mock("react-native", () => {
	return {
		Platform: {
			OS: "ios",
		},
	};
});

describe("appVersion 1.0, bundleVersion 0", async () => {
	afterEach(() => {
		vi.mock("./native", () => ({
			getAppVersion: async () => "1.0",
			getBundleVersion: async () => 0,
		}));
	});

	it("should return null if no update information is available", async () => {
		const updateInfo = {};

		const update = await checkForUpdate(updateInfo);
		expect(update).toBeNull();
	});

	it("should return null if no update is available when the app version is higher", async () => {
		const updateInfo = {
			"1.1": {
				bundleVersion: 1,
				forceUpdate: false,
			},
		};

		const update = await checkForUpdate(updateInfo);
		expect(update).toBeNull();
	});

	it("should update if a higher bundle version exists and forceUpdate is set to true", async () => {
		const updateInfo = {
			"1.0": {
				bundleVersion: 1,
				forceUpdate: true,
			},
		};

		const update = await checkForUpdate(updateInfo);
		expect(update).toStrictEqual({
			bundleVersion: 1,
			forceUpdate: true,
		});
	});

	it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
		const updateInfo = {
			"1.0": {
				bundleVersion: 1,
				forceUpdate: false,
			},
		};

		const update = await checkForUpdate(updateInfo);
		expect(update).toStrictEqual({
			bundleVersion: 1,
			forceUpdate: false,
		});
	});

	it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
		const updateInfo = {
			"1.0": {
				bundleVersion: 5,
				forceUpdate: false,
			},
		};

		const update = await checkForUpdate(updateInfo);
		expect(update).toStrictEqual({
			bundleVersion: 5,
			forceUpdate: false,
		});
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});
});
