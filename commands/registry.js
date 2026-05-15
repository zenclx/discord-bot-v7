const fs = require('fs');
const path = require('path');

const SKIP_COMMAND_FILES = new Set([
  'elo.js',
  'eloresetall.js',
  'eloresetplayer.js',
  'registry.js',
]);

function loadCommands() {
  const commandDir = __dirname;
  const commands = [];
  const names = new Set();
  const files = fs.readdirSync(commandDir)
    .filter(file => file.endsWith('.js') && !SKIP_COMMAND_FILES.has(file))
    .sort();

  for (const file of files) {
    const imported = require(path.join(commandDir, file));
    const exportedCommands = imported.data && imported.execute ? [imported] : Object.values(imported);

    for (const command of exportedCommands) {
      if (!command?.data || !command?.execute) continue;
      if (names.has(command.data.name)) continue;
      names.add(command.data.name);
      commands.push(command);
    }
  }

  return commands;
}

module.exports = { loadCommands };
