require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder, ChannelType } = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DATA_FILE = process.argv[2] || 'data.json';
const BACKUP_CHANNEL_NAME = 'clan-labs-bot-data';
const BACKUP_MARKER = 'CLAN_LABS_BOT_DATA_V1';

if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}
if (!fs.existsSync(DATA_FILE)) {
  console.error(`File not found: ${DATA_FILE}`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('Loaded data from', DATA_FILE);

    const guild = await client.guilds.fetch(GUILD_ID);
    const channels = await guild.channels.fetch();
    const channel = channels.find(c => c?.type === ChannelType.GuildText && c.name === BACKUP_CHANNEL_NAME);

    if (!channel) {
      console.error(`Channel "${BACKUP_CHANNEL_NAME}" not found in guild`);
      client.destroy();
      return;
    }

    const attachment = new AttachmentBuilder(
      Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      { name: 'data.json' }
    );

    await channel.send({
      content: `${BACKUP_MARKER}\nRestored: ${new Date().toISOString()}`,
      files: [attachment],
    });

    console.log('Done! Backup sent to #' + BACKUP_CHANNEL_NAME);
    console.log('Now run: npm start');
  } catch (err) {
    console.error('Error:', err.message);
  }
  client.destroy();
});

client.login(TOKEN);
