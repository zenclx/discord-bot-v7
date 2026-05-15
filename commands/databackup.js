const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { restoreFromDiscord, saveToDiscord } = require('../discordBackup');

function getCounts() {
  const data = db.get();
  return {
    scoreboards: Object.keys(data.scoreboards || {}).length,
    eloPlayers: Object.keys(data.elo || {}).length,
    matches: Object.keys(data.matches || {}).length,
  };
}

function formatCounts(counts) {
  return `Scoreboards: **${counts.scoreboards}** | ELO players: **${counts.eloPlayers}** | Matches: **${counts.matches}**`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('databackup')
    .setDescription('Manage the Discord backup used to survive Render redeploys')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show what the bot currently has loaded')
    )
    .addSubcommand(sub =>
      sub.setName('save').setDescription('Force-save current bot data to the Discord backup channel')
    )
    .addSubcommand(sub =>
      sub
        .setName('restore')
        .setDescription('Restore bot data from the Discord backup channel')
        .addBooleanOption(o =>
          o.setName('confirm')
            .setDescription('Confirm restoring backup data over current memory')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can manage bot backups.', flags: 64 });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'status') {
      return interaction.reply({
        content: `Current loaded data - ${formatCounts(getCounts())}`,
        flags: 64,
      });
    }

    await interaction.deferReply({ flags: 64 });

    if (subcommand === 'save') {
      const ok = await saveToDiscord(interaction.client);
      return interaction.editReply({
        content: ok
          ? `Backup saved. ${formatCounts(getCounts())}`
          : 'Backup save failed. Give the bot Create Channel, View Channel, Send Messages, Read Message History, and Attach Files permissions, or set DATA_BACKUP_CHANNEL_ID to a text channel it can use.',
      });
    }

    if (!interaction.options.getBoolean('confirm')) {
      return interaction.editReply({ content: 'Restore cancelled. Run `/databackup restore confirm:true` to confirm.' });
    }

    const restored = await restoreFromDiscord(interaction.client);
    return interaction.editReply({
      content: restored
        ? `Backup restored. ${formatCounts(getCounts())}`
        : 'No backup was found to restore yet. Run `/databackup save` after creating or updating a scoreboard.',
    });
  },
};
