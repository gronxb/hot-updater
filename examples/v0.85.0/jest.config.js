const path = require("path");

const reactNativePath = path.dirname(
  require.resolve("react-native/package.json"),
);

module.exports = {
  preset: "@react-native/jest-preset",
  moduleNameMapper: {
    "^react-native($|/.*)": `${reactNativePath}/$1`,
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  transformIgnorePatterns: [
    `${path.resolve(__dirname, "../../node_modules/.pnpm")}/(?!(react-native|jest-react-native|@react-native\\+.*|@react-native-community\\+.*)@)`,
    "node_modules/(?!.pnpm|((jest-)?react-native|@react-native(-community)?)/)",
  ],
};
