const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { canManageMatch, postOrUpdateBracket, scheduleChannelDelete, DEFAULT_LOG_CHANNEL_ID, makeBracketAttachment } = require('./creatematch');
const { applyMatchStreaks, buildMatchEloSummary, getEloData } = require('./elo');

function findActiveMatch(data, guildId, channelId, matchId) {
  if (matchId) return data.matches?.[matchId] || null;
  return Object.values(data.matches || {})
    .filter(match => match.guildId === guildId && !['complete', 'cancelled'].includes(match.status))
    .filter(match => match.privateChannelId === channelId || match.channelId === channelId)
    .sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0))[0] || null;
}

async function sendFinalLog(client, match, championId) {
  const data = db.get();
  const logChannelId = data.settings?.[match.guildId]?.logChannelId || DEFAULT_LOG_CHANNEL_ID;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel) return;
  const eloSummary = buildMatchEloSummary(match, getEloData(data));
  const bracketAttachment = makeBracketAttachment(match);
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Match #${match.matchNum ?? '?'} Complete`)
        .setColor(0xffd700)
        .setDescription(`Champion: <@${championId}>`)
        .setImage('attachment://bracket.png')
        .addFields(
          { name: 'ELO Changes', value: eloSummary.slice(0, 1024), inline: false },
        )
        .setTimestamp(),
    ],
    files: [bracketAttachment],
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('endmatch')
    .setDescription('Manually end a match and choose the champion')
    .addUserOption(o => o.setName('winner').setDescription('Champion').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'Staff only.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const winner = interaction.options.getUser('winner');
    const data = db.get();
    const match = findActiveMatch(data, interaction.guildId, interaction.channelId, interaction.options.getString('matchid'));
    if (!match) return interaction.editReply({ content: 'No active match found.' });
    if (!match.queue?.includes(winner.id)) return interaction.editReply({ content: 'That winner is not in this match.' });

    match.status = 'complete';
    match.champion = winner.id;
    data.matches[match.id] = match;
    db.set(data);

    await applyMatchStreaks(interaction.client, match, winner.id);
    await postOrUpdateBracket(interaction.client, match);
    await sendFinalLog(interaction.client, match, winner.id);
    if (match.privateChannelId) scheduleChannelDelete(interaction.client, match.privateChannelId);

    return interaction.editReply({ content: `Match ended. Champion: <@${winner.id}>` });
  },
};
