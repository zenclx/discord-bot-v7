const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { getEventLogChannelId, DEFAULT_EVENT_LOG_CHANNEL_ID } = require('../eventPayouts');

const DEFAULT_MATCH_LOG_CHANNEL_ID = '1384695119243907132';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmatchlogs')
    .setDescription('Test whether both log channels are reachable and send a sample message to each')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const data = db.get();
    const matchLogId = data.settings?.[interaction.guildId]?.logChannelId || DEFAULT_MATCH_LOG_CHANNEL_ID;
    const hostLogId = getEventLogChannelId(data, interaction.guildId);

    const results = [];

    // Test match log channel
    try {
      const ch = await interaction.client.channels.fetch(matchLogId);
      const testEmbed = new EmbedBuilder()
        .setTitle('Match #? Complete (TEST)')
        .setColor(0xffd700)
        .setDescription('Champion: (test user)')
        .addFields(
          { name: 'Host', value: `${interaction.user.username} (<@${interaction.user.id}>)`, inline: true },
          { name: 'ELO Changes', value: 'test', inline: false },
        )
        .setTimestamp();
      await ch.send({ embeds: [testEmbed], allowedMentions: { parse: [] } });
      results.push(`✅ **Match log** (<#${matchLogId}>): sent successfully`);
    } catch (e) {
      results.push(`❌ **Match log** (\`${matchLogId}\`): ${e.message}`);
    }

    // Test host log channel
    try {
      const ch = await interaction.client.channels.fetch(hostLogId);
      const testEmbed = new EmbedBuilder()
        .setTitle('Event Host Logged (TEST)')
        .setColor(0x1f4fd8)
        .addFields(
          { name: 'Host', value: `${interaction.user.username} (<@${interaction.user.id}>)`, inline: true },
          { name: 'Prize', value: 'test prize', inline: true },
          { name: 'Attendees', value: '5', inline: true },
          { name: 'Total Hosted', value: '1', inline: true },
        )
        .setTimestamp();
      await ch.send({ embeds: [testEmbed], allowedMentions: { parse: [] } });
      results.push(`✅ **Host log** (<#${hostLogId}>): sent successfully`);
    } catch (e) {
      results.push(`❌ **Host log** (\`${hostLogId}\`): ${e.message}`);
    }

    await interaction.editReply({ content: results.join('\n') });
  },
};
