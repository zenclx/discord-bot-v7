const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getTierForElo, getEloData, getPlayerElo } = require('./elo');
const { linkRobloxAccount, syncRobloxTierForDiscordUser, getRobloxLinks, ROBLOX_GROUP_ID, TIER_ROLE_IDS, STAFF_ROLE_IDS, TIER_RANKS, STAFF_RANKS } = require('../robloxSync');

function formatRobloxTierRole(tier, roleId) {
  const rank = TIER_RANKS[tier] || '?';
  return `Tier ${tier} [${rank}+]`;
}

const robloxLinkCommand = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Link or update a player Roblox account and sync their group tier rank')
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
      const embed = new EmbedBuilder()
        .setColor(0x00c781)
        .setAuthor({ name: `${target.username} updated`, iconURL: target.displayAvatarURL({ size: 64 }) })
        .addFields(
          {
            name: 'Roles Added',
            value: sync.skipped ? 'None' : `@${formatRobloxTierRole(tier.tier, sync.targetRoleId)}`,
            inline: false,
          },
          {
            name: 'Roles Removed',
            value: sync.removed?.length
              ? sync.removed.map(roleId => `@${roleId}`).join('\n')
              : 'None',
            inline: false,
          },
        )
        .setFooter({ text: `${linked.robloxUsername} (${linked.robloxUserId})` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
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
    const tierLines = Object.entries(TIER_ROLE_IDS).map(([tier, roleId]) => `Tier ${tier}: rank ${TIER_RANKS[tier]} / role ${roleId}`).join('\n');
    const staffLines = Object.entries(STAFF_ROLE_IDS).map(([name, roleId]) => `${name}: rank ${STAFF_RANKS[name]} / role ${roleId}`).join('\n');

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
