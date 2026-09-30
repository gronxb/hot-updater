/**
 * The cloud resource an adapter reads and writes, as its factory was given
 * it, such as `{ bucketName: "hot-updater-storage" }`. A managed server's
 * setup compares it with the resource it set up, since the managed runtime
 * serves its own whatever the server definition passes.
 */
export type AdapterResource = Readonly<Record<string, string | undefined>>;

const RESOURCE = Symbol.for("@hot-updater/adapter-resource");

/** `adapter`, recording the resource it reaches. */
export const withAdapterResource = <T extends object>(
  adapter: T,
  resource: AdapterResource,
): T => Object.assign(adapter, { [RESOURCE]: resource });

/** The resource `adapter` reaches, as its factory recorded it. */
export const adapterResourceOf = (
  adapter: unknown,
): AdapterResource | undefined =>
  typeof adapter === "object" && adapter !== null
    ? (adapter as { readonly [RESOURCE]?: AdapterResource })[RESOURCE]
    : undefined;
