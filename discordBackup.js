const { AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const db = require('./database');

const BACKUP_CHANNEL_NAME = 'clan-labs-bot-data';
const BACKUP_MARKER = 'CLAN_LABS_BOT_DATA_V1';
const BACKUP_FILE = 'data.json';
let backupMessageId = null;
let backupTimer = null;
let restoring = false;

function getGuildId() {
  return process.env.GUILD_ID;
}

async function getBackupChannel(client) {
  if (process.env.DATA_BACKUP_CHANNEL_ID) {
    const configured = await client.channels.fetch(process.env.DATA_BACKUP_CHANNEL_ID).catch(() => null);
    if (configured?.type === ChannelType.GuildText) return configured;
  }

  const guildId = getGuildId();
  if (!guildId) return null;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const channels = await guild.channels.fetch().catch(() => null);
  const existing = channels?.find(
    channel => channel?.type === ChannelType.GuildText && channel.name === BACKUP_CHANNEL_NAME
  );
  if (existing) return existing;

  return guild.channels.create({
    name: BACKUP_CHANNEL_NAME,
    type: ChannelType.GuildText,
    reason: 'Persistent bot data backup',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    ],
  }).catch(error => {
    console.error('Could not create Discord backup channel:', error.message);
    return null;
  });
}

async function findBackupMessage(channel, client) {
  if (backupMessageId) {
    const message = await channel.messages.fetch(backupMessageId).catch(() => null);
    if (message) return message;
  }

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const message = messages?.find(
    msg => msg.author.id === client.user.id
      && (msg.content.includes(BACKUP_MARKER) || msg.attachments.some(file => file.name === BACKUP_FILE))
  );
  if (message) backupMessageId = message.id;
  return message || null;
}

async function readBackup(message) {
  const attachment = message.attachments.find(file => file.name === BACKUP_FILE);
  if (!attachment) return null;

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Backup download failed: ${response.status}`);
  return response.json();
}

async function restoreFromDiscord(client) {
  restoring = true;
  try {
    const channel = await getBackupChannel(client);
    if (!channel) return false;

    const message = await findBackupMessage(channel, client);
    if (!message) {
      restoring = false;
      await saveToDiscord(client);
      return false;
    }

    const data = await readBackup(message);
    if (!data || typeof data !== 'object') return false;

    db.replace(data);
    console.log('Restored bot data from Discord backup.');
    return true;
  } catch (error) {
    console.error('Discord backup restore failed:', error.message);
    return false;
  } finally {
    restoring = false;
  }
}

async function saveToDiscord(client) {
  if (restoring) return false;

  const channel = await getBackupChannel(client);
  if (!channel) return false;

  const data = db.get();
  const attachment = new AttachmentBuilder(
    Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
    { name: BACKUP_FILE }
  );
  const payload = {
    content: `${BACKUP_MARKER}\nUpdated: ${new Date().toISOString()}`,
    files: [attachment],
  };

  const existing = await findBackupMessage(channel, client);
  if (existing) {
    const updated = await existing.edit(payload).catch(() => null);
    if (updated) {
      backupMessageId = updated.id;
      console.log('Saved bot data to Discord backup.');
      return true;
    }
  }

  const created = await channel.send(payload).catch(error => {
    console.error('Discord backup save failed:', error.message);
    return null;
  });
  if (created) {
    backupMessageId = created.id;
    console.log('Saved bot data to Discord backup.');
    return true;
  }
  return false;
}

function scheduleDiscordBackup(client) {
  if (restoring) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    saveToDiscord(client).catch(error => console.error('Discord backup save failed:', error.message));
  }, 1500);
}

module.exports = { restoreFromDiscord, saveToDiscord, scheduleDiscordBackup };
