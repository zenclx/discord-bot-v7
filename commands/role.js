const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const {
  TIER_ROLE_IDS,
  STAFF_ROLE_IDS,
  EXTRA_ROLE_IDS,
  ROLE_LABELS,
  addRobloxRolesForDiscordUser,
} = require('../robloxSync');

const ROLE_CHOICES = [
  { name: 'Tier 1', value: TIER_ROLE_IDS.I },
  { name: 'Tier 2', value: TIER_ROLE_IDS.II },
  { name: 'Tier 3', value: TIER_ROLE_IDS.III },
  { name: 'Tier 4', value: TIER_ROLE_IDS.IV },
  { name: 'Tier 5', value: TIER_ROLE_IDS.V },
  { name: 'Verified Competitor', value: EXTRA_ROLE_IDS.verified_competitor },
  { name: 'Trial Coordinator', value: STAFF_ROLE_IDS.trial_coordinator },
  { name: 'Coordinator', value: STAFF_ROLE_IDS.coordinator },
  { name: 'Senior Coordinator', value: STAFF_ROLE_IDS.senior_coordinator },
  { name: 'VP Moderator', value: STAFF_ROLE_IDS.vp_moderator },
  { name: 'VP Senior Mod', value: STAFF_ROLE_IDS.vp_senior_mod },
  { name: 'VP Admin', value: STAFF_ROLE_IDS.vp_admin },
];

function addRoleOption(builder, index, required) {
  return builder.addStringOption(option => option
    .setName(`role${index}`)
    .setDescription(index === 1 ? 'Roblox group role to add' : 'Additional Roblox group role to add')
    .setRequired(required)
    .addChoices(...ROLE_CHOICES));
}

function getSelectedRoles(interaction) {
  const roles = [];
  for (let index = 1; index <= 5; index += 1) {
    const roleId = interaction.options.getString(`role${index}`);
    if (roleId) roles.push(roleId);
  }
  return [...new Set(roles)];
}

const builder = new SlashCommandBuilder()
  .setName('role')
  .setDescription('Add one or more Roblox group roles to a linked user')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption(option => option
    .setName('user')
    .setDescription('Discord user linked to the Roblox account')
    .setRequired(true));

addRoleOption(builder, 1, true);
addRoleOption(builder, 2, false);
addRoleOption(builder, 3, false);
addRoleOption(builder, 4, false);
addRoleOption(builder, 5, false);

module.exports = {
  data: builder,

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const target = interaction.options.getUser('user');
    const roles = getSelectedRoles(interaction);

    try {
      const result = await addRobloxRolesForDiscordUser(
        interaction.client,
        interaction.guildId,
        target.id,
        roles,
        interaction.user.id,
      );

      const embed = new EmbedBuilder()
        .setColor(0x1f4fd8)
        .setAuthor({ name: `${target.username} role updated`, iconURL: target.displayAvatarURL({ size: 64 }) })
        .addFields(
          {
            name: 'Roles Added',
            value: result.added.map(roleId => ROLE_LABELS[roleId] || roleId).join('\n') || 'None',
            inline: false,
          },
          {
            name: 'Already Had',
            value: result.requested.filter(roleId => !result.added.includes(roleId)).map(roleId => ROLE_LABELS[roleId] || roleId).join('\n') || 'None',
            inline: false,
          },
          {
            name: 'Roles Removed',
            value: result.removed.map(roleId => ROLE_LABELS[roleId] || roleId).join('\n') || 'None',
            inline: false,
          },
        )
        .setFooter({ text: `${result.robloxUsername} (${result.robloxUserId})` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({ content: `Role update failed: ${error.message}` });
    }
  },
};
