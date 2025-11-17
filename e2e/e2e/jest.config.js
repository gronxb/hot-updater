/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  rootDir: "..",
  testMatch: ["<rootDir>/tests/**/*.e2e.ts", "<rootDir>/tests/**/*.e2e.js"],
  testTimeout: 120000,
  maxWorkers: 1,
  globalSetup: "<rootDir>/scripts/setup-test-env.ts",
  globalTeardown: "<rootDir>/scripts/teardown-test-env.ts",
  reporters: ["detox/runners/jest/reporter"],
  testEnvironment: "detox/runners/jest/testEnvironment",
  verbose: true,
  preset: "ts-jest",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
      },
    ],
  },
};
