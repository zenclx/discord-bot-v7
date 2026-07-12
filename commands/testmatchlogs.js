const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { getEventLogChannelId } = require('../eventPayouts');
const { buildBracketImage } = require('../bracketImage');

const DEFAULT_MATCH_LOG_CHANNEL_ID = '1525726931008360489';

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

    // Test match log channel (with bracket image)
    try {
      const ch = await interaction.client.channels.fetch(matchLogId);
      const fakeBracket = [[{ p1: 'Player1', p2: 'Player2', p1Tag: 'Player1 (1200)', p2Tag: 'Player2 (1100)', winner: 'Player1', bye: false }]];
      let bracketAttachment = null;
      try {
        const buf = buildBracketImage(fakeBracket, 0, null);
        bracketAttachment = new AttachmentBuilder(buf, { name: 'bracket.png' });
      } catch (imgErr) {
        results.push(`⚠️ Bracket image generation failed: ${imgErr.message}`);
      }
      const testEmbed = new EmbedBuilder()
        .setTitle('Match #? Complete (TEST)')
        .setColor(0xffd700)
        .setDescription('Champion: (test user)')
        .addFields(
          { name: 'Host', value: `${interaction.user.username} (<@${interaction.user.id}>)`, inline: true },
          { name: 'ELO Changes', value: 'test', inline: false },
        )
        .setTimestamp();
      if (bracketAttachment) testEmbed.setImage('attachment://bracket.png');
      await ch.send({ embeds: [testEmbed], files: bracketAttachment ? [bracketAttachment] : [], allowedMentions: { parse: [] } });
      results.push(`✅ **Match log** (<#${matchLogId}>): sent successfully${bracketAttachment ? ' (with bracket image)' : ' (no bracket image)'}`);
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
