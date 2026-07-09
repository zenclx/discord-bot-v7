const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const {
  COORDINATOR_RANKS,
  getGuildPayoutStore,
  hasPayoutPermission,
  resolveRobloxLink,
  saveEventRecord,
  sendEventLog,
  syncCoordinatorRanks,
} = require('../eventPayouts');
const { getRobloxLinks } = require('../robloxSync');

function parseDateInput(value) {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error('Invalid date. Use something like 2026-06-15 or 2026-06-15 8:30 PM.');
  return parsed;
}

function eventLine(event) {
  const date = new Date(event.timestamp).toISOString().slice(0, 10);
  return `\`${event.id}\` | ${event.hostId ? `<@${event.hostId}>` : 'Missing host'} | ${event.attendees ?? '?'} attendees | ${event.prize || 'No prize'} | ${date}`;
}

function buildHostSummary(events) {
  const counts = new Map();
  for (const event of events) {
    const key = event.hostId || 'missing';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const rows = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([hostId, total]) => `${hostId === 'missing' ? 'Missing host' : `<@${hostId}>`} | ${total}`);

  return {
    rows,
    total: events.length,
  };
}

function rankChoices(option) {
  return option
    .addChoices(
      { name: COORDINATOR_RANKS.junior.label, value: 'junior' },
      { name: COORDINATOR_RANKS.coordinator.label, value: 'coordinator' },
      { name: COORDINATOR_RANKS.senior.label, value: 'senior' },
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eventrecord')
    .setDescription('Manage monthly event host payout records')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Manually add a hosted event record')
      .addUserOption(o => o.setName('host').setDescription('Event host').setRequired(true))
      .addIntegerOption(o => o.setName('attendees').setDescription('Number of attendees').setRequired(true).setMinValue(0))
      .addStringOption(o => o.setName('prize').setDescription('Event prize').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Event date/time, defaults to now').setRequired(false))
      .addStringOption(o => o.setName('roblox').setDescription('Host Roblox username or user ID').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('edit')
      .setDescription('Edit an event record')
      .addStringOption(o => o.setName('id').setDescription('Event record ID').setRequired(true))
      .addUserOption(o => o.setName('host').setDescription('Replacement host').setRequired(false))
      .addIntegerOption(o => o.setName('attendees').setDescription('Replacement attendee count').setRequired(false).setMinValue(0))
      .addStringOption(o => o.setName('prize').setDescription('Replacement prize').setRequired(false))
      .addStringOption(o => o.setName('date').setDescription('Replacement date/time').setRequired(false))
      .addStringOption(o => o.setName('roblox').setDescription('Replacement Roblox username or user ID').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete an event record')
      .addStringOption(o => o.setName('id').setDescription('Event record ID').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List synced payout hosts or tracked events')
      .addStringOption(o => o
        .setName('view')
        .setDescription('What to list')
        .setRequired(false)
        .addChoices(
          { name: 'Synced payout hosts', value: 'synced' },
          { name: 'Event records', value: 'events' },
        ))
      .addStringOption(o => o.setName('month').setDescription('YYYY-MM, defaults to current month').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('rank')
      .setDescription('Manually set a host payout rank')
      .addUserOption(o => o.setName('user').setDescription('Host').setRequired(true))
      .addStringOption(o => rankChoices(o.setName('rank').setDescription('Coordinator rank').setRequired(true))))
    .addSubcommand(sub => sub
      .setName('sync')
      .setDescription('Sync current coordinator roles into payout ranks')
      .addStringOption(o => o
        .setName('source')
        .setDescription('Where to read coordinator ranks from')
        .setRequired(false)
        .addChoices(
          { name: 'Discord roles + linked Roblox roles', value: 'both' },
          { name: 'Discord roles only', value: 'discord' },
          { name: 'Linked Roblox group roles only', value: 'roblox' },
        ))),

  async execute(interaction) {
    if (!hasPayoutPermission(interaction)) {
      return interaction.reply({ content: 'Only admins or configured payout staff can manage event records.', flags: 64 });
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: 64 });

    if (subcommand === 'add') {
      const host = interaction.options.getUser('host');
      const robloxInput = interaction.options.getString('roblox');
      const link = await resolveRobloxLink(interaction.client, interaction.guildId, host.id, robloxInput);
      const event = await saveEventRecord(interaction.client, interaction.guildId, {
        hostId: host.id,
        robloxUsername: link?.robloxUsername || null,
        robloxUserId: link?.robloxUserId || null,
        prize: interaction.options.getString('prize'),
        attendees: interaction.options.getInteger('attendees'),
        timestamp: parseDateInput(interaction.options.getString('date')),
        source: 'manual',
      });
      await sendEventLog(interaction.client, interaction.guildId, event);
      return interaction.editReply(`Added event record:\n${eventLine(event)}`);
    }

    if (subcommand === 'edit') {
      const id = interaction.options.getString('id');
      const data = db.get();
      const store = getGuildPayoutStore(data, interaction.guildId);
      const existing = store.events.find(event => event.id === id);
      if (!existing) return interaction.editReply('Event record not found.');

      const host = interaction.options.getUser('host');
      const robloxInput = interaction.options.getString('roblox');
      const hostId = host?.id || existing.hostId;
      const link = robloxInput || host
        ? await resolveRobloxLink(interaction.client, interaction.guildId, hostId, robloxInput)
        : { robloxUsername: existing.robloxUsername, robloxUserId: existing.robloxUserId };

      const updated = await saveEventRecord(interaction.client, interaction.guildId, {
        ...existing,
        hostId,
        robloxUsername: link?.robloxUsername || existing.robloxUsername || null,
        robloxUserId: link?.robloxUserId || existing.robloxUserId || null,
        prize: interaction.options.getString('prize') ?? existing.prize,
        attendees: interaction.options.getInteger('attendees') ?? existing.attendees,
        timestamp: interaction.options.getString('date') ? parseDateInput(interaction.options.getString('date')) : existing.timestamp,
      });
      return interaction.editReply(`Updated event record:\n${eventLine(updated)}`);
    }

    if (subcommand === 'delete') {
      const id = interaction.options.getString('id');
      const data = db.get();
      const store = getGuildPayoutStore(data, interaction.guildId);
      const before = store.events.length;
      store.events = store.events.filter(event => event.id !== id);
      if (store.events.length === before) return interaction.editReply('Event record not found.');
      db.set(data);
      await saveToDiscord(interaction.client);
      return interaction.editReply(`Deleted event record \`${id}\`.`);
    }

    if (subcommand === 'rank') {
      const user = interaction.options.getUser('user');
      const rank = interaction.options.getString('rank');
      const data = db.get();
      const store = getGuildPayoutStore(data, interaction.guildId);
      store.hostRanks[user.id] = rank;
      db.set(data);
      await saveToDiscord(interaction.client);
      return interaction.editReply(`Set <@${user.id}> payout rank to **${COORDINATOR_RANKS[rank].label}**.`);
    }

    if (subcommand === 'sync') {
      const source = interaction.options.getString('source') || 'both';
      const result = await syncCoordinatorRanks(interaction.client, interaction.guildId, source);
      const removedText = result.removed?.length
        ? `\nRemoved **${result.removed.length}** coordinator${result.removed.length === 1 ? '' : 's'} who no longer hold the role: ${result.removed.map(id => `<@${id}>`).join(', ')}`
        : '';
      const warningText = result.warnings.length
        ? `\nWarnings:\n${result.warnings.slice(0, 6).join('\n')}`
        : '';
      return interaction.editReply(
        `Synced **${result.counts.total}** coordinator payout ranks.\n` +
        `Junior: **${result.counts.junior}** | Coordinator: **${result.counts.coordinator}** | Senior: **${result.counts.senior}**` +
        removedText +
        warningText
      );
    }

    const data = db.get();
    const store = getGuildPayoutStore(data, interaction.guildId);
    const view = interaction.options.getString('view') || 'synced';

    if (view === 'synced') {
      const links = getRobloxLinks(data, interaction.guildId);
      const rankOrder = { senior: 0, coordinator: 1, junior: 2 };
      const rows = Object.entries(store.hostRanks || {})
        .sort(([, aRank], [, bRank]) => (rankOrder[aRank] ?? 99) - (rankOrder[bRank] ?? 99))
        .map(([userId, rank]) => {
          const config = COORDINATOR_RANKS[rank];
          const link = links[userId];
          const roblox = link?.robloxUserId
            ? `${link.robloxUsername || link.robloxUserId} (${link.robloxUserId})`
            : 'Missing Roblox ID';
          return `<@${userId}> | ${config?.label || rank} | ${config?.payPerEvent || 0}/event | ${roblox}`;
        });

      const embed = new EmbedBuilder()
        .setTitle('Synced Event Payout Hosts')
        .setColor(0x1f4fd8)
        .setDescription(rows.length ? rows.slice(0, 25).join('\n') : 'No payout hosts are synced yet. Run `/eventrecord sync` first.')
        .addFields({ name: 'Synced Hosts', value: String(rows.length), inline: true })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    const now = new Date();
    const month = interaction.options.getString('month') || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const events = store.events
      .filter(event => new Date(event.timestamp).toISOString().startsWith(month));
    const summary = buildHostSummary(events);

    const embed = new EmbedBuilder()
      .setTitle(`Event Host Summary - ${month}`)
      .setColor(0x1f4fd8)
      .setDescription(summary.rows.length ? summary.rows.slice(0, 25).join('\n') : 'No event records found.')
      .addFields({ name: 'Total Matches Hosted', value: String(summary.total), inline: true })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  },
};
