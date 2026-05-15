const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { getEloData, getPlayerElo } = require('./elo');

function getSeasonState(data, guildId) {
  if (!data.eloSeasons) data.eloSeasons = {};
  if (!data.eloSeasons[guildId]) data.eloSeasons[guildId] = { current: 1, history: [] };
  return data.eloSeasons[guildId];
}

function sortedSeasonPlayers(eloData) {
  return Object.entries(eloData || {})
    .map(([userId, player]) => ({
      userId,
      seasonElo: player.seasonElo || 0,
      seasonWins: player.seasonWins || 0,
      seasonLosses: player.seasonLosses || 0,
    }))
    .sort((a, b) => b.seasonElo - a.seasonElo || b.seasonWins - a.seasonWins);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eloseason')
    .setDescription('Manage ELO leaderboard seasons')
    .addSubcommand(sub => sub.setName('info').setDescription('Show current ELO season'))
    .addSubcommand(sub => sub.setName('leaderboard').setDescription('Show current season leaderboard'))
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Archive current ELO season and start a new one')
        .addBooleanOption(o => o.setName('confirm').setDescription('Confirm starting a new season').setRequired(true))
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const data = db.get();
    const guildId = interaction.guildId;
    const season = getSeasonState(data, guildId);
    const eloData = getEloData(data);

    if (subcommand === 'info') {
      return interaction.reply({ content: `Current ELO season: **Season ${season.current}**` });
    }

    if (subcommand === 'leaderboard') {
      const sorted = sortedSeasonPlayers(eloData).slice(0, 20);
      const lines = sorted.length
        ? sorted.map((p, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} <@${p.userId}> - \`${p.seasonElo} Season ELO\` - ${p.seasonWins}W/${p.seasonLosses}L`)
        : ['No season ELO yet.'];
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`ELO Season ${season.current} Leaderboard`)
            .setColor(0x00bfff)
            .setDescription(lines.join('\n'))
            .setTimestamp(),
        ],
      });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can start a new ELO season.', flags: 64 });
    }
    if (!interaction.options.getBoolean('confirm')) {
      return interaction.reply({ content: 'Cancelled. Run `/eloseason start confirm:true` to start a new season.', flags: 64 });
    }

    const archived = sortedSeasonPlayers(eloData);
    season.history.push({
      season: season.current,
      archivedAt: Date.now(),
      standings: archived,
    });
    season.current += 1;

    for (const userId of Object.keys(eloData)) {
      const player = getPlayerElo(eloData, userId);
      player.seasonElo = 0;
      player.seasonWins = 0;
      player.seasonLosses = 0;
    }

    db.set(data);
    return interaction.reply({
      content: `Archived ELO Season ${season.current - 1} and started **Season ${season.current}**.`,
      flags: 64,
    });
  },
};
