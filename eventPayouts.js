const { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('./database');
const { saveToDiscord } = require('./discordBackup');
const { getRobloxLinks, lookupRobloxUser, STAFF_ROLE_IDS } = require('./robloxSync');

const DEFAULT_EVENT_LOG_CHANNEL_ID = process.env.EVENT_LOG_CHANNEL_ID || '1511889756773027862';
const DEFAULT_PAYOUT_REPORT_CHANNEL_ID = process.env.PAYOUT_REPORT_CHANNEL_ID || '1511890235011764305';

const COORDINATOR_RANKS = {
  junior: {
    label: 'Junior Coordinator',
    payPerEvent: 15,
    discordRoleId: process.env.JUNIOR_COORDINATOR_ROLE_ID || '1333145733968302163',
    robloxRoleId: STAFF_ROLE_IDS.trial_coordinator,
  },
  coordinator: {
    label: 'Coordinator',
    payPerEvent: 20,
    discordRoleId: process.env.COORDINATOR_ROLE_ID || '1333145733968302164',
    robloxRoleId: STAFF_ROLE_IDS.coordinator,
  },
  senior: {
    label: 'Senior Coordinator',
    payPerEvent: 25,
    discordRoleId: process.env.SENIOR_COORDINATOR_ROLE_ID || '1333145733968302162',
    robloxRoleId: STAFF_ROLE_IDS.senior_coordinator,
  },
};

function getGuildPayoutStore(data, guildId) {
  if (!data.eventPayouts) data.eventPayouts = {};
  if (!data.eventPayouts[guildId]) {
    data.eventPayouts[guildId] = {
      events: [],
      hostRanks: {},
      monthlyReports: {},
    };
  }
  return data.eventPayouts[guildId];
}

function getGuildSettings(data, guildId) {
  if (!data.settings) data.settings = {};
  if (!data.settings[guildId]) data.settings[guildId] = {};
  return data.settings[guildId];
}

function getEventLogChannelId(data, guildId) {
  return getGuildSettings(data, guildId).eventLogChannelId || DEFAULT_EVENT_LOG_CHANNEL_ID;
}

function getPayoutReportChannelId(data, guildId) {
  return getGuildSettings(data, guildId).payoutReportChannelId || DEFAULT_PAYOUT_REPORT_CHANNEL_ID;
}

function hasPayoutPermission(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  const data = db.get();
  const settings = getGuildSettings(data, interaction.guildId);
  const allowedRoles = new Set([
    ...(settings.matchManagerRoles || []),
    ...(settings.payoutAdminRoles || []),
  ]);
  return interaction.member?.roles?.cache?.some(role => allowedRoles.has(role.id)) || false;
}

function normalizeMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new Error('Month must use YYYY-MM format.');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new Error('Month must use YYYY-MM format.');
  return `${year}-${String(monthNumber).padStart(2, '0')}`;
}

function getPreviousMonth(date = new Date()) {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

function eventIsInMonth(event, month) {
  const date = new Date(event.timestamp || event.createdAt || Date.now());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` === month;
}

function makeEventId(guildId) {
  return `event-${guildId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueAttendeeCount(match) {
  return new Set([
    ...(match.queue || []),
    ...((match.teams || []).flat ? match.teams.flat() : []),
  ].filter(Boolean)).size;
}

function getManualRank(data, guildId, discordUserId) {
  const store = getGuildPayoutStore(data, guildId);
  return store.hostRanks?.[discordUserId] || null;
}

function getRankFromMember(member, manualRank) {
  if (manualRank && COORDINATOR_RANKS[manualRank]) return manualRank;
  if (!member) return null;
  if (member.roles.cache.has(COORDINATOR_RANKS.senior.discordRoleId)) return 'senior';
  if (member.roles.cache.has(COORDINATOR_RANKS.coordinator.discordRoleId)) return 'coordinator';
  if (member.roles.cache.has(COORDINATOR_RANKS.junior.discordRoleId)) return 'junior';
  return null;
}

function formatRank(rank) {
  return COORDINATOR_RANKS[rank]?.label || 'Missing rank';
}

async function resolveRobloxLink(client, guildId, discordUserId, robloxInput) {
  const data = db.get();
  const links = getRobloxLinks(data, guildId);
  if (!robloxInput && links[discordUserId]) return links[discordUserId];

  if (!robloxInput) return links[discordUserId] || null;

  const resolved = /^\d+$/.test(String(robloxInput))
    ? { robloxUserId: String(robloxInput), robloxUsername: String(robloxInput) }
    : await lookupRobloxUser(robloxInput);

  links[discordUserId] = {
    robloxUserId: String(resolved.robloxUserId),
    robloxUsername: resolved.robloxUsername,
    linkedAt: Date.now(),
  };
  db.set(data);
  if (client) await saveToDiscord(client).catch(error => console.error('saveToDiscord setroblox failed:', error.message));
  return links[discordUserId];
}

async function saveEventRecord(client, guildId, event) {
  const data = db.get();
  const store = getGuildPayoutStore(data, guildId);
  const existingIndex = store.events.findIndex(item => item.id === event.id);
  const now = Date.now();
  const record = {
    id: event.id || makeEventId(guildId),
    guildId,
    hostId: event.hostId || null,
    robloxUsername: event.robloxUsername || null,
    robloxUserId: event.robloxUserId ? String(event.robloxUserId) : null,
    prize: event.prize || null,
    attendees: Number.isFinite(Number(event.attendees)) ? Number(event.attendees) : null,
    timestamp: event.timestamp || now,
    source: event.source || 'manual',
    matchId: event.matchId || null,
    createdAt: event.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex >= 0) store.events[existingIndex] = record;
  else store.events.unshift(record);
  db.set(data);
  if (client) await saveToDiscord(client).catch(error => console.error('saveToDiscord event record failed:', error.message));
  return record;
}

async function sendEventLog(client, guildId, event) {
  const data = db.get();
  const channelId = getEventLogChannelId(data, guildId);
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  const store = getGuildPayoutStore(data, guildId);
  const totalHosted = event.hostId
    ? store.events.filter(item => item.hostId === event.hostId).length
    : 0;

  const embed = new EmbedBuilder()
    .setTitle('Event Host Logged')
    .setColor(0x1f4fd8)
    .addFields(
      { name: 'Host', value: event.hostId ? `<@${event.hostId}>` : 'Missing host', inline: true },
      { name: 'Roblox', value: event.robloxUserId ? `${event.robloxUsername || event.robloxUserId} (${event.robloxUserId})` : 'Missing Roblox ID', inline: true },
      { name: 'Prize', value: event.prize || 'Missing prize', inline: true },
      { name: 'Attendees', value: event.attendees == null ? 'Missing attendance' : String(event.attendees), inline: true },
      { name: 'Total Hosted', value: event.hostId ? String(totalHosted) : 'Unknown', inline: true },
      { name: 'Source', value: event.matchId ? `Match ${event.matchId}` : event.source || 'manual', inline: true },
    )
    .setTimestamp(event.timestamp || Date.now());

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(error => {
    console.error('Event log send failed:', error.message);
  });
}

async function recordHostedEventFromMatch(client, match) {
  if (!match?.guildId || !match?.hostId || !match?.id) return null;
  const data = db.get();
  const store = getGuildPayoutStore(data, match.guildId);
  const existing = store.events.find(event => event.matchId === match.id);
  if (existing) return existing;

  const link = getRobloxLinks(data, match.guildId)[match.hostId] || null;
  const event = await saveEventRecord(client, match.guildId, {
    hostId: match.hostId,
    robloxUsername: link?.robloxUsername || null,
    robloxUserId: link?.robloxUserId || null,
    prize: match.prize || null,
    attendees: uniqueAttendeeCount(match),
    timestamp: Date.now(),
    source: 'match',
    matchId: match.id,
  });
  await sendEventLog(client, match.guildId, event);
  return event;
}

async function buildMonthlyPayout(client, guildId, month) {
  const normalizedMonth = normalizeMonth(month);
  const data = db.get();
  const store = getGuildPayoutStore(data, guildId);
  const links = getRobloxLinks(data, guildId);
  const events = store.events.filter(event => eventIsInMonth(event, normalizedMonth));
  const byHost = new Map();
  const warnings = [];

  for (const event of events) {
    if (!event.hostId) warnings.push(`Event ${event.id} is missing host.`);
    if (!event.prize) warnings.push(`Event ${event.id} is missing prize.`);
    if (event.attendees == null) warnings.push(`Event ${event.id} is missing attendance count.`);
    if (!event.hostId) continue;

    const current = byHost.get(event.hostId) || {
      discordUserId: event.hostId,
      robloxUsername: event.robloxUsername || links[event.hostId]?.robloxUsername || null,
      robloxUserId: event.robloxUserId || links[event.hostId]?.robloxUserId || null,
      eventsHosted: 0,
      eventIds: [],
    };
    current.eventsHosted += 1;
    current.eventIds.push(event.id);
    if (!current.robloxUserId && links[event.hostId]?.robloxUserId) current.robloxUserId = links[event.hostId].robloxUserId;
    if (!current.robloxUsername && links[event.hostId]?.robloxUsername) current.robloxUsername = links[event.hostId].robloxUsername;
    byHost.set(event.hostId, current);
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const rows = [];

  for (const row of byHost.values()) {
    const member = guild ? await guild.members.fetch(row.discordUserId).catch(() => null) : null;
    const rank = getRankFromMember(member, getManualRank(data, guildId, row.discordUserId));
    const payPerEvent = COORDINATOR_RANKS[rank]?.payPerEvent || 0;
    row.rank = rank;
    row.rankLabel = formatRank(rank);
    row.payPerEvent = payPerEvent;
    row.totalPay = row.eventsHosted * payPerEvent;

    if (!row.robloxUserId) warnings.push(`<@${row.discordUserId}> is missing Roblox ID.`);
    if (!rank) warnings.push(`<@${row.discordUserId}> is missing coordinator rank/pay role.`);
    rows.push(row);
  }

  rows.sort((a, b) => b.totalPay - a.totalPay || b.eventsHosted - a.eventsHosted || a.discordUserId.localeCompare(b.discordUserId));
  return { month: normalizedMonth, events, rows, warnings };
}

function buildPayoutCsv(rows) {
  return rows
    .filter(row => row.robloxUserId && row.totalPay > 0)
    .map(row => `${row.robloxUserId},${row.totalPay}`)
    .join('\n');
}

function buildPayoutEmbed(result) {
  const lines = result.rows.map(row => {
    return `<@${row.discordUserId}> | ${row.robloxUserId || 'Missing ID'} | ${row.rankLabel} | ${row.eventsHosted} events | ${row.payPerEvent} Robux/event | ${row.totalPay} Robux`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Event Host Payouts - ${result.month}`)
    .setColor(0x1f4fd8)
    .setDescription(lines.length ? lines.slice(0, 20).join('\n') : 'No hosted events found for this month.')
    .addFields(
      { name: 'Events Tracked', value: String(result.events.length), inline: true },
      { name: 'Hosts', value: String(result.rows.length), inline: true },
      { name: 'CSV Rows', value: String(result.rows.filter(row => row.robloxUserId && row.totalPay > 0).length), inline: true },
    )
    .setTimestamp();

  if (result.warnings.length) {
    embed.addFields({
      name: 'Warnings',
      value: result.warnings.slice(0, 12).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

async function sendMonthlyPayoutReport(client, guildId, month, { markAutoRun = false } = {}) {
  const result = await buildMonthlyPayout(client, guildId, month);
  const csv = buildPayoutCsv(result.rows);
  const filename = `event_payouts_${result.month}.csv`;
  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: filename });

  const data = db.get();
  const channelId = getPayoutReportChannelId(data, guildId);
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error(`Payout report channel ${channelId} was not found.`);

  await channel.send({
    embeds: [buildPayoutEmbed(result)],
    files: [attachment],
    allowedMentions: { parse: [] },
  });

  if (markAutoRun) {
    const fresh = db.get();
    const store = getGuildPayoutStore(fresh, guildId);
    store.monthlyReports[result.month] = { autoRanAt: Date.now(), channelId };
    db.set(fresh);
  }

  return { ...result, csv, filename, channelId };
}

function scheduleMonthlyEventPayouts(client, guildIds) {
  const run = async () => {
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const month = getPreviousMonth(now);
    for (const guildId of guildIds()) {
      const data = db.get();
      const store = getGuildPayoutStore(data, guildId);
      if (store.monthlyReports?.[month]?.autoRanAt) continue;
      try {
        await sendMonthlyPayoutReport(client, guildId, month, { markAutoRun: true });
      } catch (error) {
        console.error(`Monthly event payout failed for ${guildId}:`, error.message);
      }
    }
  };

  setTimeout(run, 30 * 1000);
  return setInterval(run, 60 * 60 * 1000);
}

module.exports = {
  COORDINATOR_RANKS,
  DEFAULT_EVENT_LOG_CHANNEL_ID,
  DEFAULT_PAYOUT_REPORT_CHANNEL_ID,
  getGuildPayoutStore,
  getGuildSettings,
  hasPayoutPermission,
  normalizeMonth,
  getPreviousMonth,
  resolveRobloxLink,
  saveEventRecord,
  sendEventLog,
  recordHostedEventFromMatch,
  buildMonthlyPayout,
  buildPayoutCsv,
  sendMonthlyPayoutReport,
  scheduleMonthlyEventPayouts,
};
