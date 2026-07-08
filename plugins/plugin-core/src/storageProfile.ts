import type {
  LegacyProfiledStoragePlugin,
  NodeStoragePlugin,
  RuntimeStoragePlugin,
} from "./types";

const createMissingProfileError = (
  plugin: Pick<LegacyProfiledStoragePlugin, "name" | "supportedProtocol">,
  profile: string,
) =>
  new Error(
    `${plugin.name} does not implement the ${profile} storage profile for protocol "${plugin.supportedProtocol}".`,
  );

export const isNodeStoragePlugin = <TContext = unknown>(
  plugin: LegacyProfiledStoragePlugin<TContext>,
): plugin is NodeStoragePlugin<TContext> => Boolean(plugin.profiles.node);

export const isRuntimeStoragePlugin = <TContext = unknown>(
  plugin: LegacyProfiledStoragePlugin<TContext>,
): plugin is RuntimeStoragePlugin<TContext> => Boolean(plugin.profiles.runtime);

export function assertNodeStoragePlugin<TContext = unknown>(
  plugin: LegacyProfiledStoragePlugin<TContext>,
): asserts plugin is NodeStoragePlugin<TContext> {
  if (!isNodeStoragePlugin(plugin)) {
    throw createMissingProfileError(plugin, "node");
  }
}

export function assertRuntimeStoragePlugin<TContext = unknown>(
  plugin: LegacyProfiledStoragePlugin<TContext>,
): asserts plugin is RuntimeStoragePlugin<TContext> {
  if (!isRuntimeStoragePlugin(plugin)) {
    throw createMissingProfileError(plugin, "runtime");
  }
}
