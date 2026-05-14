const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const { buildQueueEmbed, canManageMatch, getMinPlayers } = require('./creatematch');

function findCurrentQueue(data, interaction, requestedMatchId) {
  if (requestedMatchId) return data.matches?.[requestedMatchId] || null;

  return Object.values(data.matches || {})
    .filter(match =>
      match.guildId === interaction.guildId
      && match.channelId === interaction.channelId
      && match.status === 'queuing'
    )
    .sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0))[0] || null;
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
      return interaction.reply({ content: 'No open queue found. Use `matchid` if the queue is in another channel.', flags: 64 });
    }
    if (match.status !== 'queuing') {
      return interaction.reply({ content: 'That match has already started, so players can no longer be added.', flags: 64 });
    }
    if (match.queue.includes(player.id)) {
      return interaction.reply({ content: `<@${player.id}> is already in this queue.`, flags: 64 });
    }

    match.queue.push(player.id);
    data.matches[match.id] = match;
    db.set(data);
    await saveToDiscord(interaction.client);

    try {
      const channel = await interaction.client.channels.fetch(match.channelId);
      const message = await channel.messages.fetch(match.messageId);
      await message.edit({ embeds: [buildQueueEmbed(match)] });
    } catch (error) {
      console.error('addplayer queue message update failed:', error.message);
    }

    await interaction.reply({
      content: `Added <@${player.id}> to Match #${match.matchNum ?? '?'} (${match.queue.length}/${getMinPlayers(match)} players).`,
      flags: 64,
    });
  },
};
