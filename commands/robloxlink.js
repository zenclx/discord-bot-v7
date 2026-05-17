const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { getTierForElo, getEloData, getPlayerElo } = require('./elo');
const { linkRobloxAccount, syncRobloxTierForDiscordUser, getRobloxLinks, ROBLOX_GROUP_ID, TIER_ROLE_IDS, STAFF_ROLE_IDS } = require('../robloxSync');

const robloxLinkCommand = {
  data: new SlashCommandBuilder()
    .setName('linkroblox')
    .setDescription('Link a Discord user to a Roblox account for automatic group tier ranks')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption(o => o.setName('roblox').setDescription('Roblox username or user ID').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const roblox = interaction.options.getString('roblox');
    await interaction.deferReply({ flags: 64 });

    try {
      const linked = await linkRobloxAccount(interaction.client, interaction.guildId, target.id, roblox);
      const data = db.get();
      const tier = getTierForElo(getPlayerElo(getEloData(data), target.id).elo || 0);
      const sync = await syncRobloxTierForDiscordUser(interaction.client, interaction.guildId, target.id, tier);

      await interaction.editReply({
        content: [
          `Linked <@${target.id}> to Roblox **${linked.robloxUsername}** (${linked.robloxUserId}).`,
          sync.skipped ? `Roblox rank sync skipped: ${sync.reason}` : `Synced group ${ROBLOX_GROUP_ID} tier role **${sync.targetRoleId}**.`,
        ].join('\n'),
      });
    } catch (error) {
      await interaction.editReply({ content: `Roblox link failed: ${error.message}` });
    }
  },
};

const robloxSyncCommand = {
  data: new SlashCommandBuilder()
    .setName('syncroblox')
    .setDescription('Sync a linked user or all linked users to their current VP tier in Roblox')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Optional Discord user').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const data = db.get();
    const eloData = getEloData(data);
    const target = interaction.options.getUser('user');
    const links = getRobloxLinks(data, interaction.guildId);
    const userIds = target ? [target.id] : Object.keys(links);

    if (!userIds.length) {
      return interaction.editReply({ content: 'No linked Roblox users found.' });
    }

    const results = [];
    for (const discordUserId of userIds) {
      try {
        const tier = getTierForElo(getPlayerElo(eloData, discordUserId).elo || 0);
        const sync = await syncRobloxTierForDiscordUser(interaction.client, interaction.guildId, discordUserId, tier);
        results.push(sync.skipped
          ? `<@${discordUserId}> skipped: ${sync.reason}`
          : `<@${discordUserId}> -> Tier ${tier.tier} role ${sync.targetRoleId}`);
      } catch (error) {
        results.push(`<@${discordUserId}> failed: ${error.message}`);
      }
    }

    await interaction.editReply({ content: results.join('\n').slice(0, 1900) });
  },
};

const robloxStatusCommand = {
  data: new SlashCommandBuilder()
    .setName('robloxstatus')
    .setDescription('Show Roblox group rank sync settings and a user link')
    .addUserOption(o => o.setName('user').setDescription('Optional Discord user').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const data = db.get();
    const link = getRobloxLinks(data, interaction.guildId)[target.id];
    const tierLines = Object.entries(TIER_ROLE_IDS).map(([tier, roleId]) => `Tier ${tier}: ${roleId}`).join('\n');
    const staffLines = Object.entries(STAFF_ROLE_IDS).map(([name, roleId]) => `${name}: ${roleId}`).join('\n');

    await interaction.reply({
      content: [
        `Roblox Group: **${ROBLOX_GROUP_ID}**`,
        `Linked user: ${link ? `${link.robloxUsername} (${link.robloxUserId})` : 'Not linked'}`,
        '',
        '**Tier Roles**',
        tierLines,
        '',
        '**Staff Roles Preserved**',
        staffLines,
      ].join('\n'),
      flags: 64,
    });
  },
};

module.exports = { robloxLinkCommand, robloxSyncCommand, robloxStatusCommand };
