const db = require('./database');
const { saveToDiscord } = require('./discordBackup');
const { sendStaffAuditLog } = require('./auditLog');

const ROBLOX_GROUP_ID = '301637944';

const TIER_ROLE_IDS = {
  V: '489400211',
  IV: '488754179',
  III: '489736121',
  II: '489424158',
  I: '488714133',
};

const STAFF_ROLE_IDS = {
  trial_coordinator: '494852007',
  coordinator: '489538201',
  senior_coordinator: '489538202',
  vp_moderator: '495274003',
  vp_senior_mod: '489424159',
  vp_admin: '494910003',
};

const TIER_RANKS = {
  V: '2',
  IV: '3',
  III: '4',
  II: '9',
  I: '10',
};

const STAFF_RANKS = {
  trial_coordinator: '11',
  coordinator: '12',
  senior_coordinator: '13',
  vp_moderator: '14',
  vp_senior_mod: '15',
  vp_admin: '16',
};

const EXTRA_ROLE_IDS = {
  verified_competitor: '494290012',
};

const ROLE_LABELS = {
  [TIER_ROLE_IDS.I]: 'Tier 1',
  [TIER_ROLE_IDS.II]: 'Tier 2',
  [TIER_ROLE_IDS.III]: 'Tier 3',
  [TIER_ROLE_IDS.IV]: 'Tier 4',
  [TIER_ROLE_IDS.V]: 'Tier 5',
  [STAFF_ROLE_IDS.trial_coordinator]: 'Trial Coordinator',
  [STAFF_ROLE_IDS.coordinator]: 'Coordinator',
  [STAFF_ROLE_IDS.senior_coordinator]: 'Senior Coordinator',
  [STAFF_ROLE_IDS.vp_moderator]: 'VP Moderator',
  [STAFF_ROLE_IDS.vp_senior_mod]: 'VP Senior Mod',
  [STAFF_ROLE_IDS.vp_admin]: 'VP Admin',
  [EXTRA_ROLE_IDS.verified_competitor]: 'Verified Competitor',
};

const ROLE_PREFIXES = {
  [TIER_ROLE_IDS.I]: '[T1]',
  [TIER_ROLE_IDS.II]: '[T2]',
  [TIER_ROLE_IDS.III]: '[T3]',
  [TIER_ROLE_IDS.IV]: '[T4]',
  [TIER_ROLE_IDS.V]: '[T5]',
  [STAFF_ROLE_IDS.senior_coordinator]: '[SC]',
  [STAFF_ROLE_IDS.coordinator]: '[C]',
  [STAFF_ROLE_IDS.trial_coordinator]: '[JC]',
};

const PREFIX_PRIORITY = [
  STAFF_ROLE_IDS.senior_coordinator,
  STAFF_ROLE_IDS.coordinator,
  STAFF_ROLE_IDS.trial_coordinator,
  TIER_ROLE_IDS.I,
  TIER_ROLE_IDS.II,
  TIER_ROLE_IDS.III,
  TIER_ROLE_IDS.IV,
  TIER_ROLE_IDS.V,
];

function getApiKey() {
  return process.env.ROBLOX_OPEN_CLOUD_API_KEY || process.env.ROBLOX_API_KEY || '';
}

function getRobloxLinks(data, guildId) {
  if (!data.robloxLinks) data.robloxLinks = {};
  if (!data.robloxLinks[guildId]) data.robloxLinks[guildId] = {};
  return data.robloxLinks[guildId];
}

function getRoleResource(roleId) {
  return `groups/${ROBLOX_GROUP_ID}/roles/${roleId}`;
}

function normalizeRoleId(role) {
  if (!role) return null;
  if (typeof role === 'string') return role.split('/').pop();
  if (role.id !== undefined) return String(role.id);
  if (role.roleId !== undefined) return String(role.roleId);
  if (role.path) return String(role.path).split('/').pop();
  if (role.name) return String(role.name).split('/').pop();
  return null;
}

function getMembershipId(membership) {
  const candidates = [
    membership?.id,
    membership?.membershipId,
    membership?.groupMembershipId,
    membership?.path,
    membership?.name,
  ].filter(Boolean);

  for (const source of candidates) {
    const id = String(source).split('/').pop();
    if (id && id !== '-') return id;
  }

  return null;
}

function getMembershipRoles(membership) {
  const roles = membership?.roles || (membership?.role ? [membership.role] : []);
  return roles.map(normalizeRoleId).filter(Boolean);
}

async function robloxFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Missing ROBLOX_OPEN_CLOUD_API_KEY Render environment variable.');

  const response = await fetch(`https://apis.roblox.com${path}`, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.message || body?.errors?.[0]?.message || text || response.statusText;
    throw new Error(`Roblox API ${response.status}: ${message}`);
  }
  return body;
}

async function lookupRobloxUser(username) {
  const response = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  const body = await response.json();
  const user = body?.data?.[0];
  if (!response.ok || !user) throw new Error(`Roblox user "${username}" was not found.`);
  return { robloxUserId: String(user.id), robloxUsername: user.name || username };
}

async function getGroupMembership(robloxUserId) {
  const filter = encodeURIComponent(`user == 'users/${robloxUserId}'`);
  const body = await robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships?filter=${filter}&maxPageSize=10`);
  const memberships = body.groupMemberships || body.memberships || body.data || [];
  return memberships[0] || null;
}

async function assignRole(membershipId, roleId) {
  try {
    return await robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${membershipId}:assignRole`, {
      method: 'POST',
      body: JSON.stringify({ role: getRoleResource(roleId) }),
    });
  } catch (error) {
    return robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${membershipId}:assignRole`, {
      method: 'POST',
      body: JSON.stringify({ roleId: getRoleResource(roleId) }),
    });
  }
}

async function setMembershipRoles(membershipId, roleIds) {
  const roles = roleIds.map(getRoleResource);
  return robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${membershipId}`, {
    method: 'PATCH',
    body: JSON.stringify({ roles }),
  });
}

async function unassignRole(membershipId, roleId) {
  try {
    return await robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${membershipId}:unassignRole`, {
      method: 'POST',
      body: JSON.stringify({ role: getRoleResource(roleId) }),
    });
  } catch (error) {
    return robloxFetch(`/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships/${membershipId}:unassignRole`, {
      method: 'POST',
      body: JSON.stringify({ roleId: getRoleResource(roleId) }),
    });
  }
}

async function syncRobloxTierForDiscordUser(client, guildId, discordUserId, tier) {
  const data = db.get();
  const link = getRobloxLinks(data, guildId)[discordUserId];
  if (!link?.robloxUserId) return { skipped: true, reason: 'No linked Roblox account.' };

  const targetRoleId = TIER_ROLE_IDS[tier?.tier || tier];
  if (!targetRoleId) return { skipped: true, reason: 'No mapped Roblox tier role.' };

  const membership = await getGroupMembership(link.robloxUserId);
  if (!membership) throw new Error(`${link.robloxUsername || link.robloxUserId} is not in Roblox group ${ROBLOX_GROUP_ID}.`);

  const membershipId = getMembershipId(membership);
  if (!membershipId) {
    console.error('Roblox membership missing usable id:', JSON.stringify(membership));
    throw new Error('Could not read Roblox group membership ID.');
  }

  const currentRoles = getMembershipRoles(membership);
  const tierRoles = Object.values(TIER_ROLE_IDS);
  const staffRoleIds = Object.values(STAFF_ROLE_IDS);
  const preservedStaffRoles = currentRoles.filter(roleId => staffRoleIds.includes(roleId));
  const nonTierRoles = currentRoles.filter(roleId => !tierRoles.includes(roleId));
  const removed = [];
  const desiredRoles = [...new Set([...nonTierRoles, ...preservedStaffRoles, targetRoleId])];

  try {
    for (const roleId of tierRoles) {
      if (roleId !== targetRoleId && currentRoles.includes(roleId)) {
        await unassignRole(membershipId, roleId);
        removed.push(roleId);
      }
    }

    if (!currentRoles.includes(targetRoleId)) {
      await assignRole(membershipId, targetRoleId);
    }
  } catch (error) {
    console.warn(`assign/unassign role failed for membership ${membershipId}, trying PATCH fallback: ${error.message}`);
    await setMembershipRoles(membershipId, desiredRoles);
    for (const roleId of tierRoles) {
      if (roleId !== targetRoleId && currentRoles.includes(roleId)) removed.push(roleId);
    }
  }

  const freshData = db.get();
  const freshLinks = getRobloxLinks(freshData, guildId);
  freshLinks[discordUserId] = {
    ...freshLinks[discordUserId],
    lastSyncedTier: tier?.tier || tier,
    lastSyncedRoleId: targetRoleId,
    lastSyncedAt: Date.now(),
  };
  db.set(freshData);
  await saveToDiscord(client);

  await sendStaffAuditLog(client, guildId, 'Roblox Tier Synced', [
    { name: 'Discord User', value: `<@${discordUserId}>`, inline: true },
    { name: 'Roblox User', value: `${link.robloxUsername || link.robloxUserId} (${link.robloxUserId})`, inline: true },
    { name: 'Tier Role', value: `${tier?.tier || tier} -> ${targetRoleId}`, inline: true },
    { name: 'Removed Tier Roles', value: removed.length ? removed.join(', ') : 'None', inline: false },
  ]);

  return { skipped: false, robloxUserId: link.robloxUserId, robloxUsername: link.robloxUsername, targetRoleId, removed, roles: desiredRoles };
}

const TIER_ORDER = ['I', 'II', 'III', 'IV', 'V']; // index 0 = highest tier

async function syncRobloxUpdateForDiscordUser(client, guildId, discordUserId, fallbackTier) {
  const data = db.get();
  const link = getRobloxLinks(data, guildId)[discordUserId];
  if (!link?.robloxUserId) return { skipped: true, reason: 'No linked Roblox account.' };

  const fallbackRoleId = TIER_ROLE_IDS[fallbackTier?.tier || fallbackTier];
  if (!fallbackRoleId) return { skipped: true, reason: 'No mapped Roblox tier role.' };

  const membership = await getGroupMembership(link.robloxUserId);
  if (!membership) throw new Error(`${link.robloxUsername || link.robloxUserId} is not in Roblox group ${ROBLOX_GROUP_ID}.`);

  const membershipId = getMembershipId(membership);
  if (!membershipId) {
    console.error('Roblox membership missing usable id:', JSON.stringify(membership));
    throw new Error('Could not read Roblox group membership ID.');
  }

  const currentRoles = getMembershipRoles(membership);
  const existingTierEntry = ['I', 'II', 'III', 'IV', 'V']
    .map(tier => [tier, TIER_ROLE_IDS[tier]])
    .find(([, roleId]) => currentRoles.includes(roleId));

  // Check if the ELO tier is higher than the current Roblox group tier → upgrade
  const eloTierName = fallbackTier?.tier || fallbackTier;
  const eloTierIndex = TIER_ORDER.indexOf(eloTierName);
  const existingTierIndex = existingTierEntry ? TIER_ORDER.indexOf(existingTierEntry[0]) : Infinity;
  const shouldUpgrade = eloTierIndex < existingTierIndex; // lower index = higher tier

  const targetRoleId = (!existingTierEntry || shouldUpgrade) ? fallbackRoleId : existingTierEntry[1];
  const added = [];
  let roles = currentRoles;

  if (!existingTierEntry || shouldUpgrade) {
    try {
      if (shouldUpgrade && existingTierEntry) {
        await unassignRole(membershipId, existingTierEntry[1]);
      }
      await assignRole(membershipId, targetRoleId);
    } catch (error) {
      console.warn(`assign tier failed for membership ${membershipId}, trying PATCH fallback: ${error.message}`);
      const withoutOld = currentRoles.filter(r => r !== existingTierEntry?.[1]);
      await setMembershipRoles(membershipId, [...new Set([...withoutOld, targetRoleId])]);
    }
    added.push(targetRoleId);
    roles = [...new Set([...currentRoles.filter(r => r !== existingTierEntry?.[1]), targetRoleId])];
  }

  const tier = Object.entries(TIER_ROLE_IDS).find(([, roleId]) => roleId === targetRoleId)?.[0] || fallbackTier?.tier || fallbackTier;
  const freshData = db.get();
  const freshLinks = getRobloxLinks(freshData, guildId);
  freshLinks[discordUserId] = {
    ...freshLinks[discordUserId],
    lastSyncedTier: tier,
    lastSyncedRoleId: targetRoleId,
    lastSyncedAt: Date.now(),
  };
  db.set(freshData);
  await saveToDiscord(client);

  await sendStaffAuditLog(client, guildId, 'Roblox Update Synced', [
    { name: 'Discord User', value: `<@${discordUserId}>`, inline: true },
    { name: 'Roblox User', value: `${link.robloxUsername || link.robloxUserId} (${link.robloxUserId})`, inline: true },
    { name: 'Tier Role', value: `${tier} -> ${targetRoleId}`, inline: true },
    { name: 'Group Roles', value: roles.map(roleId => ROLE_LABELS[roleId] || roleId).join('\n').slice(0, 1000) || 'None', inline: false },
  ]);

  return {
    skipped: false,
    robloxUserId: link.robloxUserId,
    robloxUsername: link.robloxUsername,
    targetRoleId,
    added,
    removed: shouldUpgrade && existingTierEntry ? [existingTierEntry[1]] : [],
    roles,
  };
}

async function addRobloxRolesForDiscordUser(client, guildId, discordUserId, roleIds, actorId = null) {
  const data = db.get();
  const link = getRobloxLinks(data, guildId)[discordUserId];
  if (!link?.robloxUserId) throw new Error('No linked Roblox account.');

  const uniqueRoleIds = [...new Set(roleIds.map(String))].filter(Boolean);
  if (!uniqueRoleIds.length) throw new Error('No Roblox roles selected.');

  const knownRoleIds = new Set([
    ...Object.values(TIER_ROLE_IDS),
    ...Object.values(STAFF_ROLE_IDS),
    ...Object.values(EXTRA_ROLE_IDS),
  ]);
  const invalidRoleIds = uniqueRoleIds.filter(roleId => !knownRoleIds.has(roleId));
  if (invalidRoleIds.length) throw new Error(`Unknown Roblox role ID: ${invalidRoleIds.join(', ')}`);

  const membership = await getGroupMembership(link.robloxUserId);
  if (!membership) throw new Error(`${link.robloxUsername || link.robloxUserId} is not in Roblox group ${ROBLOX_GROUP_ID}.`);

  const membershipId = getMembershipId(membership);
  if (!membershipId) {
    console.error('Roblox membership missing usable id:', JSON.stringify(membership));
    throw new Error('Could not read Roblox group membership ID.');
  }

  const currentRoles = getMembershipRoles(membership);
  const desiredRoles = [...new Set([...currentRoles, ...uniqueRoleIds])];
  const added = uniqueRoleIds.filter(roleId => !currentRoles.includes(roleId));
  const removed = currentRoles.filter(roleId => !desiredRoles.includes(roleId));

  try {
    for (const roleId of removed) {
      await unassignRole(membershipId, roleId);
    }

    for (const roleId of added) {
      await assignRole(membershipId, roleId);
    }
  } catch (error) {
    console.warn(`manual Roblox role assign failed for membership ${membershipId}, trying PATCH fallback: ${error.message}`);
    await setMembershipRoles(membershipId, desiredRoles);
  }

  await sendStaffAuditLog(client, guildId, 'Roblox Roles Added', [
    { name: 'Discord User', value: `<@${discordUserId}>`, inline: true },
    { name: 'Roblox User', value: `${link.robloxUsername || link.robloxUserId} (${link.robloxUserId})`, inline: true },
    { name: 'Staff Member', value: actorId ? `<@${actorId}>` : 'Unknown', inline: true },
    { name: 'Roles', value: uniqueRoleIds.map(roleId => ROLE_LABELS[roleId] || roleId).join('\n'), inline: false },
  ]);

  return {
    robloxUserId: link.robloxUserId,
    robloxUsername: link.robloxUsername,
    roles: desiredRoles,
    added,
    removed,
    requested: uniqueRoleIds,
  };
}

async function linkRobloxAccount(client, guildId, discordUserId, robloxUser) {
  const resolved = /^\d+$/.test(String(robloxUser))
    ? { robloxUserId: String(robloxUser), robloxUsername: String(robloxUser) }
    : await lookupRobloxUser(robloxUser);

  const data = db.get();
  const links = getRobloxLinks(data, guildId);
  links[discordUserId] = {
    robloxUserId: resolved.robloxUserId,
    robloxUsername: resolved.robloxUsername,
    linkedAt: Date.now(),
  };
  db.set(data);
  await saveToDiscord(client);
  return links[discordUserId];
}

module.exports = {
  ROBLOX_GROUP_ID,
  TIER_ROLE_IDS,
  STAFF_ROLE_IDS,
  EXTRA_ROLE_IDS,
  ROLE_LABELS,
  TIER_RANKS,
  STAFF_RANKS,
  ROLE_PREFIXES,
  PREFIX_PRIORITY,
  getRobloxLinks,
  getGroupMembership,
  getMembershipRoles,
  lookupRobloxUser,
  linkRobloxAccount,
  syncRobloxTierForDiscordUser,
  syncRobloxUpdateForDiscordUser,
  addRobloxRolesForDiscordUser,
};
