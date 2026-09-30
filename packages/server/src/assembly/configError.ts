/** A misconfigured `createHotUpdater` call, reported at startup. */
export class HotUpdaterConfigError extends Error {
  readonly name = "HotUpdaterConfigError";
}
