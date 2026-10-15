const path = require('path');

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Inlines the values `src/hotUpdater.ts` imports from '@env' at bundle
    // time, read from .env.hotupdater. Only imported keys reach the bundle:
    // the provider credentials in that file stay out of it as long as nothing
    // imports them. The path is absolute so every bundling command works the
    // same whatever its working directory.
    [
      'module:react-native-dotenv',
      {
        moduleName: '@env',
        path: path.join(__dirname, '.env.hotupdater'),
        allowUndefined: true,
      },
    ],
  ],
};
