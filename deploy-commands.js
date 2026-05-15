const { REST, Routes } = require('discord.js');
require('dotenv').config();
const { loadCommands } = require('./commands/registry');

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

const commands = loadCommands().map(command => command.data.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Registering ${commands.length} guild slash commands...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('Slash commands registered for this guild.');
  } catch (err) {
    if (err.code === 50001) {
      console.error(`Guild command registration failed with Missing Access for guild ${guildId}. Falling back to global commands.`);
      try {
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('Slash commands registered globally. They can take up to 1 hour to appear.');
        return;
      } catch (globalErr) {
        console.error('Global command registration failed:', globalErr);
      }
    } else {
      console.error('Failed to register commands:', err);
    }
    process.exit(1);
  }
})();
