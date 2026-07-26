module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module:react-native-dotenv',
      {
        envName: 'APP_ENV',
        moduleName: '@env',
        allowUndefined: false,
        allowlist: [
          'HOT_UPDATER_APP_BASE_URL',
          'HOT_UPDATER_API_KEY',
          'HOT_UPDATER_E2E_RUNTIME_CONFIG_URL',
          'HOT_UPDATER_SUPABASE_URL',
        ],
        path: '.env.hotupdater',
      },
    ],
  ],
};
