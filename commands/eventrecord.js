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
} = require('../eventPayouts');

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
      .setDescription('List tracked events')
      .addStringOption(o => o.setName('month').setDescription('YYYY-MM, defaults to current month').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('rank')
      .setDescription('Manually set a host payout rank')
      .addUserOption(o => o.setName('user').setDescription('Host').setRequired(true))
      .addStringOption(o => rankChoices(o.setName('rank').setDescription('Coordinator rank').setRequired(true)))),

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

    const now = new Date();
    const month = interaction.options.getString('month') || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const data = db.get();
    const store = getGuildPayoutStore(data, interaction.guildId);
    const rows = store.events
      .filter(event => new Date(event.timestamp).toISOString().startsWith(month))
      .slice(0, 15);

    const embed = new EmbedBuilder()
      .setTitle(`Event Records - ${month}`)
      .setColor(0x1f4fd8)
      .setDescription(rows.length ? rows.map(eventLine).join('\n') : 'No event records found.')
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  },
};
