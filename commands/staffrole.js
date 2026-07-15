const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staffrole')
    .setDescription('Manage roles that can use staff commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Grant a role access to staff commands')
        .addRoleOption(o => o.setName('role').setDescription('Role to add').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Revoke a role\'s access to staff commands')
        .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all roles with staff command access')
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Administrator permission required.', flags: 64 });
    }

    const data = db.get();
    if (!data.settings) data.settings = {};
    if (!data.settings[interaction.guildId]) data.settings[interaction.guildId] = {};
    if (!Array.isArray(data.settings[interaction.guildId].matchManagerRoles)) {
      data.settings[interaction.guildId].matchManagerRoles = [];
    }

    const roles = data.settings[interaction.guildId].matchManagerRoles;
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const role = interaction.options.getRole('role');
      if (roles.includes(role.id)) {
        return interaction.reply({ content: `${role} already has staff access.`, flags: 64 });
      }
      roles.push(role.id);
      db.set(data);
      return interaction.reply({ content: `✅ ${role} can now use staff commands.`, flags: 64 });
    }

    if (sub === 'remove') {
      const role = interaction.options.getRole('role');
      const idx = roles.indexOf(role.id);
      if (idx === -1) {
        return interaction.reply({ content: `${role} does not have staff access.`, flags: 64 });
      }
      roles.splice(idx, 1);
      db.set(data);
      return interaction.reply({ content: `✅ ${role} no longer has staff access.`, flags: 64 });
    }

    if (sub === 'list') {
      if (roles.length === 0) {
        return interaction.reply({ content: 'No staff roles configured. Only Administrators and hardcoded roles have access.', flags: 64 });
      }
      const list = roles.map(id => `<@&${id}>`).join('\n');
      return interaction.reply({ content: `**Staff roles:**\n${list}`, flags: 64 });
    }
  },
};
