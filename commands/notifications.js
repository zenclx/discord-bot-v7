const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');

function getUserNotificationSettings(data, guildId, userId) {
  if (!data.userSettings) data.userSettings = {};
  if (!data.userSettings[guildId]) data.userSettings[guildId] = {};
  if (!data.userSettings[guildId][userId]) data.userSettings[guildId][userId] = {};
  return data.userSettings[guildId][userId];
}

function notificationsDisabled(data, guildId, userId) {
  return Boolean(data.userSettings?.[guildId]?.[userId]?.botNotificationsDisabled);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('Turn VP Bot match notifications on or off')
    .addStringOption(o => o
      .setName('setting')
      .setDescription('Notification preference')
      .setRequired(true)
      .addChoices(
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' },
      )),

  async execute(interaction) {
    const setting = interaction.options.getString('setting');
    const data = db.get();
    const settings = getUserNotificationSettings(data, interaction.guildId, interaction.user.id);
    settings.botNotificationsDisabled = setting === 'off';
    db.set(data);

    return interaction.reply({
      content: setting === 'off'
        ? 'Bot match notifications are now off for you.'
        : 'Bot match notifications are now on for you.',
      flags: 64,
    });
  },

  getUserNotificationSettings,
  notificationsDisabled,
};
