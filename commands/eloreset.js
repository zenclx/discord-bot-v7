const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const {
  STARTING_ELO,
  getEloData,
  getTierForElo,
  syncRoles,
  updateEloLeaderboard,
} = require('./elo');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eloreset')
    .setDescription('Reset ELO data')
    .addSubcommand(sub =>
      sub
        .setName('all')
        .setDescription('Reset everyone to 0 ELO and clear win/loss records')
        .addBooleanOption(o =>
          o.setName('confirm')
            .setDescription('Confirm resetting everyone')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('player')
        .setDescription('Reset one player to 0 ELO')
        .addUserOption(o =>
          o.setName('user')
            .setDescription('Player to reset')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can reset ELO data.', flags: 64 });
    }

    const subcommand = interaction.options.getSubcommand();
    const data = db.get();
    const eloData = getEloData(data);

    if (subcommand === 'all') {
      if (!interaction.options.getBoolean('confirm')) {
        return interaction.reply({ content: 'Reset cancelled. Run `/eloreset all confirm:true` to confirm.', flags: 64 });
      }

      const resetCount = Object.keys(eloData).length;
      data.elo = {};
      db.set(data);
      await updateEloLeaderboard(interaction.client, interaction.guildId);
      return interaction.reply({
        content: `Reset ELO and win/loss records for **${resetCount}** players.`,
        flags: 64,
      });
    }

    const target = interaction.options.getUser('user');
    eloData[target.id] = {
      elo: STARTING_ELO,
      wins: 0,
      losses: 0,
      seasonElo: STARTING_ELO,
      seasonWins: 0,
      seasonLosses: 0,
      currentStreak: 0,
      bestStreak: 0,
      matchHistory: [],
    };
    db.set(data);
    await updateEloLeaderboard(interaction.client, interaction.guildId);

    try {
      const guild = await interaction.client.guilds.fetch(interaction.guildId);
      await syncRoles(guild, target.id, getTierForElo(STARTING_ELO));
    } catch {}

    return interaction.reply({
      content: `Reset <@${target.id}>'s ELO to \`0\` (Tier V).`,
      flags: 64,
    });
  },
};
