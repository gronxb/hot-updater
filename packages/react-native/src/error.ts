export class HotUpdaterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HotUpdaterError";
	}
}
