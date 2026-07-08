const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hostmatchlogschannel')
    .setDescription('Set the channel where host event logs are sent')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName('channel').setDescription('Channel for host event logs').setRequired(true)
    ),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');
    const data = db.get();
    if (!data.settings) data.settings = {};
    if (!data.settings[interaction.guildId]) data.settings[interaction.guildId] = {};
    data.settings[interaction.guildId].eventLogChannelId = channel.id;
    db.set(data);
    await saveToDiscord(interaction.client);
    await interaction.reply({
      content: `✅ Host event logs will now be sent to <#${channel.id}>`,
      flags: 64,
    });
  },
};
