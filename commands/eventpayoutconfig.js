const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { DEFAULT_EVENT_LOG_CHANNEL_ID, DEFAULT_PAYOUT_REPORT_CHANNEL_ID, getGuildSettings, sendEventLog } = require('../eventPayouts');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eventpayoutconfig')
    .setDescription('Configure event payout channels and admin roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub
      .setName('channels')
      .setDescription('Set event log and payout report channels')
      .addChannelOption(o => o.setName('event_log').setDescription('Channel for host event logs').setRequired(false))
      .addChannelOption(o => o.setName('payout_report').setDescription('Channel for monthly payout reports').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('adminrole_add')
      .setDescription('Allow a role to manage event payouts')
      .addRoleOption(o => o.setName('role').setDescription('Admin/mod role').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('adminrole_remove')
      .setDescription('Remove a role from event payout management')
      .addRoleOption(o => o.setName('role').setDescription('Admin/mod role').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('show')
      .setDescription('Show current event payout config'))
    .addSubcommand(sub => sub
      .setName('testlogs')
      .setDescription('Send a test event host log to configured log channels')),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can edit event payout config.', flags: 64 });
    }

    const data = db.get();
    const settings = getGuildSettings(data, interaction.guildId);
    if (!settings.payoutAdminRoles) settings.payoutAdminRoles = [];
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'channels') {
      const eventLog = interaction.options.getChannel('event_log');
      const payoutReport = interaction.options.getChannel('payout_report');
      if (eventLog) settings.eventLogChannelId = eventLog.id;
      if (payoutReport) settings.payoutReportChannelId = payoutReport.id;
      db.set(data);
      return interaction.reply({
        content: `Event log: <#${settings.eventLogChannelId || DEFAULT_EVENT_LOG_CHANNEL_ID}>\nPayout report: <#${settings.payoutReportChannelId || DEFAULT_PAYOUT_REPORT_CHANNEL_ID}>`,
        flags: 64,
      });
    }

    if (subcommand === 'adminrole_add') {
      const role = interaction.options.getRole('role');
      if (!settings.payoutAdminRoles.includes(role.id)) settings.payoutAdminRoles.push(role.id);
      db.set(data);
      return interaction.reply({ content: `<@&${role.id}> can now manage event payouts.`, flags: 64 });
    }

    if (subcommand === 'adminrole_remove') {
      const role = interaction.options.getRole('role');
      settings.payoutAdminRoles = settings.payoutAdminRoles.filter(id => id !== role.id);
      db.set(data);
      return interaction.reply({ content: `<@&${role.id}> can no longer manage event payouts.`, flags: 64 });
    }

    if (subcommand === 'testlogs') {
      await interaction.deferReply({ flags: 64 });
      await sendEventLog(interaction.client, interaction.guildId, {
        id: `test-${Date.now()}`,
        hostId: interaction.user.id,
        robloxUsername: 'test',
        robloxUserId: '0',
        prize: 'test',
        attendees: 0,
        source: 'test',
        timestamp: Date.now(),
      });
      return interaction.editReply(`Sent a test host log. Check <#${settings.eventLogChannelId || DEFAULT_EVENT_LOG_CHANNEL_ID}> and your match log channel.`);
    }

    const roles = settings.payoutAdminRoles.map(id => `<@&${id}>`).join(', ') || 'None';
    return interaction.reply({
      content: `Event log: <#${settings.eventLogChannelId || DEFAULT_EVENT_LOG_CHANNEL_ID}>\nPayout report: <#${settings.payoutReportChannelId || DEFAULT_PAYOUT_REPORT_CHANNEL_ID}>\nPayout admin roles: ${roles}`,
      flags: 64,
    });
  },
};
