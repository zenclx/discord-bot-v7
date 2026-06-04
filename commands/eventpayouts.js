const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { hasPayoutPermission, normalizeMonth, sendMonthlyPayoutReport } = require('../eventPayouts');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eventpayouts')
    .setDescription('Generate monthly event host payout report and Roblox payout CSV')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o
      .setName('month')
      .setDescription('Month to export in YYYY-MM format')
      .setRequired(true)),

  async execute(interaction) {
    if (!hasPayoutPermission(interaction)) {
      return interaction.reply({ content: 'Only admins or configured payout staff can generate payout CSVs.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });
    try {
      const month = normalizeMonth(interaction.options.getString('month'));
      const result = await sendMonthlyPayoutReport(interaction.client, interaction.guildId, month);
      await interaction.editReply(`Generated \`${result.filename}\` in <#${result.channelId}> with **${result.rows.length}** host rows.`);
    } catch (error) {
      await interaction.editReply(`Could not generate event payouts: ${error.message}`);
    }
  },
};
