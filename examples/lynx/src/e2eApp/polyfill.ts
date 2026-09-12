import "url-search-params-polyfill";

type MinimalNode = {
  appendChild: (child: unknown) => unknown;
  removeChild: (child: unknown) => unknown;
  setAttribute: (name: string, value: string) => void;
  style: Record<string, string>;
};

const createNode = (): MinimalNode => ({
  appendChild: (child) => child,
  removeChild: (child) => child,
  setAttribute: () => undefined,
  style: {},
});

const globalScope = globalThis as typeof globalThis & {
  document?: {
    body?: unknown;
    createElement?: (tag: string) => unknown;
    createElementNS?: (ns: string, tag: string) => unknown;
    documentElement?: unknown;
    getElementById?: (id: string) => unknown;
    head?: unknown;
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => unknown[];
  };
  history?: {
    back: () => void;
    forward: () => void;
    go: (delta?: number) => void;
    pushState: (...args: unknown[]) => void;
    replaceState: (...args: unknown[]) => void;
  };
  window?: typeof globalThis;
};

if (typeof globalScope.document === "undefined") {
  globalScope.document = {};
}
const documentRef = globalScope.document;
if (typeof documentRef.createElement !== "function") {
  documentRef.createElement = () => createNode();
}
if (typeof documentRef.createElementNS !== "function") {
  documentRef.createElementNS = () => createNode();
}
if (typeof documentRef.getElementById !== "function") {
  documentRef.getElementById = () => null;
}
if (typeof documentRef.querySelector !== "function") {
  documentRef.querySelector = () => null;
}
if (typeof documentRef.querySelectorAll !== "function") {
  documentRef.querySelectorAll = () => [];
}
documentRef.body ??= createNode();
documentRef.head ??= createNode();
documentRef.documentElement ??= createNode();

if (typeof globalScope.window === "undefined") {
  globalScope.window = globalScope;
}
if (typeof globalScope.history === "undefined") {
  globalScope.history = {
    back: () => undefined,
    forward: () => undefined,
    go: () => undefined,
    pushState: () => undefined,
    replaceState: () => undefined,
  };
}
