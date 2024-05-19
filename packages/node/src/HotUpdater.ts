import Sqids from "sqids";
import type { HotUpdaterReadStrategy, MetaDataOptions, Version } from "./types";

export interface HotUpdaterOptions {
	config: HotUpdaterReadStrategy;
}

export class HotUpdater {
	private config: HotUpdaterReadStrategy;
	private sqids = new Sqids({
		alphabet: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	});

	constructor({ config }: HotUpdaterOptions) {
		this.config = config;
	}

	public encodeVersion(version: Version) {
		return this.sqids.encode(version.split(".").map(Number));
	}

	public decodeVersion(hash: string) {
		const version = this.sqids.decode(hash);
		return version.join(".");
	}

	public async getVersionList() {
		const files = await this.config.getListObjects();

		const versionSet = new Set(
			files.map((file) => {
				const url = new URL(file);
				const [prefix] = url.pathname.split("/").filter(Boolean);
				const version = this.decodeVersion(prefix);
				return version;
			}),
		);

		return Array.from(versionSet);
	}

	public async getMetaData({
		version,
		reloadAfterUpdate = false,
	}: MetaDataOptions) {
		const prefix = `${this.encodeVersion(version)}/`;

		return {
			files: await this.config.getListObjects(prefix),
			id: this.encodeVersion(version),
			version,
			reloadAfterUpdate,
		};
	}

	public static create(options: HotUpdaterOptions): HotUpdater {
		return new HotUpdater(options);
	}
}
