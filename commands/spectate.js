const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const db = require('../database');

function getSpectatableMatches(data, guildId) {
  return Object.values(data.matches || {})
    .filter(match =>
      match.guildId === guildId
      && !['complete', 'cancelled'].includes(match.status)
      && match.privateChannelId
    )
    .sort((a, b) => (b.matchNum || 0) - (a.matchNum || 0))
    .slice(0, 25);
}

async function grantSpectatorAccess(interaction, matchId) {
  const data = db.get();
  const match = data.matches?.[matchId];

  if (!match) return interaction.reply({ content: 'Match not found.', flags: 64 });
  if (match.status === 'complete' || match.status === 'cancelled') {
    return interaction.reply({ content: 'That match is already over.', flags: 64 });
  }
  if (!match.privateChannelId) {
    return interaction.reply({ content: 'Match channel is not set up yet.', flags: 64 });
  }
  if ((match.queue || []).includes(interaction.user.id)) {
    return interaction.reply({ content: 'You are a participant in that match.', flags: 64 });
  }

  try {
    const ch = await interaction.client.channels.fetch(match.privateChannelId);
    await ch.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true,
    });
    return interaction.reply({ content: `You can now spectate <#${ch.id}>.`, flags: 64 });
  } catch (error) {
    console.error('spectate error:', error.message);
    return interaction.reply({ content: 'Failed to grant spectator access. Does the match channel still exist?', flags: 64 });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spectate')
    .setDescription('Get read-only access to watch a live match channel')
    .addStringOption(o =>
      o.setName('matchid').setDescription('Optional match ID').setRequired(false)
    ),

  getSpectatableMatches,
  grantSpectatorAccess,

  async execute(interaction) {
    const matchId = interaction.options.getString('matchid');
    if (matchId) return grantSpectatorAccess(interaction, matchId);

    const data = db.get();
    const matches = getSpectatableMatches(data, interaction.guildId);
    if (!matches.length) {
      return interaction.reply({ content: 'No live match channels are available to spectate right now.', flags: 64 });
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('spectate_select')
        .setPlaceholder('Choose a live match')
        .addOptions(matches.map(match => ({
          label: `Match #${match.matchNum ?? '?'} - ${String(match.type || 'match').toUpperCase()}`.slice(0, 100),
          description: `${match.status} - ${match.queue?.length || 0} players`.slice(0, 100),
          value: match.id,
        })))
    );

    return interaction.reply({
      content: 'Choose a match to spectate:',
      components: [row],
      flags: 64,
    });
  },
};
