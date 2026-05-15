const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function cleanEnvValue(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

const token = cleanEnvValue(process.env.DISCORD_TOKEN).replace(/^Bot\s+/i, '');
const clientId = cleanEnvValue(process.env.CLIENT_ID);
const guildId = cleanEnvValue(process.env.GUILD_ID);

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const commands = [];
const names = new Set();
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const imported = require(`./commands/${file}`);
  const exportedCommands = imported.data && imported.execute ? [imported] : Object.values(imported);

  for (const command of exportedCommands) {
    if (!command?.data || !command?.execute) continue;
    if (names.has(command.data.name)) continue;
    names.add(command.data.name);
    commands.push(command.data.toJSON());
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
