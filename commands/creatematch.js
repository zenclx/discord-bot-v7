const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  ChannelType, AttachmentBuilder,
} = require('discord.js');
const db = require('../database');
const { DARK_BLUE } = require('../utils');
const { buildBracketImage } = require('../bracketImage');
const { getEloData, getPlayerElo } = require('./elo');
const { sendStaffAuditLog } = require('../auditLog');
const { recordHostedEventFromMatch } = require('../eventPayouts');

const QUEUE_DURATION_MS = 5 * 60 * 1000;
const CHECKIN_DURATION_MS = 2 * 60 * 1000;
const timers = new Map();
const matchReminderTimers = new Map();
const MATCH_MANAGER_ROLES = ['1387600871377993820'];
const MATCH_CATEGORY_ID = '1511861274005471282';
const REMINDER_AFTER_MS = 15 * 60 * 1000;
const SCREENSHARE_ROLE_ID = '1408292481233326275';
const SCREENSHARE_DQ_MINUTES = 5;
const DEFAULT_LOG_CHANNEL_ID = '1384695119243907132';
const MATCH_PING_ROLE_ID = process.env.VERIFIED_COMPETITOR_ROLE_ID || process.env.MATCH_PING_ROLE_ID || '1333145733955850348';

function getMinPlayers(match) {
  if (match.type === '1v1') return match.testMatch ? 2 : 4;
  if (match.type === '3v3') return match.testMatch ? 6 : 9;
  return match.testMatch ? 4 : 6; // 2v2
}

// ── Permission ────────────────────────────────────────────────────────────────
function canManageMatch(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const data = db.get();
  const configured = data.settings?.[member.guild.id]?.matchManagerRoles || [];
  const allowedRoles = [...new Set([...MATCH_MANAGER_ROLES, ...configured])];
  return member.roles.cache.some(r => allowedRoles.includes(r.id));
}

function buildQueueCancelledEmbed(match, reason = 'The host cancelled this queue before the match started.') {
  return new EmbedBuilder()
    .setTitle('Queue Cancelled')
    .setColor(0xff0000)
    .setDescription(reason)
    .setTimestamp();
}

// ── Queue embed ───────────────────────────────────────────────────────────────
function buildQueueEmbed(match) {
  const typeLabel = match.type || '1v1';
  const minPlayers = getMinPlayers(match);
  const timeLeft = Math.max(0, Math.round((match.endsAt - Date.now()) / 1000));
  const mins = Math.floor(timeLeft / 60);
  const secs = String(timeLeft % 60).padStart(2, '0');
  const playerMentions = match.queue.map(id => `<@${id}>`).join('\n') || '*None yet*';

  const embed = new EmbedBuilder()
    .setTitle(`Match Queue${match.testMatch ? ' - Test' : ''} (${typeLabel})`)
    .setColor(DARK_BLUE)
    .addFields(
      { name: '👥 Players Queued', value: `**${match.queue.length}** joined\n${playerMentions}`, inline: true },
      { name: '⏳ Time Remaining', value: `**${mins}m ${secs}s**`, inline: true },
      { name: 'Min to Start', value: `**${minPlayers}** players${match.testMatch ? '\nTest mode' : ''}`, inline: true },
    )
    .setFooter({ text: 'Click Join Queue to enter! Host can force-start anytime.' })
    .setTimestamp();

  if (match.prize) embed.addFields({ name: '🎁 Prize', value: `**${match.prize}**`, inline: false });
  return embed;
}

function buildCheckInEmbed(match) {
  const checked = Object.keys(match.checkIns || {});
  const missing = (match.queue || []).filter(id => !match.checkIns?.[id]);
  const timeLeft = Math.max(0, Math.round(((match.checkInEndsAt || Date.now()) - Date.now()) / 1000));
  const mins = Math.floor(timeLeft / 60);
  const secs = String(timeLeft % 60).padStart(2, '0');

  return new EmbedBuilder()
    .setTitle(`Match Check-In (${match.type.toUpperCase()})`)
    .setColor(DARK_BLUE)
    .addFields(
      { name: 'Checked In', value: checked.length ? checked.map(id => `<@${id}>`).join('\n') : '*None yet*', inline: true },
      { name: 'Missing', value: missing.length ? missing.map(id => `<@${id}>`).join('\n') : '*Everyone checked in*', inline: true },
      { name: 'Time Remaining', value: `**${mins}m ${secs}s**`, inline: true },
    )
    .setFooter({ text: `Need ${getMinPlayers(match)} checked-in players to start.` })
    .setTimestamp();
}

function makeCheckInRows(matchId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`checkin_${matchId}`).setLabel('Check In').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cancel_queue_${matchId}`).setLabel('Cancel Match').setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Bracket embed + components ────────────────────────────────────────────────
function buildBracketTextEmbed(match, round) {
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${match.type.toUpperCase()} Bracket — Round ${round + 1}`)
    .setColor(DARK_BLUE)
    .setImage('attachment://bracket.png')
    .setFooter({ text: `Match ID: ${match.id}` })
    .setTimestamp();

  if (match.prize) embed.addFields({ name: '🎁 Prize', value: `**${match.prize}**`, inline: false });
  if (match.region) embed.addFields({ name: '🌍 Region', value: match.region, inline: true });
  if (match.bo3Mode && match.bo3Mode !== 'none') {
    const label = match.bo3Mode === 'all' ? 'Best of 3 (All)' : 'Finals Bo3';
    embed.addFields({ name: '🎮 Format', value: label, inline: true });
  }
  if (['2v2', '3v3'].includes(match.type) && match.teams) {
    const teamLines = match.teams.map((t, i) =>
      `**Team ${String.fromCharCode(65 + i)}:** ${t.map(id => `<@${id}>`).join(' & ')}`
    );
    embed.addFields({ name: '👥 Teams', value: teamLines.join('\n'), inline: false });
  }
  return embed;
}

function buildBracketComponents(match, round) {
  const currentRound = match.bracket[round];
  const rows = [];
  currentRound.forEach((m, i) => {
    if (!m.winner && !m.bye) {
      const p1Label = m.teamLabel1 || m.p1Tag || 'Player 1';
      const p2Label = m.teamLabel2 || m.p2Tag || 'Player 2';
      // Use base64-safe IDs to avoid _ collision in customId parsing
      // Format: win|matchId|round|index|winnerId  (pipe separator)
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`win|${match.id}|${round}|${i}|${m.p1}`)
          .setLabel(`M${i + 1}: ${p1Label.slice(0, 20)} wins`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`win|${match.id}|${round}|${i}|${m.p2}`)
          .setLabel(`M${i + 1}: ${p2Label.slice(0, 20)} wins`)
          .setStyle(ButtonStyle.Primary),
      );
      rows.push(row);
    }
  });
  return rows.slice(0, 5);
}

function makeBracketAttachment(match) {
  const buf = buildBracketImage(match.bracket, match.currentRound, null);
  return new AttachmentBuilder(buf, { name: 'bracket.png' });
}

function buildSeedPreviewEmbed(match) {
  const embed = new EmbedBuilder()
    .setTitle(`Bracket Seeding Preview - Match #${match.matchNum ?? '?'}`)
    .setColor(DARK_BLUE)
    .setDescription('Review the seeded bracket. Confirm to post the official bracket, or reshuffle before the match begins.')
    .setImage('attachment://bracket.png')
    .setFooter({ text: `Match ID: ${match.id}` })
    .setTimestamp();

  if (['2v2', '3v3'].includes(match.type) && match.teams?.length) {
    const teamLines = match.teams.map((t, i) =>
      `**Team ${String.fromCharCode(65 + i)}:** ${t.map(id => `<@${id}>`).join(' & ')}`
    );
    embed.addFields({ name: '👥 Teams', value: teamLines.join('\n'), inline: false });
  }
  return embed;
}

function makeSeedPreviewRows(matchId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`seed_confirm_${matchId}`).setLabel('Confirm Bracket').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`seed_reshuffle_${matchId}`).setLabel('Reshuffle').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function postSeedPreview(client, match, { allowChannelFallback = false } = {}) {
  let usedFallback = false;
  let channel = match.seedPreviewChannelId
    ? await client.channels.fetch(match.seedPreviewChannelId).catch(() => null)
    : await client.users.fetch(match.hostId).then(user => user.createDM()).catch(() => null);

  if (!channel && allowChannelFallback && match.privateChannelId) {
    channel = await client.channels.fetch(match.privateChannelId).catch(() => null);
    usedFallback = Boolean(channel);
  }

  if (!channel) return null;
  const payload = {
    content: usedFallback
      ? `<@${match.hostId}> I could not DM you the bracket preview. Confirm or reshuffle it here.`
      : null,
    embeds: [buildSeedPreviewEmbed(match)],
    components: makeSeedPreviewRows(match.id),
    files: [makeBracketAttachment(match)],
    allowedMentions: usedFallback ? { users: [match.hostId] } : { parse: [] },
  };
  if (match.seedPreviewMessageId) {
    const msg = await channel.messages.fetch(match.seedPreviewMessageId).catch(() => null);
    if (msg) {
      await msg.edit(payload);
      return msg;
    }
  }
  return channel.send(payload);
}

// ── Bracket generation ────────────────────────────────────────────────────────
function getSeededPlayers(players, eloData) {
  return [...players].sort((a, b) => {
    const aElo = getPlayerElo(eloData, a).elo || 0;
    const bElo = getPlayerElo(eloData, b).elo || 0;
    return bElo - aElo || a.localeCompare(b);
  });
}

function orderBySeeds(items) {
  const ordered = [];
  let left = 0;
  let right = items.length - 1;
  while (left <= right) {
    ordered.push(items[left++]);
    if (left <= right) ordered.push(items[right--]);
  }
  return ordered;
}

function shuffleItems(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function generateBracket(players, eloData, randomize = false) {
  const shuffled = randomize ? shuffleItems(players) : orderBySeeds(getSeededPlayers(players, eloData));
  const round = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    round.push({ p1: shuffled[i], p2: shuffled[i + 1], winner: null, p1Tag: null, p2Tag: null, bye: false });
  }
  if (shuffled.length % 2 !== 0) {
    round.push({ p1: shuffled[shuffled.length - 1], p2: null, winner: shuffled[shuffled.length - 1], bye: true, byePlayer: true, p1Tag: null });
  }
  return [round];
}

function pairIntoTeams(players, eloData, randomize = false) {
  const seeded = randomize ? shuffleItems(players) : getSeededPlayers(players, eloData);
  const teams = [];
  while (seeded.length >= 2) {
    const high = seeded.shift();
    const low = seeded.pop();
    teams.push([high, low]);
  }
  return teams;
}

function pairIntoTrios(players, eloData, randomize = false) {
  const seeded = randomize ? shuffleItems(players) : getSeededPlayers(players, eloData);
  const teamCount = Math.floor(seeded.length / 3);
  const teams = Array.from({ length: teamCount }, () => []);
  for (let i = 0; i < teamCount * 3; i++) {
    const round = Math.floor(i / teamCount);
    const pos = i % teamCount;
    const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
    teams[teamIdx].push(seeded[i]);
  }
  return teams.filter(t => t.length === 3);
}

function getTeamElo(team, eloData) {
  if (!team?.length) return 0;
  return team.reduce((total, id) => total + (getPlayerElo(eloData, id).elo || 0), 0) / team.length;
}

function generateTeamBracket(teams, eloData, randomize = false) {
  // Sort by team ELO and pair consecutively so similar-strength teams face each other
  const seededTeams = randomize ? shuffleItems(teams) : [...teams].sort((a, b) => getTeamElo(b, eloData) - getTeamElo(a, eloData));
  const round = [];
  for (let i = 0; i + 1 < seededTeams.length; i += 2) {
    round.push({
      p1: seededTeams[i][0], p2: seededTeams[i + 1][0],
      p1Tag: `Team ${String.fromCharCode(65 + i)}`,
      p2Tag: `Team ${String.fromCharCode(65 + i + 1)}`,
      teamLabel1: `Team ${String.fromCharCode(65 + i)}`,
      teamLabel2: `Team ${String.fromCharCode(65 + i + 1)}`,
      teamA: seededTeams[i], teamB: seededTeams[i + 1],
      winner: null, bye: false,
    });
  }
  if (seededTeams.length % 2 !== 0) {
    const t = seededTeams[seededTeams.length - 1];
    round.push({ p1: t[0], p2: null, winner: t[0], bye: true, byePlayer: true, p1Tag: `Team ${String.fromCharCode(65 + seededTeams.length - 1)}`, teamA: t });
  }
  return { bracket: [round], seededTeams };
}

function generateMatchBracket(match, eloData, randomize = false) {
  if (['2v2', '3v3'].includes(match.type) && !match.testMatch) {
    const preformed = match.preformedTeams || [];
    const preformedSet = new Set(preformed.flat());
    const remaining = (match.queue || []).filter(id => !preformedSet.has(id));
    const extra = match.type === '3v3'
      ? (match.draftedTeams || pairIntoTrios(remaining, eloData, randomize))
      : (match.draftedTeams || pairIntoTeams(remaining, eloData, randomize));
    const allTeams = [...preformed, ...extra];
    const { bracket, seededTeams } = generateTeamBracket(allTeams, eloData, randomize);
    match.teams = seededTeams; // keep in seeded order so Team A/B/C labels match the bracket
    match.bracket = bracket;
  } else {
    match.bracket = generateBracket(match.queue, eloData, randomize);
  }
  match.currentRound = 0;
}

function buildNextRound(currentRound) {
  // Build a map of winner → team info for team-based matches (2v2/3v3)
  const teamInfo = new Map();
  for (const m of currentRound) {
    if (m.teamA) teamInfo.set(m.p1, { team: m.teamA, label: m.teamLabel1 });
    if (m.teamB) teamInfo.set(m.p2, { team: m.teamB, label: m.teamLabel2 });
  }

  // Collect winners in bracket order (byes already have winner set, so they keep their slot)
  const winners = currentRound.map(m => ({
    id: m.winner,
    tag: m.winner === m.p1 ? m.p1Tag : m.p2Tag,
    info: teamInfo.get(m.winner),
  }));

  const nextRound = [];
  for (let i = 0; i + 1 < winners.length; i += 2) {
    const w1 = winners[i];
    const w2 = winners[i + 1];
    const bm = { p1: w1.id, p2: w2.id, winner: null, p1Tag: w1.tag, p2Tag: w2.tag, bye: false };
    if (w1.info) { bm.teamA = w1.info.team; bm.teamLabel1 = w1.info.label; }
    if (w2.info) { bm.teamB = w2.info.team; bm.teamLabel2 = w2.info.label; }
    nextRound.push(bm);
  }

  if (winners.length % 2 !== 0) {
    const last = winners[winners.length - 1];
    const bm = { p1: last.id, p2: null, winner: last.id, bye: true, byePlayer: true, p1Tag: last.tag };
    if (last.info) { bm.teamA = last.info.team; bm.teamLabel1 = last.info.label; }
    nextRound.push(bm);
  }

  return nextRound;
}

async function fetchDisplayNames(guild, round) {
  for (const m of round) {
    if (m.p1 && !m.p1Tag) { try { m.p1Tag = (await guild.members.fetch(m.p1)).displayName; } catch {} }
    if (m.p2 && !m.p2Tag) { try { m.p2Tag = (await guild.members.fetch(m.p2)).displayName; } catch {} }
  }
}

// ── DM helper ─────────────────────────────────────────────────────────────────
async function dmUser(client, userId, content) {
  try {
    const data = db.get();
    if (data.userSettings && Object.values(data.userSettings).some(guildSettings => guildSettings?.[userId]?.botNotificationsDisabled)) return;
    await (await client.users.fetch(userId)).send(content);
  } catch {}
}

// ── Match reminder ────────────────────────────────────────────────────────────
function scheduleMatchReminder(client, match, matchId, bracketMatchIndex, round) {
  const key = `${matchId}|${round}|${bracketMatchIndex}`;
  if (matchReminderTimers.has(key)) clearTimeout(matchReminderTimers.get(key));
  const timer = setTimeout(async () => {
    matchReminderTimers.delete(key);
    const data = db.get();
    const m = data.matches?.[matchId];
    if (!m || m.status === 'complete') return;
    const bm = m.bracket?.[round]?.[bracketMatchIndex];
    if (!bm || bm.winner) return;
    if (!m.privateChannelId) return;
    try {
      const ch = await client.channels.fetch(m.privateChannelId);
      const mentions = [bm.p1, bm.p2].filter(Boolean).map(id => `<@${id}>`).join(' ');
      await ch.send(`⏰ **Reminder:** ${mentions} — Round ${round + 1}, Match ${bracketMatchIndex + 1} still needs a winner!`);
    } catch {}
  }, REMINDER_AFTER_MS);
  matchReminderTimers.set(key, timer);
}

// ── Channel ───────────────────────────────────────────────────────────────────
async function createMatchChannel(client, match) {
  try {
    const guild = await client.guilds.fetch(match.guildId);
    const data = db.get();
    const configuredManagerRoles = data.settings?.[match.guildId]?.matchManagerRoles || [];
    const managerRoles = [...new Set([...MATCH_MANAGER_ROLES, ...configuredManagerRoles])];
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      ...match.queue.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ...managerRoles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    ];
    return await guild.channels.create({
      name: `match-${match.matchNum ?? 0}`,
      type: ChannelType.GuildText,
      parent: MATCH_CATEGORY_ID,
      permissionOverwrites: overwrites,
      topic: `Private match | ${match.type.toUpperCase()} | ID: ${match.id}`,
    });
  } catch (e) { console.error('createMatchChannel error:', e.message); return null; }
}

async function scheduleChannelDelete(client, channelId, vcChannelId = null, announceChannelId = null) {
  const deleteChannel = async (id, label) => {
    try {
      const ch = await client.channels.fetch(id).catch(() => null);
      if (!ch) return;
      await ch.delete('Match complete');
    } catch (e) {
      console.error(`scheduleChannelDelete failed to delete ${label} channel ${id}: ${e.message}`);
    }
  };

  setTimeout(async () => {
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch) await ch.send('⚠️ **This channel will be deleted in 10 seconds.**');
    } catch {}
  }, 50000);

  setTimeout(async () => {
    await deleteChannel(channelId, 'private');
    if (vcChannelId) await deleteChannel(vcChannelId, 'voice');
    if (announceChannelId) await deleteChannel(announceChannelId, 'announcements');
  }, 60000);
}

async function createAnnouncementsChannel(client, match) {
  try {
    const guild = await client.guilds.fetch(match.guildId);
    const data = db.get();
    const configuredManagerRoles = data.settings?.[match.guildId]?.matchManagerRoles || [];
    const managerRoles = [...new Set([...MATCH_MANAGER_ROLES, ...configuredManagerRoles])];
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      { id: '1387600871377993820', allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ...match.queue.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
      ...managerRoles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
    ];
    return await guild.channels.create({
      name: `match-${match.matchNum ?? 0}-results`,
      type: ChannelType.GuildText,
      parent: MATCH_CATEGORY_ID,
      permissionOverwrites: overwrites,
      topic: `Match announcements | ${match.type.toUpperCase()} | ID: ${match.id}`,
    });
  } catch (e) { console.error('createAnnouncementsChannel error:', e.message); return null; }
}

async function sendMatchAnnouncement(client, match, payload) {
  const channelId = match.announcementsChannelId || match.privateChannelId;
  if (!channelId) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    return await ch.send(payload);
  } catch (e) { console.error('sendMatchAnnouncement error:', e.message); return null; }
}

async function createMatchVoiceChannel(client, match) {
  try {
    const guild = await client.guilds.fetch(match.guildId);
    const data = db.get();
    const configuredManagerRoles = data.settings?.[match.guildId]?.matchManagerRoles || [];
    const managerRoles = [...new Set([...MATCH_MANAGER_ROLES, ...configuredManagerRoles])];
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ManageChannels,
        ],
      },
      ...match.queue.map(id => ({
        id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Stream,
          PermissionFlagsBits.UseVAD,
          PermissionFlagsBits.Speak,
        ],
      })),
      ...managerRoles.map(id => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
      })),
    ];
    return await guild.channels.create({
      name: `vc-match-${match.matchNum ?? 0}`,
      type: ChannelType.GuildVoice,
      parent: MATCH_CATEGORY_ID,
      permissionOverwrites: overwrites,
    });
  } catch (e) { console.error('createMatchVoiceChannel error:', e.message); return null; }
}

async function scheduleScreenshareCheck(client, matchId, vcChannelId) {
  setTimeout(async () => {
    try {
      const data = db.get();
      const match = data.matches?.[matchId];
      if (!match || match.status !== 'bracket') return;

      const vc = await client.channels.fetch(vcChannelId).catch(() => null);
      if (!vc) return;

      const membersInVc = new Set(vc.members.keys());
      const guild = await client.guilds.fetch(match.guildId).catch(() => null);
      if (!guild) return;

      const needVc = new Set();
      for (const playerId of match.queue) {
        const member = await guild.members.fetch(playerId).catch(() => null);
        if (member?.roles.cache.has(SCREENSHARE_ROLE_ID)) needVc.add(playerId);
      }
      if (!needVc.size) return;

      const missingVc = [...needVc].filter(id => !membersInVc.has(id));
      if (!missingVc.length) return;

      const currentRound = match.bracket[match.currentRound];
      if (!currentRound) return;

      const dqAnnouncements = [];
      let anyDq = false;

      for (const bm of currentRound) {
        if (bm.winner || bm.bye) continue;
        if (['2v2', '3v3'].includes(match.type)) {
          const teamAMissing = (bm.teamA || []).some(id => missingVc.includes(id));
          const teamBMissing = (bm.teamB || []).some(id => missingVc.includes(id));
          if (teamAMissing && !teamBMissing) {
            bm.winner = bm.p2;
            bm.resultReason = 'VC screenshare DQ';
            const dqNames = (bm.teamA || []).filter(id => missingVc.includes(id)).map(id => `<@${id}>`).join(', ');
            dqAnnouncements.push(`🚫 **VC DQ:** ${bm.teamLabel1 || 'Team A'} (${dqNames}) did not join VC — ${bm.teamLabel2 || 'Team B'} advances.`);
            anyDq = true;
          } else if (teamBMissing && !teamAMissing) {
            bm.winner = bm.p1;
            bm.resultReason = 'VC screenshare DQ';
            const dqNames = (bm.teamB || []).filter(id => missingVc.includes(id)).map(id => `<@${id}>`).join(', ');
            dqAnnouncements.push(`🚫 **VC DQ:** ${bm.teamLabel2 || 'Team B'} (${dqNames}) did not join VC — ${bm.teamLabel1 || 'Team A'} advances.`);
            anyDq = true;
          }
        } else {
          const p1Missing = bm.p1 && missingVc.includes(bm.p1);
          const p2Missing = bm.p2 && missingVc.includes(bm.p2);
          if (p1Missing && !p2Missing) {
            bm.winner = bm.p2;
            bm.resultReason = 'VC screenshare DQ';
            dqAnnouncements.push(`🚫 **VC DQ:** <@${bm.p1}> did not join VC — <@${bm.p2}> advances.`);
            anyDq = true;
          } else if (p2Missing && !p1Missing) {
            bm.winner = bm.p1;
            bm.resultReason = 'VC screenshare DQ';
            dqAnnouncements.push(`🚫 **VC DQ:** <@${bm.p2}> did not join VC — <@${bm.p1}> advances.`);
            anyDq = true;
          }
        }
      }

      if (!anyDq) return;

      data.matches[matchId] = match;
      db.set(data);

      if (match.privateChannelId) {
        try {
          const ch = await client.channels.fetch(match.privateChannelId);
          await ch.send(`⏰ **Screenshare check complete (${SCREENSHARE_DQ_MINUTES}min):**\n${dqAnnouncements.join('\n')}`);
        } catch {}
      }

      const roundComplete = currentRound.every(m => m.winner !== null);
      if (roundComplete) {
        const uniqueWinners = [...new Set(currentRound.map(m => m.winner))];
        if (uniqueWinners.length === 1) {
          const champion = uniqueWinners[0];
          match.status = 'complete';
          match.champion = champion;
          const completeData = db.get();
          completeData.matches[matchId] = match;
          db.set(completeData);
          if (match.privateChannelId) {
            try {
              const ch = await client.channels.fetch(match.privateChannelId);
              const champEntry = currentRound.find(m => m.winner === champion);
              const champTeam = match.type === '2v2' && champEntry
                ? (champion === champEntry.p1 ? champEntry.teamA : champEntry.teamB) || null
                : null;
              const champDisplay = champTeam?.length
                ? champTeam.map(id => `<@${id}>`).join(' & ')
                : `<@${champion}>`;
              await ch.send(`🏆 **Tournament Complete via VC DQ!**\nChampion: ${champDisplay}`);
            } catch {}
            scheduleChannelDelete(client, match.privateChannelId, match.vcChannelId || null, match.announcementsChannelId || null);
          }
        } else {
          const nextRound = buildNextRound(currentRound);
          try {
            const g2 = await client.guilds.fetch(match.guildId);
            if (match.type === '1v1') await fetchDisplayNames(g2, nextRound);
          } catch {}
          match.bracket.push(nextRound);
          match.currentRound = match.currentRound + 1;
          const advData = db.get();
          advData.matches[matchId] = match;
          db.set(advData);
        }
      }

      await postOrUpdateBracket(client, match);
    } catch (e) { console.error('scheduleScreenshareCheck error:', e.message); }
  }, SCREENSHARE_DQ_MINUTES * 60 * 1000);
}

// ── Logging ───────────────────────────────────────────────────────────────────
async function logMatchResult(client, match, winnerId, loserIds) {
  try {
    const data = db.get();
    const guildId = match.guildId;
    if (!data.matchLogs) data.matchLogs = {};
    if (!data.matchLogs[guildId]) data.matchLogs[guildId] = [];
    data.matchLogs[guildId].unshift({
      matchId: match.id, matchNum: match.matchNum ?? 0, type: match.type,
      winner: winnerId, opponents: loserIds, prize: match.prize || null,
      timestamp: Date.now(), scoreboard: match.scoreboardName || null,
    });
    if (data.matchLogs[guildId].length > 100) data.matchLogs[guildId].length = 100;
    db.set(data);
    recordHostedEventFromMatch(client, match).catch(error => console.error('recordHostedEventFromMatch error:', error.message));

    const settings = data.settings?.[guildId] || {};
    const logChannelId = settings.logChannelId || DEFAULT_LOG_CHANNEL_ID;
    if (logChannelId) {
      const ch = await client.channels.fetch(logChannelId);
      const embed = new EmbedBuilder()
        .setTitle('📋 Match Result').setColor(0x00c853)
        .addFields(
          { name: '🏆 Winner', value: `<@${winnerId}>`, inline: true },
          { name: '🎮 Type', value: match.type.toUpperCase(), inline: true },
        ).setTimestamp();
      embed.addFields({ name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true });
      if (match.bracket) embed.setImage('attachment://bracket.png');
      if (match.prize) embed.addFields({ name: '🎁 Prize', value: match.prize });
      await ch.send({
        embeds: [embed],
        files: match.bracket ? [makeBracketAttachment(match)] : [],
        allowedMentions: { parse: [] }
      });
    }
  } catch (e) { console.error('logMatchResult error:', e.message); }
}

// ── Bracket post/update ───────────────────────────────────────────────────────
async function postOrUpdateBracket(client, match) {
  const channelId = match.announcementsChannelId || match.privateChannelId;
  if (!channelId) return;
  try {
    // Always read fresh bracketMessageId from DB to reduce duplicate-post race conditions
    const freshData = db.get();
    const freshMatch = freshData.matches?.[match.id];
    if (freshMatch?.bracketMessageId) match.bracketMessageId = freshMatch.bracketMessageId;

    const ch = await client.channels.fetch(channelId);
    const attachment = makeBracketAttachment(match);
    const embed = buildBracketTextEmbed(match, match.currentRound);
    const components = buildBracketComponents(match, match.currentRound);

    if (match.bracketMessageId) {
      try {
        const msg = await ch.messages.fetch(match.bracketMessageId);
        await msg.edit({ embeds: [embed], files: [attachment], components });
        return;
      } catch {}
    }
    const msg = await ch.send({ embeds: [embed], files: [attachment], components });
    match.bracketMessageId = msg.id;
    msg.pin().catch(() => {});
    // Save immediately to prevent concurrent calls from creating duplicate messages
    const saveData = db.get();
    if (saveData.matches?.[match.id]) {
      saveData.matches[match.id].bracketMessageId = msg.id;
      db.set(saveData);
    }
  } catch (e) { console.error('postOrUpdateBracket error:', e.message); }
}

// ── Predictions (opt-in per guild via /enablepredictions) ─────────────────────
async function postPredictionPoll(client, match, bracketMatch, round, matchIndex) {
  // Check if predictions are enabled for this guild
  const data = db.get();
  const settings = data.settings?.[match.guildId] || {};
  if (!settings.predictionsEnabled) return;
  if (!match.privateChannelId) return;

  const p1Label = bracketMatch.teamLabel1 || bracketMatch.p1Tag || `<@${bracketMatch.p1}>`;
  const p2Label = bracketMatch.teamLabel2 || bracketMatch.p2Tag || `<@${bracketMatch.p2}>`;
  const predId = `pred|${match.id}|${round}|${matchIndex}`;

  try {
    const ch = await client.channels.fetch(match.privateChannelId);
    const embed = new EmbedBuilder()
      .setTitle('🎯 Match Prediction!')
      .setColor(0x9b59b6)
      .setDescription(`Who will win Match ${matchIndex + 1}?\nVote below — results shown after the match!`)
      .addFields(
        { name: '🟢 Option A', value: p1Label, inline: true },
        { name: '🔵 Option B', value: p2Label, inline: true },
      )
      .setFooter({ text: 'Anyone can vote!' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${predId}|p1`).setLabel(`Vote: ${p1Label.slice(0, 30)}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${predId}|p2`).setLabel(`Vote: ${p2Label.slice(0, 30)}`).setStyle(ButtonStyle.Primary),
    );

    const msg = await ch.send({ embeds: [embed], components: [row] });

    const freshData = db.get();
    if (!freshData.predictions) freshData.predictions = {};
    freshData.predictions[predId] = {
      matchId: match.id, round, matchIndex,
      p1: bracketMatch.p1, p2: bracketMatch.p2,
      p1Label, p2Label, votes: {}, messageId: msg.id,
      channelId: match.privateChannelId,
    };
    db.set(freshData);
  } catch (e) { console.error('postPredictionPoll error:', e.message); }
}

async function revealPrediction(client, predId, winnerId) {
  try {
    const data = db.get();
    const pred = data.predictions?.[predId];
    if (!pred) return;
    const ch = await client.channels.fetch(pred.channelId);
    const msg = await ch.messages.fetch(pred.messageId);
    const p1Votes = Object.values(pred.votes).filter(v => v === 'p1').length;
    const p2Votes = Object.values(pred.votes).filter(v => v === 'p2').length;
    const total = p1Votes + p2Votes;
    const winnerLabel = winnerId === pred.p1 ? pred.p1Label : pred.p2Label;
    const bar = n => { const p = total ? Math.round((n / total) * 10) : 0; return '█'.repeat(p) + '░'.repeat(10 - p); };

    const embed = new EmbedBuilder()
      .setTitle('🎯 Prediction Results').setColor(0x9b59b6)
      .setDescription(`**Winner: ${winnerLabel}** 🏆`)
      .addFields(
        { name: pred.p1Label, value: `${bar(p1Votes)} ${p1Votes} votes (${total ? Math.round(p1Votes / total * 100) : 0}%)` },
        { name: pred.p2Label, value: `${bar(p2Votes)} ${p2Votes} votes (${total ? Math.round(p2Votes / total * 100) : 0}%)` },
      ).setTimestamp();

    await msg.edit({ embeds: [embed], components: [] });
  } catch (e) { console.error('revealPrediction error:', e.message); }
}

// ── Bo3 vote ──────────────────────────────────────────────────────────────────
// Returns a promise that resolves when the 60s vote is done, with the result
// ── Team format vote (2v2 only) ───────────────────────────────────────────────
async function postTeamFormatVote(client, match) {
  if (!match.privateChannelId) return 'random';
  return new Promise(async (resolve) => {
    try {
      const ch = await client.channels.fetch(match.privateChannelId);
      const voteId = `teamfmt|${match.id}`;
      const embed = new EmbedBuilder()
        .setTitle('👥 Step 1 of 3 — Team Selection')
        .setColor(DARK_BLUE)
        .setDescription('How should teams be formed?\nPoll ends in **60 seconds** or when host force-closes.')
        .addFields(
          { name: '🎲 Random Teams', value: 'Teams balanced by ELO automatically', inline: true },
          { name: '🤝 Pick Teammate', value: 'Each player chooses their own partner', inline: true },
        )
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${voteId}|random`).setLabel('🎲 Random Teams').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${voteId}|pick`).setLabel('🤝 Pick Teammate').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${voteId}|close`).setLabel('Close Vote').setStyle(ButtonStyle.Danger),
      );

      const msg = await ch.send({ embeds: [embed], components: [row] });
      const data = db.get();
      if (!data.teamfmtvotes) data.teamfmtvotes = {};
      data.teamfmtvotes[voteId] = { matchId: match.id, votes: {}, messageId: msg.id, channelId: match.privateChannelId, closed: false };
      db.set(data);

      const finish = async () => {
        const fresh = db.get();
        const vote = fresh.teamfmtvotes?.[voteId];
        if (!vote || vote.closed) return;
        vote.closed = true;
        const tally = { random: 0, pick: 0 };
        for (const v of Object.values(vote.votes || {})) if (v in tally) tally[v]++;
        const winner = tally.pick > tally.random ? 'pick' : 'random';
        db.set(fresh);
        const resultEmbed = new EmbedBuilder()
          .setTitle('✅ Team Selection Decided!')
          .setColor(0x00c853)
          .setDescription(winner === 'pick'
            ? `**🤝 Pick Teammate** wins!\nRandom: ${tally.random} | Pick: ${tally.pick}`
            : `**🎲 Random Teams** wins!\nRandom: ${tally.random} | Pick: ${tally.pick}`)
          .setTimestamp();
        try { await msg.edit({ embeds: [resultEmbed], components: [] }); } catch {}
        resolve(winner);
      };

      if (!global._teamfmtFinishers) global._teamfmtFinishers = new Map();
      global._teamfmtFinishers.set(voteId, finish);
      setTimeout(finish, 60000);
    } catch (e) { console.error('postTeamFormatVote error:', e.message); resolve('random'); }
  });
}

// ── Team draft (2v2 only, when Pick Teammate wins) ────────────────────────────
async function postTeamDraft(client, match) {
  if (!match.privateChannelId) return null;
  const ch = await client.channels.fetch(match.privateChannelId).catch(() => null);
  if (!ch) return null;

  const guild = await client.guilds.fetch(match.guildId).catch(() => null);
  const getName = async (id) => {
    try { return (await guild?.members.fetch(id))?.displayName || `<@${id}>`; } catch { return `<@${id}>`; }
  };

  const preformedSet = new Set((match.preformedTeams || []).flat());
  const unpaired = shuffleItems(match.queue.filter(id => !preformedSet.has(id)));
  const teams = [];

  while (unpaired.length >= 2) {
    if (unpaired.length === 2) {
      const teamLetter = String.fromCharCode(65 + teams.length);
      teams.push([unpaired[0], unpaired[1]]);
      const autoEmbed = new EmbedBuilder()
        .setTitle(`✅ Team ${teamLetter} Formed!`)
        .setColor(0x00c853)
        .setDescription(`**Team ${teamLetter}:** <@${unpaired[0]}> & <@${unpaired[1]}>\n*(Last two players — auto-paired)*`)
        .setTimestamp();
      await ch.send({ embeds: [autoEmbed], allowedMentions: { parse: [] } }).catch(() => {});
      unpaired.length = 0;
      break;
    }

    const picker = unpaired[0];
    const candidates = unpaired.slice(1);
    const pickerName = await getName(picker);
    const candidateNames = await Promise.all(candidates.map(id => getName(id)));

    const teamsFormed = teams.map((t, i) =>
      `**Team ${String.fromCharCode(65 + i)}:** <@${t[0]}> & <@${t[1]}>`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🤝 Team Draft — ${pickerName.slice(0, 30)}, pick your teammate`)
      .setColor(DARK_BLUE)
      .setDescription(`<@${picker}>, select your partner below!\n*60 seconds to pick — random if no response.*`)
      .setTimestamp();
    if (teamsFormed) embed.addFields({ name: '✅ Teams Formed', value: teamsFormed, inline: false });
    embed.addFields({ name: '⏳ Available Players', value: unpaired.map(id => `<@${id}>`).join('\n'), inline: false });

    const buttonRows = [];
    for (let i = 0; i < candidates.length && buttonRows.length < 4; i += 5) {
      const chunk = candidates.slice(i, i + 5);
      buttonRows.push(new ActionRowBuilder().addComponents(
        chunk.map((id, j) =>
          new ButtonBuilder()
            .setCustomId(`teampick|${match.id}|${picker}|${id}`)
            .setLabel(candidateNames[i + j].slice(0, 20))
            .setStyle(ButtonStyle.Primary)
        )
      ));
    }
    buttonRows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`teampick|${match.id}|${picker}|close`)
        .setLabel('Skip (Host Only)')
        .setStyle(ButtonStyle.Danger)
    ));

    const msg = await ch.send({
      content: `<@${picker}>`,
      embeds: [embed],
      components: buttonRows,
      allowedMentions: { users: [picker] },
    }).catch(() => null);

    const draftKey = `teampick|${match.id}|${picker}`;
    const picked = await new Promise(resolve => {
      if (!global._teamDraftResolvers) global._teamDraftResolvers = new Map();
      const timeout = setTimeout(() => {
        global._teamDraftResolvers.delete(draftKey);
        resolve(candidates[Math.floor(Math.random() * candidates.length)]);
      }, 60000);
      global._teamDraftResolvers.set(draftKey, (targetId) => {
        clearTimeout(timeout);
        global._teamDraftResolvers.delete(draftKey);
        if (targetId === '__skip__') {
          resolve(candidates[Math.floor(Math.random() * candidates.length)]);
        } else {
          resolve(targetId);
        }
      });
    });

    const teamLetter = String.fromCharCode(65 + teams.length);
    teams.push([picker, picked]);
    unpaired.splice(unpaired.indexOf(picker), 1);
    unpaired.splice(unpaired.indexOf(picked), 1);

    const pickedName = candidateNames[candidates.indexOf(picked)] || `<@${picked}>`;
    const resultEmbed = new EmbedBuilder()
      .setTitle(`✅ Team ${teamLetter} Formed!`)
      .setColor(0x00c853)
      .setDescription(`**Team ${teamLetter}:** <@${picker}> & <@${picked}>`)
      .setTimestamp();
    if (msg) await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
    else await ch.send({ embeds: [resultEmbed], allowedMentions: { parse: [] } }).catch(() => {});
  }

  return teams.length ? teams : null;
}

// ── Captain mode prompt (3v3 only) ───────────────────────────────────────────
async function postCaptainModePrompt(client, match) {
  if (!match.privateChannelId) return 'auto';
  return new Promise(async (resolve) => {
    try {
      const ch = await client.channels.fetch(match.privateChannelId);
      const voteId = `captainmode|${match.id}`;
      const embed = new EmbedBuilder()
        .setTitle('👑 3v3 Team Formation')
        .setColor(DARK_BLUE)
        .setDescription('How should teams be formed?\n*Host has 30 seconds to decide.*')
        .addFields(
          { name: '👑 Team Captains', value: 'Top 3 ELO players become captains and pick teammates', inline: true },
          { name: '⚖️ Auto Balance', value: 'Teams formed automatically by ELO', inline: true },
        )
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${voteId}|captains`).setLabel('👑 Team Captains').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${voteId}|auto`).setLabel('⚖️ Auto Balance').setStyle(ButtonStyle.Primary),
      );

      const msg = await ch.send({
        content: `<@${match.hostId}>`,
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [match.hostId] },
      });

      const finish = async (choice) => {
        try { await msg.edit({ components: [] }); } catch {}
        resolve(choice);
      };

      if (!global._captainModeFinishers) global._captainModeFinishers = new Map();
      global._captainModeFinishers.set(voteId, finish);

      setTimeout(() => {
        const f = global._captainModeFinishers?.get(voteId);
        if (f) { global._captainModeFinishers.delete(voteId); f('auto'); }
      }, 30000);
    } catch (e) { console.error('postCaptainModePrompt error:', e.message); resolve('auto'); }
  });
}

// ── Captain draft (3v3 only) ─────────────────────────────────────────────────
async function postCaptainDraft(client, match) {
  if (!match.privateChannelId) return null;
  const ch = await client.channels.fetch(match.privateChannelId).catch(() => null);
  if (!ch) return null;

  const data = db.get();
  const eloData = getEloData(data);

  const guild = await client.guilds.fetch(match.guildId).catch(() => null);
  const getName = async (id) => {
    try { return (await guild?.members.fetch(id))?.displayName || `<@${id}>`; } catch { return `<@${id}>`; }
  };

  // Top 3 ELO become captains
  const sorted = [...match.queue].sort((a, b) =>
    (getPlayerElo(eloData, b).elo || 0) - (getPlayerElo(eloData, a).elo || 0)
  );
  const captains = sorted.slice(0, 3);
  const pool = sorted.slice(3);
  const teams = captains.map(cap => [cap]);

  const captainNames = await Promise.all(captains.map(getName));
  const captainEmbed = new EmbedBuilder()
    .setTitle('👑 Team Captains Selected')
    .setColor(DARK_BLUE)
    .setDescription('The top 3 ELO players are captains. They take turns picking teammates.')
    .addFields(
      { name: 'Captain A', value: `<@${captains[0]}>`, inline: true },
      { name: 'Captain B', value: `<@${captains[1]}>`, inline: true },
      { name: 'Captain C', value: `<@${captains[2]}>`, inline: true },
    )
    .setTimestamp();
  await ch.send({ embeds: [captainEmbed], allowedMentions: { parse: [] } }).catch(() => {});

  // Pick order: A, B, C, A, B, C, ... until pool is empty
  const remaining = [...pool];
  let pickNum = 0;

  while (remaining.length > 0) {
    const teamIdx = pickNum % 3;
    const captain = captains[teamIdx];
    const captainName = captainNames[teamIdx];
    const totalPicks = pool.length;

    if (remaining.length === 1) {
      const last = remaining[0];
      teams[teamIdx].push(last);
      remaining.length = 0;
      const lastName = await getName(last);
      const autoEmbed = new EmbedBuilder()
        .setTitle('✅ Last Player Assigned')
        .setColor(0x00c853)
        .setDescription(`**${lastName}** was auto-assigned to Team ${String.fromCharCode(65 + teamIdx)} (Captain: <@${captain}>)`)
        .setTimestamp();
      await ch.send({ embeds: [autoEmbed], allowedMentions: { parse: [] } }).catch(() => {});
      break;
    }

    const remainingNames = await Promise.all(remaining.map(getName));
    const teamsDisplay = teams.map((t, i) =>
      `**Team ${String.fromCharCode(65 + i)}:** ${t.map(id => `<@${id}>`).join(', ')}`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`👑 Pick ${pickNum + 1}/${totalPicks} — ${captainName.slice(0, 25)}, pick a teammate`)
      .setColor(DARK_BLUE)
      .setDescription(`<@${captain}>, choose a player for **Team ${String.fromCharCode(65 + teamIdx)}**!\n*60 seconds — random if no response.*`)
      .addFields(
        { name: '🏟️ Teams So Far', value: teamsDisplay, inline: false },
        { name: '⏳ Available Players', value: remaining.map(id => `<@${id}>`).join('\n'), inline: false },
      )
      .setTimestamp();

    const buttonRows = [];
    for (let i = 0; i < remaining.length && buttonRows.length < 4; i += 5) {
      const chunk = remaining.slice(i, i + 5);
      buttonRows.push(new ActionRowBuilder().addComponents(
        chunk.map((id, j) =>
          new ButtonBuilder()
            .setCustomId(`captainpick|${match.id}|${captain}|${id}`)
            .setLabel(remainingNames[i + j].slice(0, 20))
            .setStyle(ButtonStyle.Primary)
        )
      ));
    }
    buttonRows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`captainpick|${match.id}|${captain}|close`)
        .setLabel('Skip (Host Only)')
        .setStyle(ButtonStyle.Danger)
    ));

    const msg = await ch.send({
      content: `<@${captain}>`,
      embeds: [embed],
      components: buttonRows,
      allowedMentions: { users: [captain] },
    }).catch(() => null);

    const draftKey = `captainpick|${match.id}|${captain}`;
    const picked = await new Promise(resolve => {
      if (!global._captainDraftResolvers) global._captainDraftResolvers = new Map();
      const timeout = setTimeout(() => {
        global._captainDraftResolvers.delete(draftKey);
        resolve(remaining[Math.floor(Math.random() * remaining.length)]);
      }, 60000);
      global._captainDraftResolvers.set(draftKey, (targetId) => {
        clearTimeout(timeout);
        global._captainDraftResolvers.delete(draftKey);
        resolve(targetId === '__skip__'
          ? remaining[Math.floor(Math.random() * remaining.length)]
          : targetId);
      });
    });

    const pickedIdx = remaining.indexOf(picked);
    const pickedName = remainingNames[pickedIdx] || `<@${picked}>`;
    teams[teamIdx].push(picked);
    remaining.splice(pickedIdx, 1);

    const resultEmbed = new EmbedBuilder()
      .setTitle('✅ Pick Made!')
      .setColor(0x00c853)
      .setDescription(`**Team ${String.fromCharCode(65 + teamIdx)}** (Captain <@${captain}>) picks **${pickedName}**`)
      .setTimestamp();
    if (msg) await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
    else await ch.send({ embeds: [resultEmbed], allowedMentions: { parse: [] } }).catch(() => {});

    pickNum++;
  }

  // Final team reveal
  const finalDisplay = teams.map((t, i) =>
    `**Team ${String.fromCharCode(65 + i)}:** ${t.map(id => `<@${id}>`).join(' & ')}`
  ).join('\n');
  const finalEmbed = new EmbedBuilder()
    .setTitle('✅ All Teams Formed!')
    .setColor(0x00c853)
    .setDescription(finalDisplay)
    .setTimestamp();
  await ch.send({ embeds: [finalEmbed], allowedMentions: { parse: [] } }).catch(() => {});

  return teams.length >= 2 ? teams : null;
}

// ── Bo3 vote ──────────────────────────────────────────────────────────────────
// Returns a promise that resolves when the 60s vote is done, with the result
async function postBo3Vote(client, match, { stepLabel = 'Step 1 of 2' } = {}) {
  if (!match.privateChannelId) return 'none';
  return new Promise(async (resolve) => {
    try {
      const ch = await client.channels.fetch(match.privateChannelId);
      const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${stepLabel} — Match Format Vote`)
        .setColor(DARK_BLUE)
        .setDescription('Vote on the match format! Poll ends in **60 seconds** or when host force-closes.')
        .addFields(
          { name: '🟢 Best of 3 (All)', value: 'Every match is Bo3', inline: true },
          { name: '🔵 Finals Only', value: 'Only the final is Bo3', inline: true },
          { name: '⚫ Standard (Bo1)', value: 'All matches single game', inline: true },
        ).setTimestamp();

      const voteId = `bo3|${match.id}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${voteId}|all`).setLabel('Bo3 All').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${voteId}|finals`).setLabel('Finals Only Bo3').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${voteId}|none`).setLabel('Standard Bo1').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${voteId}|close`).setLabel('Close Vote Now').setStyle(ButtonStyle.Danger),
      );

      const msg = await ch.send({ embeds: [embed], components: [row] });

      const data = db.get();
      if (!data.bo3votes) data.bo3votes = {};
      data.bo3votes[voteId] = { matchId: match.id, votes: {}, messageId: msg.id, channelId: match.privateChannelId, closed: false };
      db.set(data);

      const finish = async () => {
        const fresh = db.get();
        const vote = fresh.bo3votes?.[voteId];
        if (!vote) return resolve('none');
        vote.closed = true;
        const tally = { all: 0, finals: 0, none: 0 };
        for (const v of Object.values(vote.votes)) tally[v] = (tally[v] || 0) + 1;
        const winner = Object.entries(tally).sort(([, a], [, b]) => b - a)[0][0];
        if (fresh.matches[match.id]) { fresh.matches[match.id].bo3Mode = winner; }
        db.set(fresh);

        const labels = { all: 'Best of 3 (All Matches)', finals: 'Finals Only Bo3', none: 'Standard Bo1' };
        const resultEmbed = new EmbedBuilder()
          .setTitle('✅ Format Decided!').setColor(0x00c853)
          .setDescription(`**${labels[winner]}** wins!\nBo3 All: ${tally.all} | Finals: ${tally.finals} | Standard: ${tally.none}`)
          .setTimestamp();
        try { await msg.edit({ embeds: [resultEmbed], components: [] }); } catch {}
        resolve(winner);
      };

      // Store finish fn so close button can call it
      if (!global._bo3Finishers) global._bo3Finishers = new Map();
      global._bo3Finishers.set(voteId, finish);

      setTimeout(finish, 60000);
    } catch (e) { console.error('postBo3Vote error:', e.message); resolve('none'); }
  });
}

// ── Region vote ───────────────────────────────────────────────────────────────
async function postRegionVote(client, match, { stepLabel = 'Step 2 of 2' } = {}) {
  if (!match.privateChannelId) return 'NA';
  return new Promise(async (resolve) => {
    try {
      const ch = await client.channels.fetch(match.privateChannelId);
      const embed = new EmbedBuilder()
        .setTitle(`🌍 ${stepLabel} — Server Region Vote`)
        .setColor(DARK_BLUE)
        .setDescription('Vote on which server region to play on! Poll ends in **60 seconds** or when host force-closes.')
        .addFields(
          { name: '🌎 NA', value: 'North America', inline: true },
          { name: '🌏 AEST', value: 'Australia / Oceania', inline: true },
          { name: '🌍 GMT', value: 'Europe / UK', inline: true },
        ).setTimestamp();

      const voteId = `region|${match.id}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${voteId}|NA`).setLabel('🌎 NA').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${voteId}|AEST`).setLabel('🌏 AEST').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${voteId}|GMT`).setLabel('🌍 GMT').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${voteId}|close`).setLabel('Close Vote Now').setStyle(ButtonStyle.Danger),
      );

      const msg = await ch.send({ embeds: [embed], components: [row] });

      const data = db.get();
      if (!data.regionvotes) data.regionvotes = {};
      data.regionvotes[voteId] = { matchId: match.id, votes: {}, messageId: msg.id, channelId: match.privateChannelId, closed: false };
      db.set(data);

      const finish = async () => {
        const fresh = db.get();
        const vote = fresh.regionvotes?.[voteId];
        if (!vote) return resolve('NA');
        vote.closed = true;
        const tally = { NA: 0, AEST: 0, GMT: 0 };
        for (const v of Object.values(vote.votes)) tally[v] = (tally[v] || 0) + 1;
        const winner = Object.entries(tally).sort(([, a], [, b]) => b - a)[0][0];
        if (fresh.matches[match.id]) { fresh.matches[match.id].region = winner; }
        db.set(fresh);

        const flags = { NA: '🌎', AEST: '🌏', GMT: '🌍' };
        const resultEmbed = new EmbedBuilder()
          .setTitle('✅ Region Decided!').setColor(0x00c853)
          .setDescription(`Playing on **${flags[winner]} ${winner}**!\nNA: ${tally.NA} | AEST: ${tally.AEST} | GMT: ${tally.GMT}`)
          .setTimestamp();
        try { await msg.edit({ embeds: [resultEmbed], components: [] }); } catch {}
        resolve(winner);
      };

      if (!global._regionFinishers) global._regionFinishers = new Map();
      global._regionFinishers.set(voteId, finish);

      setTimeout(finish, 60000);
    } catch (e) { console.error('postRegionVote error:', e.message); resolve('NA'); }
  });
}

// ── Start bracket ─────────────────────────────────────────────────────────────
async function startCheckIn(client, matchId) {
  const data = db.get();
  const match = data.matches[matchId];
  if (!match || match.status !== 'queuing') return;

  const minPlayers = getMinPlayers(match);
  if (match.queue.length < minPlayers) {
    try {
      const ch = await client.channels.fetch(match.channelId);
      const msg = await ch.messages.fetch(match.messageId);
      await msg.edit({
        embeds: [new EmbedBuilder().setTitle('❌ Match Cancelled').setColor(0xff0000)
          .setDescription(`Queue cancelled: not enough players joined.\n\nNeed **${minPlayers}** players, but only **${match.queue.length}** joined.`)],
        components: [],
      });
    } catch {}
    delete data.matches[matchId];
    db.set(data);
    return;
  }

  const privateChannel = await createMatchChannel(client, match);
  if (!privateChannel) {
    try {
      const ch = await client.channels.fetch(match.channelId);
      const msg = await ch.messages.fetch(match.messageId);
      await msg.edit({
        embeds: [new EmbedBuilder().setTitle('Match Error').setColor(0xff0000)
          .setDescription('Could not create the match channel. Check the bot channel permissions and category permissions.')],
        components: [],
      });
    } catch {}
    delete data.matches[matchId];
    db.set(data);
    return;
  }
  match.status = 'checking';
  match.checkIns = {};
  match.checkInEndsAt = Date.now() + CHECKIN_DURATION_MS;
  match.privateChannelId = privateChannel.id;

  try {
    const ch = await client.channels.fetch(match.channelId);
    const msg = await ch.messages.fetch(match.messageId);
    await msg.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle('Match Check-In Started')
          .setColor(DARK_BLUE)
          .setDescription(`Check in here: <#${privateChannel.id}>`)
          .setTimestamp(),
      ],
      components: [],
    });
  } catch {}

  try {
    const checkInMessage = await privateChannel.send({
      content: match.queue.map(id => `<@${id}>`).join(' '),
      embeds: [buildCheckInEmbed(match)],
      components: makeCheckInRows(matchId),
      allowedMentions: { users: match.queue },
    });
    match.checkInMessageId = checkInMessage.id;
  } catch {}

  data.matches[matchId] = match;
  db.set(data);

  for (const playerId of match.queue) {
    await dmUser(client, playerId,
      `Check-in is open for Match #${match.matchNum ?? '?'} (${match.type.toUpperCase()}). Go to <#${privateChannel.id}> and press **Check In**.`
    );
  }

  let reminderCount = 0;
  const interval = setInterval(async () => {
    const fresh = db.get();
    const current = fresh.matches?.[matchId];
    if (!current || current.status !== 'checking') { clearInterval(interval); return; }
    reminderCount++;
    const missing = (current.queue || []).filter(id => !current.checkIns?.[id]);
    try {
      const ch = await client.channels.fetch(current.privateChannelId || current.channelId);
      if (missing.length) {
        await ch.send({
          content: `${missing.map(id => `<@${id}>`).join(' ')} please check in for Match #${current.matchNum ?? '?'}.`,
          allowedMentions: { users: missing },
        });
      }
      const msg = await ch.messages.fetch(current.checkInMessageId || current.messageId);
      await msg.edit({ content: null, embeds: [buildCheckInEmbed(current)], components: makeCheckInRows(matchId) });
    } catch {}
    if (reminderCount >= 5) {
      clearInterval(interval);
      await startBracket(client, matchId);
    }
  }, 60 * 1000);

  const timer = setTimeout(async () => {
    clearInterval(interval);
    await startBracket(client, matchId);
  }, CHECKIN_DURATION_MS);

  timers.set(matchId, { ...(timers.get(matchId) || {}), checkinTimer: timer, checkinInterval: interval });
}

async function startVotesFromSeedPreview(client, matchId) {
  const data = db.get();
  const match = data.matches?.[matchId];
  if (!match || !match.bracket?.length || !['seeding', 'bracket'].includes(match.status)) return false;
  const alreadyConfirmed = Boolean(match.seedPreviewConfirmed);

  match.status = 'bracket';
  match.seedPreviewConfirmed = true;
  data.matches[matchId] = match;
  db.set(data);

  try {
    const ch = await client.channels.fetch(match.seedPreviewChannelId);
    const msg = await ch.messages.fetch(match.seedPreviewMessageId);
    await msg.edit({ components: [] });
  } catch {}

  const freshData = db.get();
  const freshMatch = freshData.matches[matchId];
  if (!freshMatch?.bracket?.length) return false;
  await postOrUpdateBracket(client, freshMatch);

  if (!freshMatch.vcChannelId) {
    const vc = await createMatchVoiceChannel(client, freshMatch);
    if (vc) {
      freshMatch.vcChannelId = vc.id;
      const vcData = db.get();
      if (vcData.matches[matchId]) vcData.matches[matchId].vcChannelId = vc.id;
      db.set(vcData);
      if (freshMatch.privateChannelId) {
        try {
          const guild = await client.guilds.fetch(freshMatch.guildId);
          const vcPlayers = [];
          for (const playerId of freshMatch.queue) {
            const member = await guild.members.fetch(playerId).catch(() => null);
            if (member?.roles.cache.has(SCREENSHARE_ROLE_ID)) vcPlayers.push(playerId);
          }
          if (vcPlayers.length) {
            const ch = await client.channels.fetch(freshMatch.privateChannelId);
            await ch.send({
              content: `${vcPlayers.map(id => `<@${id}>`).join(' ')} — Join <#${vc.id}> and **enable screenshare** before your match starts! ⚠️ You have **${SCREENSHARE_DQ_MINUTES} minutes** to join or you'll be **auto-DQ'd**.`,
              allowedMentions: { users: vcPlayers },
            });
          }
        } catch (e) { console.error('VC notification error:', e.message); }
      }
      scheduleScreenshareCheck(client, matchId, vc.id);
    }
  }

  if (alreadyConfirmed) return true;

  for (let i = 0; i < freshMatch.bracket[0].length; i++) {
    const bm = freshMatch.bracket[0][i];
    if (!bm.bye && bm.p1 && bm.p2) await postPredictionPoll(client, freshMatch, bm, 0, i);
  }

  for (let i = 0; i < freshMatch.bracket[0].length; i++) {
    if (!freshMatch.bracket[0][i].bye) scheduleMatchReminder(client, freshMatch, matchId, i, 0);
  }

  return true;
}

async function reshuffleSeedPreview(client, matchId) {
  const data = db.get();
  const match = data.matches?.[matchId];
  if (!match || match.status !== 'seeding') return false;

  const eloData = getEloData(data);
  generateMatchBracket(match, eloData, true);
  try {
    const guild = await client.guilds.fetch(match.guildId);
    if (match.type === '1v1') await fetchDisplayNames(guild, match.bracket[0]);
  } catch {}
  match.seedPreviewReshuffles = (match.seedPreviewReshuffles || 0) + 1;
  data.matches[matchId] = match;
  db.set(data);
  const msg = await postSeedPreview(client, match);
  if (msg) {
    match.seedPreviewMessageId = msg.id;
    match.seedPreviewChannelId = msg.channelId;
  }
  data.matches[matchId] = match;
  db.set(data);
  return true;
}

async function startBracket(client, matchId) {
  const data = db.get();
  const match = data.matches[matchId];
  if (!match) return;
  if (match.status === 'queuing') return startCheckIn(client, matchId);
  if (match.status === 'seeding') return startVotesFromSeedPreview(client, matchId);
  if (match.status !== 'checking') return;

  const minPlayers = getMinPlayers(match);
  const missingCheckIns = (match.queue || []).filter(id => !match.checkIns?.[id]);
  match.queue = (match.queue || []).filter(id => match.checkIns?.[id]);
  match.checkInDqs = missingCheckIns;
  if (match.queue.length < minPlayers) {
    try {
      const ch = await client.channels.fetch(match.privateChannelId || match.channelId);
      const msg = await ch.messages.fetch(match.checkInMessageId || match.messageId);
      await msg.edit({
        embeds: [new EmbedBuilder().setTitle('Match Cancelled').setColor(0xff0000)
          .setDescription(`Check-in failed: not enough players checked in.\n\nNeed **${minPlayers}**, but only **${match.queue.length}** checked in.\n\nDQ'd for missing check-in:\n${missingCheckIns.map(id => `<@${id}>`).join('\n') || 'None'}`)],
        components: [],
      });
    } catch {}
    await sendStaffAuditLog(client, match.guildId, 'Auto-DQ Check-In Failed', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Checked In', value: String(match.queue.length), inline: true },
      { name: 'DQ Players', value: missingCheckIns.map(id => `<@${id}>`).join('\n') || 'None', inline: false },
    ]);
    const t = timers.get(matchId);
    if (t) {
      clearTimeout(t.timer);
      clearInterval(t.interval);
      clearTimeout(t.checkinTimer);
      clearInterval(t.checkinInterval);
      timers.delete(matchId);
    }
    if (match.privateChannelId) scheduleChannelDelete(client, match.privateChannelId, match.vcChannelId || null, match.announcementsChannelId || null);
    delete data.matches[matchId];
    db.set(data);
    return;
  }

  const activeTimers = timers.get(matchId);
  if (activeTimers) {
    clearTimeout(activeTimers.timer);
    clearInterval(activeTimers.interval);
    clearTimeout(activeTimers.checkinTimer);
    clearInterval(activeTimers.checkinInterval);
    timers.delete(matchId);
  }

  match.status = 'bracket';
  data.matches[matchId] = match;
  db.set(data);

  const eloData = getEloData(data);
  try {
    if (match.privateChannelId && match.checkInMessageId) {
      const ch = await client.channels.fetch(match.privateChannelId);
      const msg = await ch.messages.fetch(match.checkInMessageId);
      await msg.edit({ content: null, embeds: [buildCheckInEmbed(match)], components: [] });
    }
  } catch {}
  if (missingCheckIns.length) {
    await sendStaffAuditLog(client, match.guildId, 'Auto-DQ Missing Check-In', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'DQ Players', value: missingCheckIns.map(id => `<@${id}>`).join('\n'), inline: false },
      { name: 'Bracket Players', value: match.queue.map(id => `<@${id}>`).join('\n') || 'None', inline: false },
    ]);
    try {
      const ch = await client.channels.fetch(match.privateChannelId || match.channelId);
      await ch.send({
        content: `Auto-DQ for missing check-in: ${missingCheckIns.map(id => `<@${id}>`).join(' ')}`,
        allowedMentions: { users: missingCheckIns },
      });
    } catch {}
  }

  let ranTeamVote = false;
  if (match.type === '2v2' && !match.testMatch) {
    const preformedSet = new Set((match.preformedTeams || []).flat());
    const allCovered = (match.queue || []).every(id => preformedSet.has(id));
    if (!allCovered) {
      ranTeamVote = true;
      const teamFmt = await postTeamFormatVote(client, match);
      if (teamFmt === 'pick') {
        const freshForDraft = db.get();
        const matchForDraft = freshForDraft.matches?.[matchId];
        if (matchForDraft) {
          const drafted = await postTeamDraft(client, matchForDraft);
          if (drafted) {
            match.draftedTeams = drafted;
            const d = db.get();
            if (d.matches[matchId]) d.matches[matchId].draftedTeams = drafted;
            db.set(d);
          }
        }
      }

      // If there's an odd number of unpaired players, one must sit out
      const preformedSetFinal = new Set((match.preformedTeams || []).flat());
      const unpairedFinal = (match.queue || []).filter(id => !preformedSetFinal.has(id));
      if (unpairedFinal.length % 2 !== 0) {
        let sittingOut;
        let sitOutReason;
        if (teamFmt === 'pick' && match.draftedTeams?.length) {
          const draftedSet = new Set(match.draftedTeams.flat());
          sittingOut = unpairedFinal.find(id => !draftedSet.has(id));
          sitOutReason = 'was not picked during team selection and will not play in this match';
        } else {
          sittingOut = unpairedFinal[Math.floor(Math.random() * unpairedFinal.length)];
          sitOutReason = 'was randomly selected to sit out (odd number of players) and will not play in this match';
        }
        if (sittingOut) {
          match.queue = match.queue.filter(id => id !== sittingOut);
          try {
            const ch = await client.channels.fetch(match.privateChannelId).catch(() => null);
            if (ch) await ch.send(`⚠️ <@${sittingOut}> ${sitOutReason}.`).catch(() => {});
          } catch {}
        }
      }
    }
  } else if (match.type === '3v3' && !match.testMatch) {
    // Remove excess players until queue is divisible by 3
    const excess = match.queue.length % 3;
    if (excess !== 0) {
      const pool = shuffleItems([...match.queue]);
      for (let i = 0; i < excess; i++) {
        const sittingOut = pool.pop();
        match.queue = match.queue.filter(id => id !== sittingOut);
        try {
          const ch = await client.channels.fetch(match.privateChannelId).catch(() => null);
          if (ch) await ch.send(`⚠️ <@${sittingOut}> was randomly selected to sit out (player count not divisible by 3) and will not play in this match.`).catch(() => {});
        } catch {}
      }
    }

    // Prompt host to choose team formation mode
    ranTeamVote = true;
    const captainMode = await postCaptainModePrompt(client, match);
    if (captainMode === 'captains') {
      const freshForCaptains = db.get();
      const matchForCaptains = freshForCaptains.matches?.[matchId];
      if (matchForCaptains) {
        const draftedTeams = await postCaptainDraft(client, matchForCaptains);
        if (draftedTeams) {
          match.draftedTeams = draftedTeams;
          const d = db.get();
          if (d.matches[matchId]) d.matches[matchId].draftedTeams = draftedTeams;
          db.set(d);
        }
      }
    }
  }

  generateMatchBracket(match, eloData);
  match.eloStart = {};
  for (const playerId of match.queue) {
    match.eloStart[playerId] = getPlayerElo(eloData, playerId).elo;
  }

  try {
    const guild = await client.guilds.fetch(match.guildId);
    if (match.type === '1v1') await fetchDisplayNames(guild, match.bracket[0]);
  } catch {}

  data.matches[matchId] = match;
  db.set(data);

  const privateChannel = match.privateChannelId
    ? await client.channels.fetch(match.privateChannelId).catch(() => null)
    : await createMatchChannel(client, match);
  if (!privateChannel) return;

  match.privateChannelId = privateChannel.id;

  if (!match.announcementsChannelId) {
    const announcementsChannel = await createAnnouncementsChannel(client, match);
    if (announcementsChannel) match.announcementsChannelId = announcementsChannel.id;
  }

  data.matches[matchId] = match;
  db.set(data);

  (async () => {
    for (const playerId of match.queue) {
      await dmUser(client, playerId,
        `**Your match has started!** Go to <#${privateChannel.id}>`
      );
    }

    try {
      const ch = await client.channels.fetch(match.channelId);
      const msg = await ch.messages.fetch(match.messageId);
      const startEmbed = new EmbedBuilder()
        .setTitle('Match Started!')
        .setColor(DARK_BLUE)
        .setDescription(`**${match.queue.length} players** locked in!\n\nGo to <#${privateChannel.id}>`)
        .setTimestamp();
      if (match.prize) startEmbed.addFields({ name: 'Prize', value: `**${match.prize}**` });
      startEmbed.addFields({
        name: 'Queue Status',
        value: 'Queue started. Use `/spectate` if you want to spectate the match.',
        inline: false,
      });
      await ch.send({
        content: `${match.queue.map(id => `<@${id}>`).join(' ')}\nMatch started. Head to <#${privateChannel.id}>.`,
        allowedMentions: { parse: ['users'] },
      });
      await msg.edit({
        embeds: [startEmbed],
        components: [],
      });
    } catch {}
  })().catch(error => console.error('match start notification failed:', error.message));

  await postBo3Vote(client, match, { stepLabel: ranTeamVote ? 'Step 2 of 3' : 'Step 1 of 2' });
  await postRegionVote(client, match, { stepLabel: ranTeamVote ? 'Step 3 of 3' : 'Step 2 of 2' });

  const seededData = db.get();
  const seededMatch = seededData.matches[matchId];
  if (!seededMatch) return;
  seededMatch.status = 'seeding';
  seededData.matches[matchId] = seededMatch;
  db.set(seededData);

  const previewMessage = await postSeedPreview(client, seededMatch, { allowChannelFallback: true });
  if (previewMessage) {
    seededMatch.seedPreviewMessageId = previewMessage.id;
    seededMatch.seedPreviewChannelId = previewMessage.channelId;
    seededData.matches[matchId] = seededMatch;
    db.set(seededData);
  }
}

// ── Slash command ─────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('creatematch')
    .setDescription('Create a match queue')
    .addStringOption(o => o.setName('type').setDescription('Match type').setRequired(true)
      .addChoices({ name: '1v1', value: '1v1' }, { name: '2v2', value: '2v2' }, { name: '3v3', value: '3v3' }))
    .addStringOption(o => o.setName('prize').setDescription('Prize for the winner').setRequired(false))
    .addBooleanOption(o => o.setName('test_match').setDescription('Lower the player minimum so staff can test brackets').setRequired(false)),

  async autocomplete(interaction) {
    await interaction.respond([]);
  },

  async execute(interaction, helpers = {}) {
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to create matches.', flags: 64 });
    const existingData = db.get();
    if (!existingData.eloLeaderboards?.[interaction.guildId]) {
      return interaction.reply({ content: 'No scoreboard found, cant run match. Create one with `/eloleaderboard` first.', flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });

    const type = interaction.options.getString('type');
    const prize = interaction.options.getString('prize') || null;
    const testMatch = interaction.options.getBoolean('test_match') || false;
    const matchNum = helpers?.getNextMatchNumber?.(interaction.guildId) ?? 0;
    const matchId = `match-${interaction.guildId}-${Date.now()}`;
    const endsAt = Date.now() + QUEUE_DURATION_MS;

    const match = {
      id: matchId, guildId: interaction.guildId, channelId: interaction.channelId,
      type, scoreboardName: null, prize, queue: [], status: 'queuing',
      endsAt, bracket: [], currentRound: 0, messageId: null,
      privateChannelId: null, bracketMessageId: null, hostId: interaction.user.id,
      matchNum, teams: null, bo3Mode: 'none', region: null, testMatch,
    };

    const joinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
      new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
      new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
    );

    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cancel_queue_${matchId}`).setLabel('Cancel Queue').setStyle(ButtonStyle.Danger),
    );

    const data = db.get();
    if (!data.matches) data.matches = {};
    data.matches[matchId] = match;
    db.set(data);
    await sendStaffAuditLog(interaction.client, interaction.guildId, 'Match Queue Created', [
      { name: 'Match', value: `#${match.matchNum ?? '?'}\n\`${match.id}\``, inline: true },
      { name: 'Type', value: match.type.toUpperCase(), inline: true },
      { name: 'Test Match', value: testMatch ? 'Yes' : 'No', inline: true },
    ], interaction.user.id);

    const queueMessage = await interaction.channel.send({
      content: testMatch ? null : `<@&${MATCH_PING_ROLE_ID}>`,
      embeds: [buildQueueEmbed(match)],
      components: [joinRow, cancelRow],
      allowedMentions: testMatch ? { parse: [] } : { roles: [MATCH_PING_ROLE_ID] },
    });
    match.messageId = queueMessage.id;
    await interaction.editReply({ content: `Match #${match.matchNum ?? '?'} queue created in <#${interaction.channelId}>.` });

    const savedData = db.get();
    if (!savedData.matches) savedData.matches = {};
    savedData.matches[matchId] = match;
    db.set(savedData);

    const intervalId = setInterval(async () => {
      const fresh = db.get();
      const m = fresh.matches?.[matchId];
      if (!m || m.status !== 'queuing') { clearInterval(intervalId); return; }
      try {
        const ch = await interaction.client.channels.fetch(m.channelId);
        const ms = await ch.messages.fetch(m.messageId);
        await ms.edit({ embeds: [buildQueueEmbed(m)], components: [joinRow, cancelRow] });
      } catch {}
    }, 30000);

    const timer = setTimeout(async () => {
      clearInterval(intervalId);
      await startBracket(interaction.client, matchId);
    }, QUEUE_DURATION_MS);

    timers.set(matchId, { timer, interval: intervalId });
  },

  // Exports
  buildBracketTextEmbed, buildBracketComponents, buildQueueEmbed, buildQueueCancelledEmbed,
  buildCheckInEmbed, makeCheckInRows,
  buildNextRound, fetchDisplayNames, makeBracketAttachment,
  postOrUpdateBracket, startBracket, scheduleChannelDelete,
  timers, canManageMatch, logMatchResult, MATCH_MANAGER_ROLES, DEFAULT_LOG_CHANNEL_ID, MATCH_PING_ROLE_ID,
  postPredictionPoll, revealPrediction, scheduleMatchReminder,
  matchReminderTimers, dmUser, getMinPlayers,
  startVotesFromSeedPreview, reshuffleSeedPreview,
  postTeamFormatVote, postTeamDraft, postCaptainModePrompt, postCaptainDraft,
  createMatchVoiceChannel, scheduleScreenshareCheck, SCREENSHARE_ROLE_ID, SCREENSHARE_DQ_MINUTES,
  postSeedPreview, sendMatchAnnouncement, pairIntoTrios, createAnnouncementsChannel,
};


// Queue status announcements patch
async function announceQueueStarted(interaction, match) {
  try {
    const startedEmbed = new EmbedBuilder()
      .setTitle('✅ Queue Started')
      .setDescription(
        'The queue has started and players have been moved into the match channel.\n\nUse `/spectate` if you want to spectate the match.'
      )
      .setColor(0x57F287)
      .setTimestamp();

    await interaction.channel.send({
      content: match.queue.map(id => `<@${id}>`).join(' '),
      embeds: [startedEmbed],
      allowedMentions: { parse: ['users'] }
    });
  } catch (err) {
    console.error('Failed to announce queue start:', err);
  }
}

async function announceQueueCancelled(interaction, match) {
  try {
    const cancelledEmbed = new EmbedBuilder()
      .setTitle('❌ Queue Cancelled')
      .setDescription('The queue was cancelled before the match started.')
      .setColor(0xED4245)
      .setTimestamp();

    await interaction.channel.send({
      content: match.queue?.map(id => `<@${id}>`).join(' ') || '',
      embeds: [cancelledEmbed],
      allowedMentions: { parse: ['users'] }
    });
  } catch (err) {
    console.error('Failed to announce queue cancellation:', err);
  }
}
