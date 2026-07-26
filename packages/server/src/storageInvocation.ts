import {
  StorageConfigurationError,
  type HotUpdaterFeatureInvocation,
  type StorageInvocationToken,
  type StorageOperationContext,
} from "@hot-updater/plugin-core";

import type { StorageCallContext } from "./storageAccess";
import type { StorageResolverOperation } from "./storageContext";

type InvocationRecord<TContext> = {
  bound: boolean;
  storageContext?: StorageOperationContext;
  readonly operation: StorageResolverOperation<TContext>;
  readonly platformContext: TContext | undefined;
};

export type ResolvedStorageInvocation<TContext> = Readonly<{
  operation: StorageResolverOperation<TContext>;
  platformContext: TContext | undefined;
  storageContext?: StorageOperationContext;
}>;

export type StorageExecutionContext<TContext> = StorageCallContext<TContext> &
  Readonly<{
    invocation: HotUpdaterFeatureInvocation<TContext>;
  }>;

const invalidInvocation = (): StorageConfigurationError =>
  new StorageConfigurationError(
    "invalid-storage-invocation",
    "Storage access requires a live invocation token from this server.",
  );

const isTokenObject = (token: unknown): token is object =>
  typeof token === "object" && token !== null;

export class StorageInvocationAuthority<TContext> {
  readonly #records = new WeakMap<object, InvocationRecord<TContext>>();
  #activeCount = 0;
  #state: "active" | "closing" | "closed" = "active";
  #drain: Promise<void> | undefined;
  #resolveDrain: (() => void) | undefined;

  begin(
    input: Readonly<{
      operation: StorageResolverOperation<TContext>;
      platformContext: TContext | undefined;
    }>,
  ): StorageInvocationToken {
    if (this.#state !== "active") {
      throw new StorageConfigurationError(
        "disposed",
        "The Hot Updater runtime is disposed.",
      );
    }
    const token = Object.freeze({}) as StorageInvocationToken;
    this.#records.set(token, {
      bound: false,
      operation: input.operation,
      platformContext: input.platformContext,
    });
    this.#activeCount += 1;
    return token;
  }

  bind(
    token: StorageInvocationToken,
    context: StorageOperationContext | undefined,
  ): void {
    if (!isTokenObject(token)) throw invalidInvocation();
    const record = this.#records.get(token);
    if (record === undefined || record.bound) {
      throw invalidInvocation();
    }
    record.bound = true;
    record.storageContext = context;
  }

  resolve(token: StorageInvocationToken): ResolvedStorageInvocation<TContext> {
    if (!isTokenObject(token)) throw invalidInvocation();
    const record = this.#records.get(token);
    if (record === undefined || !record.bound) {
      throw invalidInvocation();
    }
    return Object.freeze({
      operation: record.operation,
      platformContext: record.platformContext,
      ...(record.storageContext === undefined
        ? {}
        : { storageContext: record.storageContext }),
    });
  }

  close(token: StorageInvocationToken): void {
    if (!isTokenObject(token)) return;
    if (!this.#records.delete(token)) return;
    this.#activeCount -= 1;
    if (this.#activeCount === 0 && this.#state === "closing") {
      this.#state = "closed";
      this.#resolveDrain?.();
      this.#resolveDrain = undefined;
    }
  }

  sealAndDrain(): Promise<void> {
    if (this.#drain !== undefined) return this.#drain;
    this.#state = "closing";
    this.#drain =
      this.#activeCount === 0
        ? Promise.resolve().then(() => {
            this.#state = "closed";
          })
        : new Promise<void>((resolve) => {
            this.#resolveDrain = resolve;
          });
    return this.#drain;
  }
}

export const requireHotUpdaterFeatureInvocation = <TContext>(
  invocation: unknown,
): HotUpdaterFeatureInvocation<TContext> => {
  if (typeof invocation !== "object" || invocation === null) {
    throw invalidInvocation();
  }
  if (!Reflect.has(invocation, "storageToken")) {
    throw invalidInvocation();
  }
  return invocation as HotUpdaterFeatureInvocation<TContext>;
};
