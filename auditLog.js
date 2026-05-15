const { EmbedBuilder } = require('discord.js');

const STAFF_AUDIT_CHANNEL_ID = '1504898537060831392';

async function sendStaffAuditLog(client, guildId, title, fields = [], actorId = null) {
  try {
    const channel = await client.channels.fetch(STAFF_AUDIT_CHANNEL_ID).catch(() => null);
    if (!channel || channel.guildId !== guildId) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xf59e0b)
      .setTimestamp();

    if (actorId) embed.setFooter({ text: `Staff: ${actorId}` });
    const normalized = fields
      .filter(field => field?.name && field?.value !== undefined && field?.value !== null)
      .map(field => ({
        name: String(field.name).slice(0, 256),
        value: String(field.value).slice(0, 1024),
        inline: Boolean(field.inline),
      }));

    if (normalized.length) embed.addFields(normalized);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('sendStaffAuditLog error:', error.message);
  }
}

module.exports = { STAFF_AUDIT_CHANNEL_ID, sendStaffAuditLog };
