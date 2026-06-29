const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');
const { saveToDiscord } = require('../discordBackup');
const { buildBracketImage } = require('../bracketImage');

const TOURNEY_LOG_CHANNEL_ID = '1520930139825901822';
const DARK_BLUE = 0x1f4fd8;

function getTournamentReg(data, guildId) {
  if (!data.tournamentRegistration) data.tournamentRegistration = {};
  if (!data.tournamentRegistration[guildId]) {
    data.tournamentRegistration[guildId] = { active: false, registrations: [] };
  }
  return data.tournamentRegistration[guildId];
}

function buildTournamentBracket(registrations) {
  const sorted = [...registrations].sort((a, b) => b.elo - a.elo);
  // Interleave seeds: 1 vs last, 2 vs second-last, etc.
  const ordered = [];
  let left = 0;
  let right = sorted.length - 1;
  while (left <= right) {
    ordered.push(sorted[left++]);
    if (left <= right) ordered.push(sorted[right--]);
  }

  const round = [];
  for (let i = 0; i + 1 < ordered.length; i += 2) {
    const p1 = ordered[i];
    const p2 = ordered[i + 1];
    round.push({
      p1: p1.username,
      p2: p2.username,
      p1Tag: `${p1.username} (${p1.elo})`,
      p2Tag: `${p2.username} (${p2.elo})`,
      winner: null,
      bye: false,
    });
  }
  if (ordered.length % 2 !== 0) {
    const p = ordered[ordered.length - 1];
    round.push({
      p1: p.username,
      p2: null,
      p1Tag: `${p.username} (${p.elo})`,
      winner: p.username,
      bye: true,
      byePlayer: true,
    });
  }
  return [round];
}

async function handleTourneyRegistration(interaction) {
  const username = interaction.fields.getTextInputValue('treg_username').trim();
  const eloStr = interaction.fields.getTextInputValue('treg_elo').trim();

  await interaction.deferReply({ flags: 64 });

  const elo = parseInt(eloStr, 10);
  if (isNaN(elo) || elo < 0 || elo > 99999) {
    return interaction.editReply({ content: 'Invalid ELO value. Please enter a whole number (e.g. 1200).' });
  }

  const data = db.get();
  const reg = getTournamentReg(data, interaction.guildId);

  if (!reg.active) {
    return interaction.editReply({ content: 'Registration has already closed.' });
  }

  const existingIdx = reg.registrations.findIndex(r => r.discordId === interaction.user.id);
  const isUpdate = existingIdx >= 0;

  if (isUpdate) {
    reg.registrations[existingIdx] = { discordId: interaction.user.id, username, elo, registeredAt: Date.now() };
  } else {
    reg.registrations.push({ discordId: interaction.user.id, username, elo, registeredAt: Date.now() });
  }

  db.set(data);
  await saveToDiscord(interaction.client);

  const logChannel = await interaction.client.channels.fetch(TOURNEY_LOG_CHANNEL_ID).catch(() => null);
  if (logChannel) {
    await logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(isUpdate ? 'Registration Updated' : 'New Registration')
          .setColor(DARK_BLUE)
          .addFields(
            { name: 'Discord', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Username', value: username, inline: true },
            { name: 'ELO', value: String(elo), inline: true },
          )
          .setTimestamp(),
      ],
    });
  }

  return interaction.editReply({
    content: `${isUpdate ? 'Updated registration' : 'Registered'} as **${username}** with ELO **${elo}**.`,
  });
}

const startRegisterCommand = {
  data: new SlashCommandBuilder()
    .setName('startregister')
    .setDescription('Open tournament registration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const data = db.get();
    const reg = getTournamentReg(data, interaction.guildId);

    if (reg.active) {
      return interaction.editReply({ content: 'Registration is already open.' });
    }

    reg.active = true;
    reg.registrations = [];
    db.set(data);
    await saveToDiscord(interaction.client);

    const logChannel = await interaction.client.channels.fetch(TOURNEY_LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      await logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Tournament Registration Open')
            .setColor(0x43b581)
            .setDescription('Registration is now open! Use `/register` to sign up with your username and ELO.')
            .setTimestamp(),
        ],
      });
    }

    await interaction.editReply({ content: 'Tournament registration is now open. Players can use `/register` to sign up.' });
  },
};

const registerCommand = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register for the upcoming tournament with your username and ELO'),

  async execute(interaction) {
    const data = db.get();
    const reg = getTournamentReg(data, interaction.guildId);

    if (!reg.active) {
      return interaction.reply({ content: 'Tournament registration is not currently open.', flags: 64 });
    }

    const modal = new ModalBuilder()
      .setCustomId('tourney_register_modal')
      .setTitle('Tournament Registration');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('treg_username')
          .setLabel('Username')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('treg_elo')
          .setLabel('ELO Rating')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. 1200')
          .setMaxLength(6),
      ),
    );

    await interaction.showModal(modal);
  },
};

const endRegisterCommand = {
  data: new SlashCommandBuilder()
    .setName('endregister')
    .setDescription('Close registration and generate the tournament bracket')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const data = db.get();
    const reg = getTournamentReg(data, interaction.guildId);

    if (!reg.active) {
      return interaction.editReply({ content: 'No active tournament registration to end.' });
    }

    const registrations = reg.registrations || [];
    if (registrations.length < 2) {
      return interaction.editReply({
        content: `Need at least 2 players to generate a bracket. Currently ${registrations.length} registered.`,
      });
    }

    reg.active = false;
    db.set(data);
    await saveToDiscord(interaction.client);

    const bracket = buildTournamentBracket(registrations);
    const buf = buildBracketImage(bracket, 0, null);
    const attachment = new AttachmentBuilder(buf, { name: 'bracket.png' });

    const seeded = [...registrations].sort((a, b) => b.elo - a.elo);
    const playerList = seeded
      .map((r, i) => `**${i + 1}.** ${r.username} — ELO: ${r.elo} (<@${r.discordId}>)`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Tournament Bracket')
      .setColor(DARK_BLUE)
      .setDescription(`**${registrations.length}** players registered — seeded by ELO`)
      .addFields({ name: 'Players (by seed)', value: playerList.slice(0, 1024) })
      .setImage('attachment://bracket.png')
      .setTimestamp();

    const logChannel = await interaction.client.channels.fetch(TOURNEY_LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      await logChannel.send({ embeds: [embed], files: [attachment] });
    }

    await interaction.editReply({
      content: `Registration closed. Bracket generated with **${registrations.length}** players and posted to <#${TOURNEY_LOG_CHANNEL_ID}>.`,
    });
  },
};

module.exports = { startRegisterCommand, registerCommand, endRegisterCommand, handleTourneyRegistration };
