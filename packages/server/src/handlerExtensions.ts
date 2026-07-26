import type { HotUpdaterContext } from "@hot-updater/plugin-core";

export type HandlerExtension<TContext = unknown> = (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response | undefined>;

export const executeHandlerExtensions = async <TContext>(
  extensions: readonly HandlerExtension<TContext>[],
  request: Request,
  context?: HotUpdaterContext<TContext>,
): Promise<Response | undefined> => {
  for (const extension of extensions) {
    const response = await extension(request, context);
    if (response !== undefined) return response;
  }
  return undefined;
};
