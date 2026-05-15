const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { canManageMatch, postOrUpdateBracket } = require('./creatematch');
const { updateEloLeaderboard } = require('./elo');

function findActiveMatch(data, guildId, channelId, matchId) {
  if (matchId) return data.matches?.[matchId] || null;
  return Object.values(data.matches || {})
    .filter(match => match.guildId === guildId && !['complete', 'cancelled'].includes(match.status))
    .filter(match => match.privateChannelId === channelId || match.channelId === channelId)
    .sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0))[0] || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matchundo')
    .setDescription('Undo the last winner pick for a match')
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'Staff only.', flags: 64 });
    }

    const data = db.get();
    const match = findActiveMatch(data, interaction.guildId, interaction.channelId, interaction.options.getString('matchid'));
    if (!match) return interaction.reply({ content: 'No active match found.', flags: 64 });

    const snapshot = data.matchUndoStack?.[match.id]?.shift();
    if (!snapshot) return interaction.reply({ content: 'No undo snapshot found for this match.', flags: 64 });

    data.matches[match.id] = snapshot.match;
    data.elo = snapshot.elo || {};
    db.set(data);
    await postOrUpdateBracket(interaction.client, snapshot.match);
    await updateEloLeaderboard(interaction.client, snapshot.match.guildId);

    return interaction.reply({ content: `Undid last result: ${snapshot.label}.`, flags: 64 });
  },
};
