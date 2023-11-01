export class HotUpdaterDownloadError extends Error {
  constructor() {
    super("HotUpdater failed to download");
    this.name = "HotUpdaterDownloadError";
  }
}

export class HotUpdaterPlatformError extends Error {
  constructor() {
    super("HotUpdater is only supported on iOS and Android");
    this.name = "HotUpdaterPlatformError";
  }
}

export class HotUpdaterMetadataError extends Error {
  constructor() {
    super("HotUpdater metadata is not defined");
    this.name = "HotUpdaterMetadataError";
  }
}
