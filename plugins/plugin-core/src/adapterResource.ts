/**
 * The cloud resource a database or storage reaches, as its factory was
 * given it, such as `{ bucketName: "hot-updater-storage" }`: the `resource`
 * of `EngineDatabase` and `StorageAdapter`. A managed server's setup
 * compares it with the resource it set up, since the managed runtime serves
 * its own whatever the server definition passes.
 */
export type AdapterResource = Readonly<Record<string, string | undefined>>;
