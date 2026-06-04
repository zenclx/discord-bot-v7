const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { hasPayoutPermission, resolveRobloxLink } = require('../eventPayouts');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setroblox')
    .setDescription('Admin: set a Discord user Roblox account for event payouts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption(o => o.setName('roblox_username').setDescription('Roblox username or user ID').setRequired(true)),

  async execute(interaction) {
    if (!hasPayoutPermission(interaction)) {
      return interaction.reply({ content: 'Only admins or configured payout staff can set Roblox payout IDs.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });
    try {
      const user = interaction.options.getUser('user');
      const roblox = interaction.options.getString('roblox_username');
      const link = await resolveRobloxLink(interaction.client, interaction.guildId, user.id, roblox);
      await interaction.editReply(`Set <@${user.id}> Roblox account to **${link.robloxUsername}** (\`${link.robloxUserId}\`).`);
    } catch (error) {
      await interaction.editReply(`Could not set Roblox account: ${error.message}`);
    }
  },
};
