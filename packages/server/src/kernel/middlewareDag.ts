import type {
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRequestExecutionContext,
} from "./contracts";
import { HotUpdaterConstructionError } from "./errors";

const opaqueInternalError = (): Response =>
  Response.json({ error: "Internal server error" }, { status: 500 });

const normalizeResponse = (value: unknown): Response | undefined => {
  if (value instanceof Response) return value;
  if (Object.prototype.toString.call(value) !== "[object Response]") {
    return undefined;
  }

  try {
    const response = value as Response;
    return new Response(response.body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return undefined;
  }
};

const sortedUniqueDependencies = (
  middleware: HotUpdaterPostAuthMiddleware,
): readonly string[] =>
  Object.freeze(
    [
      ...new Set([...(middleware.after ?? []), ...(middleware.before ?? [])]),
    ].sort(),
  );

const copyMiddleware = (
  middleware: HotUpdaterPostAuthMiddleware,
): HotUpdaterPostAuthMiddleware =>
  Object.freeze({
    after:
      middleware.after === undefined
        ? undefined
        : Object.freeze([...middleware.after]),
    before:
      middleware.before === undefined
        ? undefined
        : Object.freeze([...middleware.before]),
    handle: middleware.handle,
    id: middleware.id,
    phase: middleware.phase,
  });

export const compilePostAuthMiddleware = (
  middleware: readonly HotUpdaterPostAuthMiddleware[],
): readonly HotUpdaterPostAuthMiddleware[] => {
  const byId = new Map<string, HotUpdaterPostAuthMiddleware>();
  for (const item of middleware) {
    if (byId.has(item.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_MIDDLEWARE_ID", {
        middlewareId: item.id,
      });
    }
    byId.set(item.id, copyMiddleware(item));
  }

  const orderedItems = [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const outgoing = new Map<string, Set<string>>();
  const incomingCount = new Map<string, number>();
  for (const item of orderedItems) {
    outgoing.set(item.id, new Set());
    incomingCount.set(item.id, 0);
  }

  const addEdge = (from: string, to: string): void => {
    const targets = outgoing.get(from);
    if (targets === undefined || targets.has(to)) return;
    targets.add(to);
    incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
  };

  for (const item of orderedItems) {
    for (const dependencyId of sortedUniqueDependencies(item)) {
      if (!byId.has(dependencyId)) {
        throw new HotUpdaterConstructionError("UNKNOWN_MIDDLEWARE_DEPENDENCY", {
          dependencyId,
          middlewareId: item.id,
        });
      }
    }
    for (const dependencyId of item.after ?? []) {
      addEdge(dependencyId, item.id);
    }
    for (const dependencyId of item.before ?? []) {
      addEdge(item.id, dependencyId);
    }
  }

  const ready = orderedItems
    .filter((item) => incomingCount.get(item.id) === 0)
    .map((item) => item.id);
  const result: HotUpdaterPostAuthMiddleware[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => left.localeCompare(right));
    const id = ready.shift();
    if (id === undefined) break;
    const item = byId.get(id);
    if (item !== undefined) result.push(item);
    const targets = [...(outgoing.get(id) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const target of targets) {
      const nextCount = (incomingCount.get(target) ?? 0) - 1;
      incomingCount.set(target, nextCount);
      if (nextCount === 0) ready.push(target);
    }
  }

  if (result.length !== orderedItems.length) {
    const middlewareIds = orderedItems
      .filter((item) => (incomingCount.get(item.id) ?? 0) > 0)
      .map((item) => item.id);
    throw new HotUpdaterConstructionError("MIDDLEWARE_DEPENDENCY_CYCLE", {
      middlewareIds: Object.freeze(middlewareIds),
    });
  }
  return Object.freeze(result);
};

export type ExecutePostAuthMiddlewareOptions = {
  readonly context: HotUpdaterRequestExecutionContext;
  readonly handler: () => Promise<Response>;
  readonly middleware: readonly HotUpdaterPostAuthMiddleware[];
};

export const executePostAuthMiddleware = async (
  options: ExecutePostAuthMiddlewareOptions,
): Promise<Response> => {
  let nextWasReused = false;

  const dispatch = async (index: number): Promise<Response> => {
    const item = options.middleware[index];
    if (item === undefined) return options.handler();

    let active = true;
    let downstream: Promise<Response> | undefined;
    const next = (): Promise<Response> => {
      if (!active) {
        nextWasReused = true;
        return Promise.resolve(opaqueInternalError());
      }
      if (downstream === undefined) {
        downstream = dispatch(index + 1);
      } else {
        nextWasReused = true;
      }
      return downstream;
    };
    try {
      return await item.handle(options.context, next);
    } finally {
      active = false;
    }
  };

  try {
    const response = normalizeResponse(await dispatch(0));
    return nextWasReused || response === undefined
      ? opaqueInternalError()
      : response;
  } catch {
    return opaqueInternalError();
  }
};
