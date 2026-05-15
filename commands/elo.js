const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { sendStaffAuditLog } = require('../auditLog');
const { saveToDiscord } = require('../discordBackup');

const TIER_ROLES = {
  I: '1394141603962163373',
  II: '1394141793142046750',
  III: '1394142018044690602',
  IV: '1394142109463740446',
  V: '1394142206218080265',
};

const TIERS = [
  { tier: 'I', emoji: 'Crown', min: 1800, roleId: TIER_ROLES.I },
  { tier: 'II', emoji: 'Diamond', min: 1200, roleId: TIER_ROLES.II },
  { tier: 'III', emoji: 'Arcane', min: 650, roleId: TIER_ROLES.III },
  { tier: 'IV', emoji: 'Spark', min: 270, roleId: TIER_ROLES.IV },
  { tier: 'V', emoji: 'Shield', min: 0, roleId: TIER_ROLES.V },
];

const STARTING_ELO = 0;
const LOSS_PENALTY = 25;
const DEFAULT_LOG_CHANNEL_ID = '1384695119243907132';

function getWinElo(roundIndex, isFinalRound) {
  if (isFinalRound) return 75;
  if (roundIndex === 0) return 15;
  if (roundIndex === 1) return 25;
  if (roundIndex === 2) return 40;
  return 50;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getEloAdjustment(winnerElo, loserElo) {
  const diff = (loserElo || 0) - (winnerElo || 0);
  return clamp(Math.round(diff / 120), -8, 18);
}

function getLossAdjustment(winnerElo, loserElo) {
  const diff = (loserElo || 0) - (winnerElo || 0);
  return clamp(Math.round(diff / 160), -8, 15);
}

function getStreakBounty(loserStreak) {
  if ((loserStreak || 0) < 5) return 0;
  return clamp(5 + Math.floor(((loserStreak || 0) - 5) / 2) * 2, 5, 15);
}

function calculateMatchEloDelta(winner, loser, roundIndex, isFinal) {
  const baseGain = getWinElo(roundIndex, isFinal);
  const winnerElo = winner?.elo || STARTING_ELO;
  const loserElo = loser?.elo || STARTING_ELO;
  const eloAdjustment = loser ? getEloAdjustment(winnerElo, loserElo) : 0;
  const streakBounty = loser ? getStreakBounty(loser.currentStreak || 0) : 0;
  const gain = Math.max(5, baseGain + eloAdjustment + streakBounty);
  const loss = loser ? Math.max(10, LOSS_PENALTY + getLossAdjustment(winnerElo, loserElo)) : 0;

  return { baseGain, eloAdjustment, streakBounty, gain, loss };
}

function getTierForElo(elo) {
  return TIERS.find(t => elo >= t.min) || TIERS[TIERS.length - 1];
}

function getEloData(data) {
  if (!data.elo) data.elo = {};
  return data.elo;
}

function getPlayerElo(eloData, userId) {
  if (!eloData[userId]) {
    eloData[userId] = {
      elo: STARTING_ELO,
      wins: 0,
      losses: 0,
      seasonElo: STARTING_ELO,
      seasonWins: 0,
      seasonLosses: 0,
      currentStreak: 0,
      bestStreak: 0,
      matchHistory: [],
    };
  }
  return eloData[userId];
}

function applyEloChange(eloData, userId, delta) {
  const player = getPlayerElo(eloData, userId);
  const oldElo = player.elo;
  const oldTier = getTierForElo(oldElo);
  player.elo = Math.max(0, oldElo + delta);
  const newTier = getTierForElo(player.elo);
  return { oldElo, newElo: player.elo, oldTier, newTier, tierChanged: oldTier.tier !== newTier.tier };
}

async function syncRoles(guild, userId, newTier) {
  try {
    const member = await guild.members.fetch(userId);
    const allRoleIds = Object.values(TIER_ROLES);
    const toRemove = member.roles.cache.filter(r => allRoleIds.includes(r.id));
    if (toRemove.size) await member.roles.remove(toRemove);
    await member.roles.add(newTier.roleId);
  } catch (e) {
    console.error(`Failed to sync ELO role for ${userId}:`, e.message);
  }
}

async function applyMatchElo(client, match, winnerId, loserId, roundIndex, isFinal) {
  try {
    const data = db.get();
    const eloData = getEloData(data);
    const winner = getPlayerElo(eloData, winnerId);
    const loser = loserId ? getPlayerElo(eloData, loserId) : null;
    const delta = calculateMatchEloDelta(winner, loser, roundIndex, isFinal);
    const gainAmount = delta.gain;

    const winResult = applyEloChange(eloData, winnerId, gainAmount);
    winner.wins = (winner.wins || 0) + 1;
    winner.seasonElo = Math.max(0, (winner.seasonElo || 0) + gainAmount);
    winner.seasonWins = (winner.seasonWins || 0) + 1;
    winner.matchHistory = [
      { matchId: match.id, matchNum: match.matchNum ?? null, type: 'win', delta: gainAmount, elo: winResult.newElo, round: roundIndex, opponent: loserId || null, streakBounty: delta.streakBounty, ts: Date.now() },
      ...(winner.matchHistory || []),
    ].slice(0, 50);

    let lossResult = null;
    if (loserId) {
      lossResult = applyEloChange(eloData, loserId, -delta.loss);
      loser.losses = (loser.losses || 0) + 1;
      loser.seasonElo = Math.max(0, (loser.seasonElo || 0) - delta.loss);
      loser.seasonLosses = (loser.seasonLosses || 0) + 1;
      loser.matchHistory = [
        { matchId: match.id, matchNum: match.matchNum ?? null, type: 'loss', delta: -delta.loss, elo: lossResult.newElo, round: roundIndex, opponent: winnerId, ts: Date.now() },
        ...(loser.matchHistory || []),
      ].slice(0, 50);
    }

    if (!match.eloEvents) match.eloEvents = [];
    match.eloEvents.push({
      ts: Date.now(), winnerId, loserId: loserId || null, round: roundIndex,
      gain: gainAmount, loss: delta.loss, baseGain: delta.baseGain,
      eloAdjustment: delta.eloAdjustment, streakBounty: delta.streakBounty,
    });
    if (data.matches?.[match.id]) data.matches[match.id] = match;

    db.set(data);
    await saveToDiscord(client);
    await updateEloLeaderboard(client, match.guildId);

    try {
      const guild = await client.guilds.fetch(match.guildId);
      await syncRoles(guild, winnerId, getTierForElo(winResult.newElo));
      if (loserId && lossResult) await syncRoles(guild, loserId, getTierForElo(lossResult.newElo));
    } catch {}
    return { winner: winResult, loser: lossResult, ...delta };
  } catch (e) {
    console.error('applyMatchElo error:', e.message);
    return null;
  }
}

async function applyMatchStreaks(client, match, championId) {
  try {
    const data = db.get();
    const eloData = getEloData(data);
    const players = [...new Set(match.queue || [])];

    for (const playerId of players) {
      const player = getPlayerElo(eloData, playerId);
      if (playerId === championId) {
        player.currentStreak = Math.max(0, player.currentStreak || 0) + 1;
        player.bestStreak = Math.max(player.bestStreak || 0, player.currentStreak);
        if (
          player.currentStreak >= 3
          && (player.currentStreak === 3 || player.currentStreak === 5 || player.currentStreak % 5 === 0)
          && player.lastStreakCallout !== player.currentStreak
        ) {
          player.pendingStreakCallout = player.currentStreak;
          player.lastStreakCallout = player.currentStreak;
        }
      } else {
        player.currentStreak = 0;
        player.bestStreak = Math.max(player.bestStreak || 0, 0);
      }
    }

    db.set(data);
    await saveToDiscord(client);
    await updateEloLeaderboard(client, match.guildId);

    const champion = getPlayerElo(getEloData(db.get()), championId);
    if (champion.pendingStreakCallout) {
      const fresh = db.get();
      const freshChampion = getPlayerElo(getEloData(fresh), championId);
      const streak = freshChampion.pendingStreakCallout;
      delete freshChampion.pendingStreakCallout;
      db.set(fresh);
      await saveToDiscord(client);

      const logChannelId = fresh.settings?.[match.guildId]?.logChannelId || DEFAULT_LOG_CHANNEL_ID;
      const channel = await client.channels.fetch(logChannelId).catch(() => null);
      if (channel) {
        await channel.send(`🔥 <@${championId}> is on a **${streak} match win streak**.`);
      }
    }
  } catch (e) {
    console.error('applyMatchStreaks error:', e.message);
  }
}

function buildProgressBar(elo, tier, nextTier) {
  const barLen = 14;
  if (!nextTier) return '▰'.repeat(barLen) + ' Max';
  const range = Math.max(1, nextTier.min - tier.min);
  const progress = Math.max(0, elo - tier.min);
  const filled = Math.min(barLen, Math.max(0, Math.round((progress / range) * barLen)));
  return '▰'.repeat(filled) + '▱'.repeat(barLen - filled) + ` ${progress}/${range}`;
}

function tierColor(tier) {
  return { I: 0xffd700, II: 0x00bfff, III: 0xab47bc, IV: 0x78909c, V: 0x546e7a }[tier] || 0x7289da;
}

function getTierProgress(player, tier, nextTier) {
  if (!nextTier) {
    return { percentage: 100, remaining: 0, progress: 1 };
  }

  const range = Math.max(1, nextTier.min - tier.min);
  const earned = Math.min(range, Math.max(0, (player.elo || 0) - tier.min));
  const progress = earned / range;
  const percentage = Math.round(progress * 1000) / 10;
  const remaining = Math.max(0, nextTier.min - (player.elo || 0));
  return { percentage, remaining, progress };
}

function buildRankBar(progress) {
  const segments = 10;
  const filled = Math.min(segments, Math.max(0, Math.round(progress * segments)));
  return `${'✅'.repeat(filled)}${'⬛'.repeat(segments - filled)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function buildEloProfileEmbed(target, player, displayName) {
  const tier = getTierForElo(player.elo || 0);
  const nextTier = TIERS[TIERS.indexOf(tier) - 1] || null;
  const progress = getTierProgress(player, tier, nextTier);
  const currentRank = `Tier ${tier.tier} | ${formatNumber(tier.min)}+ ELO`;
  const nextRank = nextTier ? `Tier ${nextTier.tier} | ${formatNumber(nextTier.min)}+ ELO` : 'Max Rank';
  const remainingLine = nextTier
    ? `**${formatNumber(progress.remaining)} ELO remaining for ${nextRank}**`
    : '**Max rank reached**';

  return new EmbedBuilder()
    .setColor(tierColor(tier.tier))
    .setDescription([
      `**${displayName}**`,
      `${buildRankBar(progress.progress)} **${progress.percentage}%**`,
      `Rank: **${currentRank}**`,
      `ELO: **${formatNumber(player.elo)}**`,
      `Record: **${player.wins || 0}W / ${player.losses || 0}L**`,
      `Streak: **${player.currentStreak || 0}** current / **${player.bestStreak || 0}** best`,
      '',
      remainingLine,
    ].join('\n'))
    .setThumbnail(target.displayAvatarURL({ size: 128 }))
    .setTimestamp();
}

function buildMatchEloSummary(match, eloData) {
  const startElo = match.eloStart || {};
  const players = (match.queue || []).map(userId => {
    const player = eloData[userId] || { elo: STARTING_ELO, wins: 0, losses: 0 };
    const starting = startElo[userId] ?? STARTING_ELO;
    const current = player.elo ?? STARTING_ELO;
    return {
      userId,
      starting,
      current,
      delta: current - starting,
      wins: player.wins || 0,
      losses: player.losses || 0,
    };
  });

  players.sort((a, b) => b.delta - a.delta || b.current - a.current);

  return players.map((p, i) => {
    const sign = p.delta >= 0 ? '+' : '';
    return `**${i + 1}.** <@${p.userId}> - ${sign}${p.delta} ELO (${p.starting} -> ${p.current}) - ${p.wins}W/${p.losses}L`;
  }).join('\n') || 'No ELO changes recorded.';
}

function buildEloLeaderboardEmbed(eloData) {
  const sorted = Object.entries(eloData || {})
    .map(([userId, p]) => ({ userId, elo: p.elo || 0, wins: p.wins || 0, losses: p.losses || 0, currentStreak: p.currentStreak || 0 }))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
    .slice(0, 20);

  const description = sorted.length
    ? sorted.map((p, i) => {
      const tier = getTierForElo(p.elo);
      const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
      const streak = p.currentStreak > 0 ? ` - ${p.currentStreak}W streak` : '';
      return `${medal} <@${p.userId}> - \`${p.elo} ELO\` - Tier ${tier.tier} - ${p.wins}W/${p.losses}L${streak}`;
    }).join('\n')
    : 'No ELO data yet. Play some matches!';

  return new EmbedBuilder()
    .setTitle('ELO Leaderboard')
    .setColor(0xffd700)
    .setDescription(description)
    .setFooter({ text: 'Auto-updates after ELO changes | Everyone starts at Tier V' })
    .setTimestamp();
}

async function updateEloLeaderboard(client, guildId) {
  try {
    const data = db.get();
    const board = data.eloLeaderboards?.[guildId];
    if (!board) return;
    const channel = await client.channels.fetch(board.channelId);
    const message = await channel.messages.fetch(board.messageId);
    await message.edit({ embeds: [buildEloLeaderboardEmbed(getEloData(data))] });
  } catch (e) {
    if (e.code === 10003 || e.code === 10008 || e.code === 50001 || e.code === 50013) {
      const data = db.get();
      if (data.eloLeaderboards?.[guildId]) {
        delete data.eloLeaderboards[guildId];
        db.set(data);
      }
    }
    console.error('updateEloLeaderboard error:', e.message);
  }
}

const eloRankCommand = {
  data: new SlashCommandBuilder()
    .setName('elorank')
    .setDescription('Check ELO rank for yourself or another player')
    .addUserOption(o => o.setName('user').setDescription('Player to look up').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const selectedMember = interaction.options.getMember('user');
    const member = selectedMember || (target.id === interaction.user.id ? interaction.member : null);
    const displayName = member?.displayName || member?.nick || target.globalName || target.username;
    const data = db.get();
    const eloData = getEloData(data);
    const player = getPlayerElo(eloData, target.id);
    db.set(data);

    const embed = buildEloProfileEmbed(target, player, displayName);

    await interaction.reply({ embeds: [embed] });
  },
};

const eloLeaderboardCommand = {
  data: new SlashCommandBuilder()
    .setName('eloleaderboard')
    .setDescription('Top ELO rankings for this server'),

  async execute(interaction) {
    const data = db.get();
    const embed = buildEloLeaderboardEmbed(getEloData(data));
    await interaction.reply({ embeds: [embed] });
    const msg = await interaction.fetchReply();
    if (!data.eloLeaderboards) data.eloLeaderboards = {};
    data.eloLeaderboards[interaction.guildId] = { channelId: interaction.channelId, messageId: msg.id };
    db.set(data);
  },
};

const eloResetPlayerCommand = {
  data: new SlashCommandBuilder()
    .setName('eloresetplayer')
    .setDescription('Reset a player\'s ELO to 0 (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Player to reset').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const data = db.get();
    const eloData = getEloData(data);
    eloData[target.id] = {
      elo: STARTING_ELO,
      wins: 0,
      losses: 0,
      seasonElo: STARTING_ELO,
      seasonWins: 0,
      seasonLosses: 0,
      currentStreak: 0,
      bestStreak: 0,
      matchHistory: [],
    };
    db.set(data);
    await saveToDiscord(interaction.client);
    await updateEloLeaderboard(interaction.client, interaction.guildId);
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'ELO Player Reset', [
      { name: 'Player', value: `<@${target.id}>`, inline: true },
    ], interaction.user.id);
    try {
      const guild = await interaction.client.guilds.fetch(interaction.guildId);
      await syncRoles(guild, target.id, getTierForElo(STARTING_ELO));
    } catch {}
    await interaction.reply({ content: `Reset <@${target.id}>'s ELO to \`0\` (Tier V).`, flags: 64 });
  },
};

const eloResetAllCommand = {
  data: new SlashCommandBuilder()
    .setName('eloresetall')
    .setDescription('Reset everyone\'s ELO and win/loss record to 0 (Admin only)')
    .addBooleanOption(o => o.setName('confirm').setDescription('Confirm resetting all ELO data').setRequired(true)),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can reset all ELO data.', flags: 64 });
    }

    if (!interaction.options.getBoolean('confirm')) {
      return interaction.reply({ content: 'Reset cancelled. Run `/eloresetall confirm:true` to confirm.', flags: 64 });
    }

    const data = db.get();
    const eloData = getEloData(data);
    const resetCount = Object.keys(eloData).length;
    data.elo = {};
    db.set(data);
    await saveToDiscord(interaction.client);
    await updateEloLeaderboard(interaction.client, interaction.guildId);
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'ELO Reset All', [
      { name: 'Players Reset', value: String(resetCount), inline: true },
    ], interaction.user.id);
    await interaction.reply({ content: `Reset ELO and win/loss records for **${resetCount}** players.`, flags: 64 });
  },
};

const eloAdjustCommand = {
  data: new SlashCommandBuilder()
    .setName('eloadjust')
    .setDescription('Manually adjust a player\'s ELO (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount to add (negative to subtract)').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const data = db.get();
    const eloData = getEloData(data);
    const result = applyEloChange(eloData, target.id, amount);
    db.set(data);
    await saveToDiscord(interaction.client);
    await updateEloLeaderboard(interaction.client, interaction.guildId);
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'ELO Adjusted', [
      { name: 'Player', value: `<@${target.id}>`, inline: true },
      { name: 'Change', value: `${amount >= 0 ? '+' : ''}${amount}`, inline: true },
      { name: 'Result', value: `${result.oldElo} -> ${result.newElo}`, inline: true },
    ], interaction.user.id);
    try {
      const guild = await interaction.client.guilds.fetch(interaction.guildId);
      await syncRoles(guild, target.id, getTierForElo(result.newElo));
    } catch {}
    const sign = amount >= 0 ? '+' : '';
    await interaction.reply({ content: `Adjusted <@${target.id}>'s ELO by **${sign}${amount}**: \`${result.oldElo}\` -> \`${result.newElo}\` (Tier ${getTierForElo(result.newElo).tier})`, flags: 64 });
  },
};

module.exports = {
  eloRankCommand,
  eloLeaderboardCommand,
  eloResetPlayerCommand,
  eloResetAllCommand,
  eloAdjustCommand,
  applyMatchElo,
  applyMatchStreaks,
  buildMatchEloSummary,
  buildEloLeaderboardEmbed,
  updateEloLeaderboard,
  getTierForElo,
  getEloData,
  getPlayerElo,
  syncRoles,
  STARTING_ELO,
  TIERS,
  calculateMatchEloDelta,
  getStreakBounty,
};
