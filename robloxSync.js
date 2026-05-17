const db = require('./database');
const { saveToDiscord } = require('./discordBackup');
const { sendStaffAuditLog } = require('./auditLog');

const ROBLOX_GROUP_ID = '301637944';

const TIER_ROLE_IDS = {
  V: '2',
  IV: '3',
  III: '4',
  II: '9',
  I: '10',
};

const STAFF_ROLE_IDS = {
  trial_coordinator: '11',
  coordinator: '12',
  senior_coordinator: '13',
  vp_moderator: '14',
  vp_senior_mod: '15',
  vp_admin: '16',
};

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
  const source = membership?.path || membership?.name || membership?.id;
  if (!source) return null;
  return String(source).split('/').pop();
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
  if (!membershipId) throw new Error('Could not read Roblox group membership ID.');

  const currentRoles = getMembershipRoles(membership);
  const tierRoles = Object.values(TIER_ROLE_IDS);
  const removed = [];

  for (const roleId of tierRoles) {
    if (roleId !== targetRoleId && currentRoles.includes(roleId)) {
      await unassignRole(membershipId, roleId);
      removed.push(roleId);
    }
  }

  if (!currentRoles.includes(targetRoleId)) {
    await assignRole(membershipId, targetRoleId);
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

  return { skipped: false, robloxUserId: link.robloxUserId, robloxUsername: link.robloxUsername, targetRoleId, removed };
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
  getRobloxLinks,
  lookupRobloxUser,
  linkRobloxAccount,
  syncRobloxTierForDiscordUser,
};
