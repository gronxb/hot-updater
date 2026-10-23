module.exports = {
  preset: 'react-native',
  // @examples/e2e-app resolves its imports from this app, as the bundler does.
  resolver: require.resolve('@examples/e2e-app/jest-resolver'),
};
