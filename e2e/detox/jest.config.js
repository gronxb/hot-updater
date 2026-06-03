module.exports = {
  rootDir: "../..",
  testMatch: ["<rootDir>/e2e/detox/**/*.spec.js"],
  testTimeout: 720000,
  maxWorkers: 1,
  bail: 1,
  globalSetup: "detox/runners/jest/globalSetup",
  globalTeardown: "detox/runners/jest/globalTeardown",
  reporters: ["detox/runners/jest/reporter"],
  testEnvironment: "detox/runners/jest/testEnvironment",
  transform: {
    "^.+\\.ts$": [
      "babel-jest",
      {
        plugins: ["@babel/plugin-transform-modules-commonjs"],
        presets: ["@babel/preset-typescript"],
      },
    ],
  },
  verbose: true,
};
