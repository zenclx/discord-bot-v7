const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const { buildQueueEmbed, buildCheckInEmbed, makeCheckInRows, canManageMatch } = require('./creatematch');
const { sendStaffAuditLog } = require('../auditLog');

function findMutableMatch(data, interaction, requestedMatchId) {
  if (requestedMatchId) return data.matches?.[requestedMatchId] || null;
  const matches = Object.values(data.matches || {})
    .filter(match => match.guildId === interaction.guildId && ['queuing', 'checking'].includes(match.status))
    .sort((a, b) => (b.endsAt || b.checkInEndsAt || 0) - (a.endsAt || a.checkInEndsAt || 0));

  return matches.find(match =>
    match.channelId === interaction.channelId || match.privateChannelId === interaction.channelId
  ) || matches[0] || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subplayer')
    .setDescription('Substitute a player before the bracket starts')
    .addUserOption(o => o.setName('old').setDescription('Player to replace').setRequired(true))
    .addUserOption(o => o.setName('new').setDescription('Replacement player').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: 64 });

    const oldPlayer = interaction.options.getUser('old');
    const newPlayer = interaction.options.getUser('new');
    const data = db.get();
    const match = findMutableMatch(data, interaction, interaction.options.getString('matchid'));
    if (!match) return interaction.reply({ content: 'No mutable match found. Subs are only allowed during queue/check-in.', flags: 64 });
    if (!match.queue.includes(oldPlayer.id)) return interaction.reply({ content: `<@${oldPlayer.id}> is not in this match.`, flags: 64 });
    if (match.queue.includes(newPlayer.id)) return interaction.reply({ content: `<@${newPlayer.id}> is already in this match.`, flags: 64 });

    match.queue = match.queue.map(id => id === oldPlayer.id ? newPlayer.id : id);
    if (match.checkIns) {
      delete match.checkIns[oldPlayer.id];
      delete match.checkIns[newPlayer.id];
    }
    data.matches[match.id] = match;
    db.set(data);
    await saveToDiscord(interaction.client);
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'Player Substituted', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Out', value: `<@${oldPlayer.id}>`, inline: true },
      { name: 'In', value: `<@${newPlayer.id}>`, inline: true },
    ], interaction.user.id);

    try {
      if (match.status === 'checking') {
        const channel = await interaction.client.channels.fetch(match.privateChannelId || match.channelId);
        await channel.permissionOverwrites.delete(oldPlayer.id).catch(() => {});
        await channel.permissionOverwrites.edit(newPlayer.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        }).catch(() => {});
        const message = await channel.messages.fetch(match.checkInMessageId || match.messageId);
        await message.edit({ embeds: [buildCheckInEmbed(match)], components: makeCheckInRows(match.id) });
      } else {
        const channel = await interaction.client.channels.fetch(match.channelId);
        const message = await channel.messages.fetch(match.messageId);
        await message.edit({ embeds: [buildQueueEmbed(match)] });
      }
    } catch (error) {
      console.error('subplayer message update failed:', error.message);
    }

    return interaction.reply({ content: `Subbed <@${oldPlayer.id}> out for <@${newPlayer.id}>.`, flags: 64 });
  },
};
