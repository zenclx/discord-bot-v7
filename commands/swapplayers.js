const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const { canManageMatch, postOrUpdateBracket, postSeedPreview } = require('./creatematch');
const { sendStaffAuditLog } = require('../auditLog');

function findActiveMatch(data, interaction, requestedMatchId) {
  if (requestedMatchId) return data.matches?.[requestedMatchId] || null;
  const matches = Object.values(data.matches || {})
    .filter(m =>
      m.guildId === interaction.guildId
      && ['seeding', 'bracket'].includes(m.status)
      && ['2v2', '3v3'].includes(m.type)
    )
    .sort((a, b) => (b.checkInEndsAt || b.endsAt || 0) - (a.checkInEndsAt || a.endsAt || 0));
  return matches.find(m =>
    m.channelId === interaction.channelId || m.privateChannelId === interaction.channelId
  ) || matches[0] || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('swapplayers')
    .setDescription('Swap two players between teams in a 2v2 or 3v3 match')
    .addUserOption(o => o.setName('player1').setDescription('First player to swap').setRequired(true))
    .addUserOption(o => o.setName('player2').setDescription('Second player to swap').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID if multiple matches are active').setRequired(false)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'You do not have permission to swap players.', flags: 64 });
    }

    const player1 = interaction.options.getUser('player1');
    const player2 = interaction.options.getUser('player2');

    if (player1.id === player2.id) {
      return interaction.reply({ content: 'Both players must be different users.', flags: 64 });
    }

    const requestedMatchId = interaction.options.getString('matchid');
    const data = db.get();

    const match = findActiveMatch(data, interaction, requestedMatchId);
    if (!match) {
      return interaction.reply({ content: 'No active 2v2 match (bracket or seeding phase) found in this channel.', flags: 64 });
    }
    if (!match.teams?.length) {
      return interaction.reply({ content: 'Teams have not been assigned for this match yet.', flags: 64 });
    }

    const team1Index = match.teams.findIndex(t => t.includes(player1.id));
    const team2Index = match.teams.findIndex(t => t.includes(player2.id));

    if (team1Index === -1) {
      return interaction.reply({ content: `<@${player1.id}> is not assigned to a team in this match.`, flags: 64 });
    }
    if (team2Index === -1) {
      return interaction.reply({ content: `<@${player2.id}> is not assigned to a team in this match.`, flags: 64 });
    }
    if (team1Index === team2Index) {
      return interaction.reply({ content: 'Both players are already on the same team — no swap needed.', flags: 64 });
    }

    const team1Letter = String.fromCharCode(65 + team1Index);
    const team2Letter = String.fromCharCode(65 + team2Index);

    // Swap in match.teams
    const p1Pos = match.teams[team1Index].indexOf(player1.id);
    const p2Pos = match.teams[team2Index].indexOf(player2.id);
    match.teams[team1Index][p1Pos] = player2.id;
    match.teams[team2Index][p2Pos] = player1.id;

    // Swap in all bracket rounds (teamA/teamB and captain p1/p2)
    const swapIn = arr => arr?.map(id => id === player1.id ? player2.id : id === player2.id ? player1.id : id);
    for (const round of (match.bracket || [])) {
      for (const bm of round) {
        if (bm.teamA?.includes(player1.id) || bm.teamA?.includes(player2.id)) {
          bm.teamA = swapIn(bm.teamA);
          if (bm.p1 === player1.id) bm.p1 = player2.id;
          else if (bm.p1 === player2.id) bm.p1 = player1.id;
        }
        if (bm.teamB?.includes(player1.id) || bm.teamB?.includes(player2.id)) {
          bm.teamB = swapIn(bm.teamB);
          if (bm.p2 === player1.id) bm.p2 = player2.id;
          else if (bm.p2 === player2.id) bm.p2 = player1.id;
        }
      }
    }

    // Swap in preformedTeams if present
    if (match.preformedTeams) {
      match.preformedTeams = match.preformedTeams.map(pair => swapIn(pair));
    }

    data.matches[match.id] = match;
    db.set(data);

    interaction.reply({
      content: `✅ Swapped <@${player1.id}> (was Team ${team1Letter}) ↔ <@${player2.id}> (was Team ${team2Letter}).\n**Team ${team1Letter}:** ${match.teams[team1Index].map(id => `<@${id}>`).join(' & ')}\n**Team ${team2Letter}:** ${match.teams[team2Index].map(id => `<@${id}>`).join(' & ')}`,
      flags: 64,
    }).catch(() => {});

    sendStaffAuditLog(interaction.client, interaction.guildId, 'Team Swap', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Swap', value: `<@${player1.id}> (Team ${team1Letter}) ↔ <@${player2.id}> (Team ${team2Letter})`, inline: false },
      { name: `New Team ${team1Letter}`, value: match.teams[team1Index].map(id => `<@${id}>`).join(' & '), inline: true },
      { name: `New Team ${team2Letter}`, value: match.teams[team2Index].map(id => `<@${id}>`).join(' & '), inline: true },
    ], interaction.user.id).catch(() => {});

    (async () => {
      try {
        if (match.status === 'bracket') {
          await postOrUpdateBracket(interaction.client, match);
        } else if (match.status === 'seeding' && match.seedPreviewMessageId) {
          await postSeedPreview(interaction.client, match);
        }
      } catch (e) {
        console.error('swapplayers embed update failed:', e.message);
      }
    })();
  },
};
