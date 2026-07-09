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
    .setDescription('Add a pre-formed 2v2 team to the current match queue')
    .addUserOption(o => o.setName('player1').setDescription('First teammate').setRequired(true))
    .addUserOption(o => o.setName('player2').setDescription('Second teammate').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID if multiple queues are open').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'You do not have permission to add teams to matches.', flags: 64 });
    }

    const player1 = interaction.options.getUser('player1');
    const player2 = interaction.options.getUser('player2');

    if (player1.id === player2.id) {
      return interaction.reply({ content: 'Both players must be different users.', flags: 64 });
    }

    const requestedMatchId = interaction.options.getString('matchid');
    const data = db.get();
    if (!data.matches) data.matches = {};

    const match = findCurrentQueue(data, interaction, requestedMatchId);
    if (!match) {
      return interaction.reply({ content: 'No open queue found in this channel.', flags: 64 });
    }

    if (match.type !== '2v2') {
      return interaction.reply({ content: `This match is **${match.type.toUpperCase()}**. \`/addteam\` is only for 2v2 matches.`, flags: 64 });
    }

    if (!['queuing', 'checking'].includes(match.status)) {
      return interaction.reply({ content: 'That match is not in queue or check-in phase.', flags: 64 });
    }

    const added = [];
    for (const player of [player1, player2]) {
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

    // Remove either player from any existing pre-formed pair before adding the new one
    match.preformedTeams = match.preformedTeams.filter(
      pair => !pair.includes(player1.id) && !pair.includes(player2.id)
    );
    match.preformedTeams.push([player1.id, player2.id]);

    data.matches[match.id] = match;
    db.set(data);
    await saveToDiscord(interaction.client);

    await sendStaffAuditLog(interaction.client, interaction.guildId, 'Pre-Formed Team Added', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Team', value: `<@${player1.id}> & <@${player2.id}>`, inline: true },
      { name: 'Newly Added', value: added.length ? added.map(id => `<@${id}>`).join(' & ') : 'Both already in queue', inline: true },
    ], interaction.user.id);

    try {
      const { buildCheckInEmbed, makeCheckInRows } = require('./creatematch');
      if (match.status === 'checking') {
        const channel = await interaction.client.channels.fetch(match.privateChannelId || match.channelId);
        for (const player of [player1, player2]) {
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
      content: `Pre-formed team set: <@${player1.id}> & <@${player2.id}>${addedNote}.\nMatch #${match.matchNum ?? '?'} — ${totalPlayers}/${getMinPlayers(match)} players, ${totalTeams} pre-formed team${totalTeams !== 1 ? 's' : ''}.`,
      flags: 64,
    });
  },
};
