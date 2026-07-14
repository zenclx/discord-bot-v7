const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { buildQueueEmbed, canManageMatch, getMinPlayers } = require('./creatematch');
const { sendStaffAuditLog } = require('../auditLog');

function findCurrentQueue(data, interaction, requestedMatchId) {
  if (requestedMatchId) return data.matches?.[requestedMatchId] || null;

  const matches = Object.values(data.matches || {})
    .filter(match =>
      match.guildId === interaction.guildId
      && ['queuing', 'checking'].includes(match.status)
    )
    .sort((a, b) => (b.endsAt || b.checkInEndsAt || 0) - (a.endsAt || a.checkInEndsAt || 0));

  return matches.find(match =>
    match.channelId === interaction.channelId || match.privateChannelId === interaction.channelId
  ) || matches[0] || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addteam')
    .setDescription('Add a pre-formed team to the current match queue')
    .addUserOption(o => o.setName('player1').setDescription('First teammate').setRequired(true))
    .addUserOption(o => o.setName('player2').setDescription('Second teammate').setRequired(true))
    .addUserOption(o => o.setName('player3').setDescription('Third teammate (3v3 only)').setRequired(false))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID if multiple queues are open').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'You do not have permission to add teams to matches.', flags: 64 });
    }

    const player1 = interaction.options.getUser('player1');
    const player2 = interaction.options.getUser('player2');
    const player3 = interaction.options.getUser('player3') || null;

    const playerIds = [player1.id, player2.id, ...(player3 ? [player3.id] : [])];
    if (new Set(playerIds).size !== playerIds.length) {
      return interaction.reply({ content: 'All players must be different users.', flags: 64 });
    }

    const requestedMatchId = interaction.options.getString('matchid');
    const data = db.get();
    if (!data.matches) data.matches = {};

    const match = findCurrentQueue(data, interaction, requestedMatchId);
    if (!match) {
      return interaction.reply({ content: 'No open queue found in this channel.', flags: 64 });
    }

    if (!['2v2', '3v3'].includes(match.type)) {
      return interaction.reply({ content: `This match is **${match.type.toUpperCase()}**. \`/addteam\` is only for 2v2 or 3v3 matches.`, flags: 64 });
    }

    if (match.type === '3v3' && !player3) {
      return interaction.reply({ content: '3v3 matches require a third player. Use `/addteam player1 player2 player3`.', flags: 64 });
    }

    if (!['queuing', 'checking'].includes(match.status)) {
      return interaction.reply({ content: 'That match is not in queue or check-in phase.', flags: 64 });
    }

    const players = player3 ? [player1, player2, player3] : [player1, player2];
    const added = [];
    for (const player of players) {
      if (!match.queue.includes(player.id)) {
        match.queue.push(player.id);
        added.push(player.id);
      }
      if (match.status === 'checking') {
        if (!match.checkIns) match.checkIns = {};
        delete match.checkIns[player.id];
      }
    }

    if (!match.preformedTeams) match.preformedTeams = [];

    // Remove any player from existing pre-formed teams before adding the new one
    match.preformedTeams = match.preformedTeams.filter(
      pair => !pair.some(id => playerIds.includes(id))
    );
    match.preformedTeams.push(playerIds);

    data.matches[match.id] = match;
    db.set(data);

    const teamDisplay = players.map(p => `<@${p.id}>`).join(' & ');
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'Pre-Formed Team Added', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Team', value: teamDisplay, inline: true },
      { name: 'Newly Added', value: added.length ? added.map(id => `<@${id}>`).join(' & ') : 'All already in queue', inline: true },
    ], interaction.user.id);

    try {
      const { buildCheckInEmbed, makeCheckInRows } = require('./creatematch');
      if (match.status === 'checking') {
        const channel = await interaction.client.channels.fetch(match.privateChannelId || match.channelId);
        for (const player of players) {
          await channel.permissionOverwrites.edit(player.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          }).catch(() => {});
        }
        const message = await channel.messages.fetch(match.checkInMessageId || match.messageId);
        await message.edit({ content: null, embeds: [buildCheckInEmbed(match)], components: makeCheckInRows(match.id) });
      } else {
        const channel = await interaction.client.channels.fetch(match.channelId);
        const message = await channel.messages.fetch(match.messageId);
        await message.edit({ embeds: [buildQueueEmbed(match)] });
      }
    } catch (error) {
      console.error('addteam queue message update failed:', error.message);
    }

    const totalTeams = match.preformedTeams.length;
    const totalPlayers = match.queue.length;
    const addedNote = added.length ? ` (added ${added.map(id => `<@${id}>`).join(' & ')} to queue)` : '';
    return interaction.reply({
      content: `Pre-formed team set: ${teamDisplay}${addedNote}.\nMatch #${match.matchNum ?? '?'} — ${totalPlayers}/${getMinPlayers(match)} players, ${totalTeams} pre-formed team${totalTeams !== 1 ? 's' : ''}.`,
      flags: 64,
    });
  },
};
