const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');

function getGuildSettings(data, guildId) {
  if (!data.settings) data.settings = {};
  if (!data.settings[guildId]) data.settings[guildId] = {};
  if (!data.settings[guildId].matchManagerRoles) data.settings[guildId].matchManagerRoles = [];
  return data.settings[guildId];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hostrole')
    .setDescription('Manage roles that can host matches')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Allow a role to host matches')
        .addRoleOption(o => o.setName('role').setDescription('Role to allow').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a match host role')
        .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List match host roles')
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'Only administrators can manage host roles.', flags: 64 });
    }

    const data = db.get();
    const settings = getGuildSettings(data, interaction.guildId);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const roles = settings.matchManagerRoles.map(id => `<@&${id}>`).join(', ') || 'No extra host roles set.';
      return interaction.reply({ content: `Host roles: ${roles}`, flags: 64 });
    }

    const role = interaction.options.getRole('role');
    if (subcommand === 'add') {
      if (!settings.matchManagerRoles.includes(role.id)) settings.matchManagerRoles.push(role.id);
      db.set(data);
      return interaction.reply({ content: `<@&${role.id}> can now host matches.`, flags: 64 });
    }

    settings.matchManagerRoles = settings.matchManagerRoles.filter(id => id !== role.id);
    db.set(data);
    return interaction.reply({ content: `<@&${role.id}> can no longer host matches.`, flags: 64 });
  },
};
