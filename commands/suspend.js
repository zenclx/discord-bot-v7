const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');
const { canManageMatch } = require('./creatematch');

const SUSPENSION_LOG_CHANNEL_ID = '1405739741042704444';
const FINES_BOARD_CHANNEL_ID = '1526736060531478659';
const SUSPENSION_ROLE_ID = process.env.SUSPENSION_ROLE_ID || null;

function getSuspensions(data) {
  if (!data.suspensions) data.suspensions = [];
  return data.suspensions;
}

function makeFineId() {
  return `fine-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function updateFinesBoard(client) {
  try {
    const ch = await client.channels.fetch(FINES_BOARD_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    const data = db.get();
    const suspensions = getSuspensions(data);

    const unpaid = suspensions.filter(f => !f.paid);
    const paid = suspensions.filter(f => f.paid);

    const formatEntry = (f, index) => {
      const date = new Date(f.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `**${index + 1}.** <@${f.userId}> — ${f.robux} Robux\n> ${f.reason}\n> ID: \`${f.fineId}\` • ${date}`;
    };

    const unpaidText = unpaid.length
      ? unpaid.map(formatEntry).join('\n\n')
      : '*No unpaid fines.*';

    const paidText = paid.length
      ? paid.slice(-10).map(formatEntry).join('\n\n')
      : '*No paid fines.*';

    const embed = new EmbedBuilder()
      .setTitle('Suspended Players — Fine Registry')
      .setColor(0xe74c3c)
      .addFields(
        { name: `Unpaid Fines (${unpaid.length})`, value: unpaidText.slice(0, 1024) },
        { name: `Paid Fines (${Math.min(paid.length, 10)} shown)`, value: paidText.slice(0, 1024) },
      )
      .setFooter({ text: 'Use /markpaid <fine_id> to mark a fine as paid' })
      .setTimestamp();

    const rows = [];
    const markableUnpaid = unpaid.slice(0, 5);
    if (markableUnpaid.length > 0) {
      const row = new ActionRowBuilder().addComponents(
        ...markableUnpaid.map(f =>
          new ButtonBuilder()
            .setCustomId(`mark_fine_paid_${f.fineId}`)
            .setLabel(`Mark Paid — #${f.fineId.slice(-5)}`)
            .setStyle(ButtonStyle.Success),
        ),
      );
      rows.push(row);
    }

    const storedData = db.get();
    if (!storedData.finesBoard) storedData.finesBoard = {};
    const existingMsgId = storedData.finesBoard.messageId;

    let msg = null;
    if (existingMsgId) {
      msg = await ch.messages.fetch(existingMsgId).catch(() => null);
    }

    if (msg) {
      await msg.edit({ embeds: [embed], components: rows });
    } else {
      msg = await ch.send({ embeds: [embed], components: rows });
      storedData.finesBoard.messageId = msg.id;
      db.set(storedData);
    }
  } catch (e) {
    console.error('updateFinesBoard error:', e.message);
  }
}

const suspendCommand = {
  data: new SlashCommandBuilder()
    .setName('suspend')
    .setDescription('Suspend a player and log a robux fine')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Player to suspend').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for suspension').setRequired(true))
    .addIntegerOption(o => o.setName('robux').setDescription('Robux fine amount').setRequired(true).setMinValue(0)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: '❌ You do not have permission to suspend players.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const robux = interaction.options.getInteger('robux');

    const data = db.get();
    const suspensions = getSuspensions(data);

    const fineId = makeFineId();
    const fine = {
      fineId,
      userId: target.id,
      reason,
      robux,
      timestamp: Date.now(),
      paid: false,
      suspendedBy: interaction.user.id,
    };
    suspensions.push(fine);
    db.set(data);

    // Assign suspension role if configured
    if (SUSPENSION_ROLE_ID) {
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.roles.add(SUSPENSION_ROLE_ID);
      } catch (e) {
        console.error(`Failed to assign suspension role to ${target.id}:`, e.message);
      }
    }

    // Log embed to suspension channel
    const logChannel = await interaction.client.channels.fetch(SUSPENSION_LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setTitle('Player Suspended')
        .setColor(0xe74c3c)
        .addFields(
          { name: 'Player', value: `<@${target.id}> (${target.tag})`, inline: true },
          { name: 'Robux Fine', value: `${robux} Robux`, inline: true },
          { name: 'Suspended By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Reason', value: reason },
          { name: 'Fine ID', value: `\`${fineId}\``, inline: true },
        )
        .setTimestamp();
      await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
    }

    await updateFinesBoard(interaction.client);

    return interaction.editReply({
      content: `✅ <@${target.id}> has been suspended.\nFine ID: \`${fineId}\` — **${robux} Robux** — ${reason}`,
    });
  },
};

const unsuspendCommand = {
  data: new SlashCommandBuilder()
    .setName('unsuspend')
    .setDescription('Remove a player suspension')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Player to unsuspend').setRequired(true)),

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: '❌ You do not have permission to unsuspend players.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const target = interaction.options.getUser('user');

    if (SUSPENSION_ROLE_ID) {
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.roles.remove(SUSPENSION_ROLE_ID);
      } catch (e) {
        console.error(`Failed to remove suspension role from ${target.id}:`, e.message);
      }
    }

    return interaction.editReply({ content: `✅ <@${target.id}> has been unsuspended.` });
  },
};

const markPaidCommand = {
  data: new SlashCommandBuilder()
    .setName('markpaid')
    .setDescription('Mark a suspension fine as paid')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o =>
      o.setName('fine_id').setDescription('Fine ID to mark as paid (from the fines board)').setRequired(true).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const data = db.get();
    const unpaid = (data.suspensions || []).filter(f => !f.paid);
    const choices = unpaid
      .filter(f => f.fineId.toLowerCase().includes(focused) || f.userId.includes(focused))
      .slice(0, 25)
      .map(f => ({
        name: `${f.fineId} — <@${f.userId}> — ${f.robux} Robux`.slice(0, 100),
        value: f.fineId,
      }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: '❌ You do not have permission.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const fineId = interaction.options.getString('fine_id');
    const data = db.get();
    const suspensions = getSuspensions(data);
    const fine = suspensions.find(f => f.fineId === fineId);

    if (!fine) return interaction.editReply({ content: `❌ Fine \`${fineId}\` not found.` });
    if (fine.paid) return interaction.editReply({ content: `❌ Fine \`${fineId}\` is already marked as paid.` });

    fine.paid = true;
    fine.paidAt = Date.now();
    fine.markedPaidBy = interaction.user.id;
    db.set(data);

    await updateFinesBoard(interaction.client);

    return interaction.editReply({
      content: `✅ Fine \`${fineId}\` for <@${fine.userId}> (**${fine.robux} Robux**) marked as paid.`,
    });
  },
};

module.exports = {
  suspendCommand,
  unsuspendCommand,
  markPaidCommand,
  updateFinesBoard,
};
