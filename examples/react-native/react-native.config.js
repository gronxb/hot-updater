const commands = require('@callstack/repack/commands').filter(command => {
  return command.name.startsWith('webpack');
});
module.exports = {
  commands,
};
