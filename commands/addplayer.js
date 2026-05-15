const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const { buildQueueEmbed, canManageMatch, getMinPlayers } = require('./creatematch');
const { sendStaffAuditLog } = require('../auditLog');

function findCurrentQueue(data, interaction, requestedMatchId) {
  if (requestedMatchId) return data.matches?.[requestedMatchId] || null;

  const matches = Object.values(data.matches || {})
    .filter(match =>
      match.guildId === interaction.guildId
      && ['queuing', 'checking', 'bracket'].includes(match.status)
    )
    .sort((a, b) => (b.endsAt || b.checkInEndsAt || 0) - (a.endsAt || a.checkInEndsAt || 0));

  return matches.find(match =>
    match.channelId === interaction.channelId || match.privateChannelId === interaction.channelId
  ) || matches[0] || null;
}

function formatMutableMatches(data, guildId) {
  const matches = Object.values(data.matches || {})
    .filter(match => match.guildId === guildId && ['queuing', 'checking', 'bracket'].includes(match.status))
    .sort((a, b) => (b.checkInEndsAt || b.endsAt || 0) - (a.checkInEndsAt || a.endsAt || 0))
    .slice(0, 5);

  return matches.map(match => `#${match.matchNum ?? '?'} (${match.status}) - \`${match.id}\``).join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addplayer')
    .setDescription('Add a player to the current match queue')
    .addUserOption(o => o.setName('player').setDescription('Player to add').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID if multiple queues are open').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'You do not have permission to add players to matches.', flags: 64 });
    }

    const player = interaction.options.getUser('player');
    const requestedMatchId = interaction.options.getString('matchid');
    const data = db.get();
    if (!data.matches) data.matches = {};

    const match = findCurrentQueue(data, interaction, requestedMatchId);
    if (!match) {
      const available = formatMutableMatches(data, interaction.guildId);
      return interaction.reply({
        content: available
          ? `No open queue found in this channel. Active queue/check-in matches:\n${available}`
          : 'No active queue, check-in, or bracket match found.',
        flags: 64,
      });
    }
    if (!['queuing', 'checking', 'bracket'].includes(match.status)) {
      return interaction.reply({ content: 'That match is not active anymore.', flags: 64 });
    }
    if (match.queue.includes(player.id)) {
      return interaction.reply({ content: `<@${player.id}> is already in this queue.`, flags: 64 });
    }

    match.queue.push(player.id);
    if (match.status === 'checking') {
      if (!match.checkIns) match.checkIns = {};
      delete match.checkIns[player.id];
    }
    data.matches[match.id] = match;
    db.set(data);
    await saveToDiscord(interaction.client);
    await sendStaffAuditLog(interaction.client, interaction.guildId, match.status === 'checking' ? 'Late Join Added During Check-In' : 'Player Added To Queue', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Player', value: `<@${player.id}>`, inline: true },
      { name: 'Status', value: match.status, inline: true },
    ], interaction.user.id);

    try {
      const { buildCheckInEmbed, makeCheckInRows } = require('./creatematch');
      if (match.status === 'checking') {
        const channel = await interaction.client.channels.fetch(match.privateChannelId || match.channelId);
        await channel.permissionOverwrites.edit(player.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => {});
        const message = await channel.messages.fetch(match.checkInMessageId || match.messageId);
        await message.edit({ content: null, embeds: [buildCheckInEmbed(match)], components: makeCheckInRows(match.id) });
      } else if (match.status === 'bracket') {
        const channel = await interaction.client.channels.fetch(match.privateChannelId);
        await channel.permissionOverwrites.edit(player.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => {});
      } else {
        const channel = await interaction.client.channels.fetch(match.channelId);
        const message = await channel.messages.fetch(match.messageId);
        await message.edit({ embeds: [buildQueueEmbed(match)] });
      }
    } catch (error) {
      console.error('addplayer queue message update failed:', error.message);
    }

    await interaction.reply({
      content: match.status === 'bracket'
        ? `Added <@${player.id}> to Match #${match.matchNum ?? '?'} roster/channel. The current bracket was not changed.`
        : `Added <@${player.id}> to Match #${match.matchNum ?? '?'} (${match.queue.length}/${getMinPlayers(match)} players).`,
      flags: 64,
    });
  },
};
