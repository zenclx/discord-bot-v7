const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getEloData, getPlayerElo } = require('./elo');

function formatDelta(delta) {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matchhistory')
    .setDescription('Show recent ELO match history for a player')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('Player to look up')
        .setRequired(true)
    ),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const data = db.get();
    const player = getPlayerElo(getEloData(data), target.id);
    const history = (player.matchHistory || []).slice(0, 10);

    if (!history.length) {
      return interaction.reply({ content: `<@${target.id}> has no match history yet.`, flags: 64 });
    }

    const lines = history.map((entry, index) => {
      const result = entry.type === 'win' ? 'W' : 'L';
      const matchLabel = entry.matchNum !== null && entry.matchNum !== undefined ? `#${entry.matchNum}` : entry.matchId;
      const opponent = entry.opponent ? ` vs <@${entry.opponent}>` : '';
      return `**${index + 1}. ${result}** Match ${matchLabel}${opponent} - ${formatDelta(entry.delta)} ELO -> **${entry.elo}**`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${target.username}'s Match History`)
      .setColor(0x00bfff)
      .setDescription(lines.join('\n'))
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
