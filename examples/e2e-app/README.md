# @examples/e2e-app

The app the E2E scenarios drive: its screens, routes and runtime, the
`E2ELaunchArguments` native module, and the headless task. Every E2E target in
`examples/` (see [targets](../../e2e/README.md#targets)) runs this same app.

A target app keeps what the control server rewrites or what is the app's own:

- `index.js`: `registerE2eApp(appName, App)`.
- `App.tsx`: renders `E2eHotUpdaterApp` with the scenario marker, and requires
  the built-in reuse assets in `src/test`.
- `src/e2eApp/patchSurface.ts`: the marker, crash guard and deploy-asset guard
  the control server rewrites for each deploy. The deploy fixtures it writes
  live in the app's `src/test`.

## Dependencies come from the app

This package declares no React, React Native, React Navigation,
react-native-screens, valtio or SDK dependency: each target app provides
them, in the versions its native code was built with. The app's bundler and
Jest resolve this package's imports from the app:

- Re.Pack: `resolve: withE2eAppResolve(resolve, __dirname)` from
  `@examples/e2e-app/rspack`.
- Metro: `resolveRequest: withE2eAppResolveRequest(resolveRequest, __dirname)`
  and `watchFolders: [E2E_APP_DIR]` from `@examples/e2e-app/metro`.
- Jest: `resolver: require.resolve("@examples/e2e-app/jest-resolver")`.

The bundler config also calls `writeE2eBuildConfig(__dirname)` from
`@examples/e2e-app/build-config`, which writes the run's public settings to
`src/e2eBuildConfig.js`. A second runtime, such as the brownfield widget,
reads those settings from `@examples/e2e-app/config` without starting the
main app.
