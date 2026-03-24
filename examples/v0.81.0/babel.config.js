module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module:react-native-dotenv',
      {
        envName: 'APP_ENV',
        moduleName: '@env',
        allowlist: ['HOT_UPDATER_APP_BASE_URL', 'HOT_UPDATER_SUPABASE_URL'],
        path: '.env.hotupdater',
      },
    ],
  ],
};
