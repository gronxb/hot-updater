import type { MalformedBundleCase } from "./bundleValidation.testCases";
import { createCompleteBundle } from "./bundleValidation.testFixtures";

export const hostileBundleCases = (): readonly MalformedBundleCase[] => [
  {
    label: "Bundle accessor",
    create: (observeGetter) => {
      const bundle = createCompleteBundle();
      Object.defineProperty(bundle, "channel", {
        enumerable: true,
        get: () => {
          observeGetter();
          return "production";
        },
      });
      return bundle;
    },
  },
  {
    label: "nested patch accessor",
    create: (observeGetter) => {
      const bundle = createCompleteBundle();
      Object.defineProperty(bundle.patches[0], "patchFileHash", {
        enumerable: true,
        get: () => {
          observeGetter();
          return "patch-hash";
        },
      });
      return bundle;
    },
  },
  {
    label: "Bundle symbol key",
    create: () => {
      const bundle = createCompleteBundle();
      Reflect.set(bundle, Symbol("hidden"), true);
      return bundle;
    },
  },
  {
    label: "nested patch symbol key",
    create: () => {
      const bundle = createCompleteBundle();
      Reflect.set(bundle.patches[0], Symbol("hidden"), true);
      return bundle;
    },
  },
  {
    label: "Bundle prototype",
    create: () => Object.create(createCompleteBundle()),
  },
  {
    label: "nested patch prototype",
    create: () => {
      const bundle = createCompleteBundle();
      Reflect.set(bundle, "patches", [Object.create(bundle.patches[0])]);
      return bundle;
    },
  },
  {
    label: "hostile Bundle proxy",
    create: (observeGetter) =>
      new Proxy(createCompleteBundle(), {
        get: (target, key, receiver) => {
          observeGetter();
          return Reflect.get(target, key, receiver);
        },
        ownKeys: () => {
          throw new RangeError("hostile ownKeys");
        },
      }),
  },
  {
    label: "hostile nested patch proxy",
    create: (observeGetter) => {
      const bundle = createCompleteBundle();
      Reflect.set(bundle, "patches", [
        new Proxy(bundle.patches[0], {
          get: (target, key, receiver) => {
            observeGetter();
            return Reflect.get(target, key, receiver);
          },
          getOwnPropertyDescriptor: () => {
            throw new RangeError("hostile descriptor");
          },
        }),
      ]);
      return bundle;
    },
  },
];
