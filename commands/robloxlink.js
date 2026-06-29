const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getTierForElo, getEloData, getPlayerElo, TIERS } = require('./elo');
const { linkRobloxAccount, syncRobloxTierForDiscordUser, syncRobloxUpdateForDiscordUser, getRobloxLinks, ROBLOX_GROUP_ID, TIER_ROLE_IDS, STAFF_ROLE_IDS, EXTRA_ROLE_IDS, ROLE_LABELS, TIER_RANKS, STAFF_RANKS, ROLE_PREFIXES, PREFIX_PRIORITY } = require('../robloxSync');

const VERIFIED_COMPETITOR_ROLE_ID = process.env.VERIFIED_COMPETITOR_ROLE_ID || '';
const DISCORD_STAFF_ROLE_ID = '1387600871377993820';
const DISCORD_COORDINATOR_ROLE_IDS = {
  [STAFF_ROLE_IDS.trial_coordinator]: '1333145733968302163',
  [STAFF_ROLE_IDS.coordinator]: '1333145733968302164',
  [STAFF_ROLE_IDS.senior_coordinator]: '1333145733968302162',
};
const STAFF_ROBLOX_ROLE_IDS = new Set(Object.values(STAFF_ROLE_IDS));
const MANAGED_ROBLOX_ROLE_IDS = new Set([
  ...Object.values(TIER_ROLE_IDS),
  ...Object.values(STAFF_ROLE_IDS),
  ...Object.values(EXTRA_ROLE_IDS),
]);

function formatDiscordTierRole(tier) {
  return `<@&${tier.roleId}>`;
}

function formatDiscordRole(roleId) {
  return `<@&${roleId}>`;
}

function formatRemovedRole(roleId) {
  const tier = Object.entries(TIER_ROLE_IDS).find(([, mappedRoleId]) => mappedRoleId === roleId)?.[0];
  if (!tier) return `@${roleId}`;
  const discordTier = TIERS.find(t => t.tier === tier);
  return discordTier ? `<@&${discordTier.roleId}>` : `@Tier ${tier}`;
}

function getNicknamePrefix(sync, tier) {
  const roles = new Set(sync.roles?.length ? sync.roles : [sync.targetRoleId]);
  for (const roleId of PREFIX_PRIORITY) {
    if (roles.has(roleId)) return ROLE_PREFIXES[roleId];
  }
  return `[T${tier.tier}]`;
}

function getTierFromRobloxRoles(roles, fallbackTier) {
  const roleSet = new Set(roles || []);
  return TIERS.find(tier => roleSet.has(TIER_ROLE_IDS[tier.tier])) || fallbackTier;
}

async function syncDiscordNickname(interaction, target, linked, tier, sync) {
  try {
    const member = target.id === interaction.user.id && interaction.member
      ? interaction.member
      : await interaction.guild.members.fetch(target.id);
    const prefix = getNicknamePrefix(sync, tier);
    const nickname = `${prefix} ${linked.robloxUsername}`.slice(0, 32);
    if (member.manageable && member.displayName !== nickname) {
      await member.setNickname(nickname, 'Roblox account verified/updated');
      return nickname;
    }
    return null;
  } catch (error) {
    console.error('Roblox nickname sync failed:', error.message);
    return null;
  }
}

function hasStaffRobloxRole(sync) {
  const roles = new Set(sync.roles || []);
  return [...STAFF_ROBLOX_ROLE_IDS].some(roleId => roles.has(roleId));
}

function findRoleByName(guild, name) {
  return guild.roles.cache.find(role => role.name.toLowerCase() === name.toLowerCase()) || null;
}

function getDiscordRoleIdForRobloxRole(guild, robloxRoleId) {
  const tierName = Object.entries(TIER_ROLE_IDS).find(([, roleId]) => roleId === robloxRoleId)?.[0];
  if (tierName) return TIERS.find(tier => tier.tier === tierName)?.roleId || null;

  if (DISCORD_COORDINATOR_ROLE_IDS[robloxRoleId]) {
    return DISCORD_COORDINATOR_ROLE_IDS[robloxRoleId];
  }

  if (robloxRoleId === EXTRA_ROLE_IDS.verified_competitor && VERIFIED_COMPETITOR_ROLE_ID) {
    return VERIFIED_COMPETITOR_ROLE_ID;
  }

  const roleName = ROLE_LABELS[robloxRoleId];
  return roleName ? findRoleByName(guild, roleName)?.id || null : null;
}

function getMappedDiscordRoleIds(guild, robloxRoleIds) {
  return [...new Set((robloxRoleIds || [])
    .filter(roleId => MANAGED_ROBLOX_ROLE_IDS.has(roleId))
    .map(roleId => getDiscordRoleIdForRobloxRole(guild, roleId))
    .filter(Boolean))];
}

async function syncDiscordVerifiedRoles(interaction, target, tier, sync) {
  const result = { added: [], removed: [], synced: [], warning: null };

  try {
    const member = await interaction.guild.members.fetch(target.id);
    const tierRoleIds = TIERS.map(t => t.roleId);
    const oldTierRoles = member.roles.cache.filter(role => tierRoleIds.includes(role.id) && role.id !== tier.roleId);
    const mappedRoleIds = [...new Set([tier.roleId, ...getMappedDiscordRoleIds(interaction.guild, sync.roles)])];
    if (hasStaffRobloxRole(sync) && DISCORD_STAFF_ROLE_ID) mappedRoleIds.push(DISCORD_STAFF_ROLE_ID);
    result.synced = [...new Set(mappedRoleIds)];

    const managedRoleIds = getMappedDiscordRoleIds(interaction.guild, [
      ...Object.values(TIER_ROLE_IDS),
      ...Object.values(STAFF_ROLE_IDS),
    ]);
    if (DISCORD_STAFF_ROLE_ID) managedRoleIds.push(DISCORD_STAFF_ROLE_ID);

    const oldMappedRoles = member.roles.cache.filter(role => managedRoleIds.includes(role.id) && !result.synced.includes(role.id) && !tierRoleIds.includes(role.id));

    if (oldTierRoles.size) {
      await member.roles.remove(oldTierRoles, 'Roblox account verified/updated');
      result.removed.push(...oldTierRoles.map(role => role.id));
    }

    if (oldMappedRoles.size) {
      await member.roles.remove(oldMappedRoles, 'Roblox group role sync');
      result.removed.push(...oldMappedRoles.map(role => role.id));
    }

    for (const roleId of result.synced) {
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, 'Roblox group role sync');
        result.added.push(roleId);
      }
    }
  } catch (error) {
    console.error('Discord verified role sync failed:', error.message);
    result.warning = 'Discord roles could not be updated. Check the bot role position and role IDs.';
  }

  return result;
}

function getDisplayAddedRoles(tier) {
  return [
    formatDiscordTierRole(tier),
  ];
}

function buildUpdateEmbed(target, linked, tier, sync, discordRoles) {
  const removedRoles = [
    ...(sync.removed || []).map(formatRemovedRole),
    ...(discordRoles?.removed || []).map(formatDiscordRole),
  ];

  return new EmbedBuilder()
    .setColor(0x1f4fd8)
    .setAuthor({ name: `${target.username} updated`, iconURL: target.displayAvatarURL({ size: 64 }) })
    .addFields(
      {
        name: 'Roles Added',
        value: sync.skipped ? 'None' : [...new Set([...(discordRoles?.synced || []).map(formatDiscordRole), ...getDisplayAddedRoles(tier)])].join('\n'),
        inline: false,
      },
      {
        name: 'Roles Removed',
        value: removedRoles.length
          ? [...new Set(removedRoles)].join('\n')
          : 'None',
        inline: false,
      },
    )
    .setFooter({ text: `${linked.robloxUsername} (${linked.robloxUserId})` })
    .setTimestamp();
}

async function linkAndSync(interaction, target, roblox) {
  let linked;
  if (roblox) {
    linked = await linkRobloxAccount(interaction.client, interaction.guildId, target.id, roblox);
  } else {
    const data = db.get();
    linked = getRobloxLinks(data, interaction.guildId)[target.id];
    if (!linked) throw new Error('No Roblox account linked. Run `/verify roblox:YourUsername` first.');
  }

  const data = db.get();
  const fallbackTier = getTierForElo(getPlayerElo(getEloData(data), target.id).elo || 0);
  const sync = await syncRobloxUpdateForDiscordUser(interaction.client, interaction.guildId, target.id, fallbackTier);
  const tier = getTierFromRobloxRoles(sync.roles, fallbackTier);
  const discordRoles = await syncDiscordVerifiedRoles(interaction, target, tier, sync);
  await syncDiscordNickname(interaction, target, linked, tier, sync);
  return { linked, tier, sync, discordRoles };
}

function canManageRobloxLinks(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

const verifyRobloxCommand = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Roblox account for VP Bot tier syncing')
    .addStringOption(o => o.setName('roblox').setDescription('Your Roblox username or user ID').setRequired(true)),

  async execute(interaction) {
    const roblox = interaction.options.getString('roblox');
    await interaction.deferReply({ flags: 64 });

    try {
      const { linked, tier, sync, discordRoles } = await linkAndSync(interaction, interaction.user, roblox);
      await interaction.editReply({ embeds: [buildUpdateEmbed(interaction.user, linked, tier, sync, discordRoles)] });
    } catch (error) {
      await interaction.editReply({ content: `Roblox verify failed: ${error.message}` });
    }
  },
};

const robloxLinkCommand = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Link or update a player Roblox account and sync their group tier rank')
    .addUserOption(o => o.setName('user').setDescription('Optional Discord user').setRequired(false))
    .addStringOption(o => o.setName('roblox').setDescription('Optional Roblox username or user ID').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const roblox = interaction.options.getString('roblox');
    await interaction.deferReply({ flags: 64 });

    if (target.id !== interaction.user.id && !canManageRobloxLinks(interaction)) {
      return interaction.editReply({ content: 'Only staff can update another player.' });
    }

    try {
      const { linked, tier, sync, discordRoles } = await linkAndSync(interaction, target, roblox);
      await interaction.editReply({ embeds: [buildUpdateEmbed(target, linked, tier, sync, discordRoles)] });
    } catch (error) {
      await interaction.editReply({ content: `Roblox update failed: ${error.message}` });
    }
  },
};

const forceUpdateAllCommand = {
  data: new SlashCommandBuilder()
    .setName('forceupdateall')
    .setDescription('Force-sync every linked player Roblox tier, Discord roles, and nickname')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    if (!canManageRobloxLinks(interaction)) {
      return interaction.editReply({ content: 'Only staff can force update all players.' });
    }

    const data = db.get();
    const links = getRobloxLinks(data, interaction.guildId);
    const userIds = Object.keys(links);

    if (!userIds.length) {
      return interaction.editReply({ content: 'No linked Roblox users found.' });
    }

    const results = [];
    let updated = 0;
    let failed = 0;

    for (const discordUserId of userIds) {
      try {
        const target = await interaction.client.users.fetch(discordUserId);
        const { tier, sync } = await linkAndSync(interaction, target, null);
        updated += 1;
        results.push(sync.skipped
          ? `<@${discordUserId}> skipped: ${sync.reason}`
          : `<@${discordUserId}> -> Tier ${tier.tier}`);
      } catch (error) {
        failed += 1;
        results.push(`<@${discordUserId}> failed: ${error.message}`);
      }
    }

    await interaction.editReply({
      content: [
        `Force update complete: ${updated} updated, ${failed} failed.`,
        '',
        results.slice(0, 20).join('\n'),
        results.length > 20 ? `...and ${results.length - 20} more.` : '',
      ].filter(Boolean).join('\n').slice(0, 1900),
    });
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
        `Verified Competitor role: ${VERIFIED_COMPETITOR_ROLE_ID ? `<@&${VERIFIED_COMPETITOR_ROLE_ID}>` : 'Not configured'}`,
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

module.exports = { verifyRobloxCommand, robloxLinkCommand, forceUpdateAllCommand, robloxSyncCommand, robloxStatusCommand };
