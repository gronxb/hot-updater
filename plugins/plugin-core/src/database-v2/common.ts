export type MaybePromise<T> = T | Promise<T>;

export type Sha256Digest = (bytes: Uint8Array) => MaybePromise<Uint8Array>;

/**
 * An immutable scope asserted by a trusted host.
 *
 * The host authenticates the caller and derives both identifiers. A connector
 * enforces this assertion but does not authenticate arbitrary callers.
 */
export interface AssertedDatabaseScope<TContext> {
  readonly tenantId: string;
  readonly principalId: string;
  readonly context: TContext;
}

export interface Versioned<T> {
  readonly value: T;
  readonly revision: string;
}
