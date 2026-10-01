# @hot-updater/protocol

The device-safe, zero-dependency package for what crosses a boundary:

- the data formats and pure computations that the app and the server share,
  where both sides must get the same answer;
- the contracts between a host and its extensions on the device, such as the
  client plugin contract, and the reference host that runs them.

It runs anywhere: Hermes, Node, Workers, and Deno. Code that only the server
or the CLI uses belongs in `@hot-updater/plugin-core` or
`@hot-updater/server`.

## What belongs here

Code moves into this package only when all three hold:

1. It crosses a boundary: a format or computation both the app and the server
   run, or a contract a host on the device offers its extensions.
2. It does no I/O of its own: what reaches the device or the network, such as
   the plugin host's `fetch` and storage, the caller passes in. It uses no Node
   or React Native API and keeps no global state.
3. It needs no dependency. This package has none; what it takes from another
   package, such as verkit's version parsing, is bundled into `dist`.

It holds the domain types, the release catalog format and its scope rules,
the rollout cohort math, bundle artifacts, the bundle id format (`uuid`), the
client plugin contract, `canonicalizeAppVersion`, and `resolveBaseURL`. Client
plugin authors import `defineClientPlugin` and its types from here.
`createPluginHost` is the host the SDK runs client plugins on: a device SDK
passes it the platform, the device's storage, and `fetch`, and
`@hot-updater/test-utils/react-native` passes it fakes.

## Boundary with `@hot-updater/plugin-core`

`@hot-updater/plugin-core` is the kit that extends the server: the storage and
database adapter contracts, the server plugin authoring API, and their
helpers. It runs wherever the server runs, in Node, Workers, Deno, or Lambda,
and depends on this package, never the reverse. The app never imports it:
React Native imports only this package.

`src/package.spec.ts` checks that this package has no dependencies and imports
only what its build bundles. An oxlint rule refuses `@hot-updater/plugin-core`
and `@hot-updater/server` imports in `packages/protocol/src` and
`packages/react-native/src`.
