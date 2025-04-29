module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      'hot-updater/babel-plugin',
    ],
  };
};
