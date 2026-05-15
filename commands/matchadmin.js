const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const db = require('../database');
const { canManageMatch } = require('./creatematch');

function findActiveMatch(data, guildId, channelId, matchId) {
  if (matchId) return data.matches?.[matchId] || null;
  const matches = Object.values(data.matches || {})
    .filter(match => match.guildId === guildId && !['complete', 'cancelled'].includes(match.status))
    .filter(match => match.privateChannelId === channelId || match.channelId === channelId)
    .sort((a, b) => (b.endsAt || 0) - (a.endsAt || 0));
  return matches[0] || null;
}

function getPlayerLabel(bracketMatch, side) {
  if (side === 'p1') return bracketMatch.teamLabel1 || bracketMatch.p1Tag || 'Left side';
  return bracketMatch.teamLabel2 || bracketMatch.p2Tag || 'Right side';
}

function buildPanel(match) {
  const embed = new EmbedBuilder()
    .setTitle(`Match Admin - #${match.matchNum ?? '?'}`)
    .setColor(0x2b6cb0)
    .addFields(
      { name: 'Status', value: match.status, inline: true },
      { name: 'Type', value: match.type.toUpperCase(), inline: true },
      { name: 'Players', value: `${match.queue?.length || 0}`, inline: true },
      { name: 'Match ID', value: `\`${match.id}\``, inline: false },
    )
    .setTimestamp();

  if (match.status === 'queuing' || match.status === 'checking') {
    embed.addFields({ name: 'Queue', value: (match.queue || []).map(id => `<@${id}>`).join('\n') || 'No players queued.', inline: false });
    if (match.status === 'checking') {
      const checked = Object.keys(match.checkIns || {});
      const missing = (match.queue || []).filter(id => !match.checkIns?.[id]);
      embed.addFields(
        { name: 'Checked In', value: checked.length ? checked.map(id => `<@${id}>`).join('\n') : 'None yet.', inline: true },
        { name: 'Missing Check-In', value: missing.length ? missing.map(id => `<@${id}>`).join('\n') : 'Everyone checked in.', inline: true },
      );
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`addminute_${match.id}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`forcestart_${match.id}`).setLabel('Force Start').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cancel_queue_${match.id}`).setLabel('Cancel Queue').setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
  }

  const pending = match.bracket?.[match.currentRound]?.filter(m => !m.winner && !m.bye) || [];
  const currentRound = match.bracket?.[match.currentRound] || [];
  embed.addFields({
    name: 'Pending Matches',
    value: pending.length
      ? pending.map((m, i) => `**${i + 1}.** ${m.teamLabel1 || m.p1Tag || `<@${m.p1}>`} vs ${m.teamLabel2 || m.p2Tag || `<@${m.p2}>`}`).join('\n')
      : 'No pending matches.',
    inline: false,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`resend_bracket_${match.id}`).setLabel('Resend Bracket').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`undo_match_${match.id}`).setLabel('Undo Last').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cancel_match_${match.id}`).setLabel('Cancel Match').setStyle(ButtonStyle.Danger),
  );

  const pendingOptions = currentRound
    .map((bracketMatch, matchIndex) => ({ bracketMatch, matchIndex }))
    .filter(({ bracketMatch }) => !bracketMatch.winner && !bracketMatch.bye)
    .slice(0, 25)
    .map(({ bracketMatch, matchIndex }) => {
      const p1Label = getPlayerLabel(bracketMatch, 'p1');
      const p2Label = getPlayerLabel(bracketMatch, 'p2');
      return {
        label: `M${matchIndex + 1}: ${p1Label} vs ${p2Label}`.slice(0, 100),
        description: `Round ${match.currentRound + 1}`.slice(0, 100),
        value: `${match.currentRound}|${matchIndex}`,
      };
    });

  const components = [];
  if (pendingOptions.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`admin_select_match_${match.id}`)
          .setPlaceholder('Choose pending bracket match')
          .addOptions(pendingOptions)
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`admin_select_action_${match.id}`)
          .setPlaceholder('Choose admin action')
          .addOptions(
            { label: 'No-show left side', value: 'noshow_p1' },
            { label: 'No-show right side', value: 'noshow_p2' },
            { label: 'DQ left side', value: 'dq_p1' },
            { label: 'DQ right side', value: 'dq_p2' },
          )
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`admin_apply_${match.id}`)
          .setLabel('Apply Selected Action')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  return { embeds: [embed], components: [...components, row] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matchadmin')
    .setDescription('Open the admin panel for the current match')
    .setDMPermission(false)
    .addStringOption(o =>
      o.setName('matchid')
        .setDescription('Optional match ID')
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'Staff only.', flags: 64 });
    }

    const data = db.get();
    const match = findActiveMatch(data, interaction.guildId, interaction.channelId, interaction.options.getString('matchid'));
    if (!match) {
      return interaction.reply({ content: 'No active match found in this channel.', flags: 64 });
    }

    return interaction.reply({ ...buildPanel(match), flags: 64 });
  },
};
