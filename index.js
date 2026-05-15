

// AUTO ELO LEADERBOARD UPDATE
async function refreshEloLeaderboard(channel, eloData) {
  if (!channel) return;

  const sorted = Object.entries(eloData)
    .sort((a, b) => (b[1].elo || 0) - (a[1].elo || 0))
    .slice(0, 20);

  const lines = await Promise.all(sorted.map(async ([id, data], i) => {
    let userTag = id;

    try {
      const user = await channel.client.users.fetch(id);
      userTag = user.tag;
    } catch {}

    return `**${i + 1}.** ${userTag} • ${data.elo || 0} ELO • ${data.wins || 0}W-${data.losses || 0}L`;
  }));

  return lines.join('\n');
}

require('dotenv').config();
require('./keepalive');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const db = require('./database');
const { restoreFromDiscord, scheduleDiscordBackup } = require('./discordBackup');
const { buildScoreboardEmbed } = require('./utils');
const { loadCommands } = require('./commands/registry');

function cleanEnvValue(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

const DISCORD_TOKEN = cleanEnvValue(process.env.DISCORD_TOKEN).replace(/^Bot\s+/i, '');
const CLIENT_ID = cleanEnvValue(process.env.CLIENT_ID);
const GUILD_ID = cleanEnvValue(process.env.GUILD_ID);

for (const [name, value] of Object.entries({ DISCORD_TOKEN, CLIENT_ID, GUILD_ID })) {
  if (!value) {
    console.error(`Missing required Render environment variable: ${name}`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

const localCommands = loadCommands();
const commandsData = localCommands.map(command => command.data.toJSON());
for (const command of localCommands) client.commands.set(command.data.name, command);
console.log(`Loaded slash commands: ${localCommands.map(command => command.data.name).join(', ')}`);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const connectedGuildIds = client.guilds.cache.map(guild => guild.id);
  const guildIds = [...new Set([GUILD_ID, ...connectedGuildIds].filter(Boolean))];
  let successfulGuilds = 0;

  console.log(`Connected guilds: ${connectedGuildIds.join(', ') || 'none'}`);
  console.log(`Registering ${commandsData.length} slash commands: ${localCommands.map(command => command.data.name).join(', ')}`);

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commandsData });
      console.log(`Commands registered for guild ${guildId}.`);
      successfulGuilds++;
    } catch (e) {
      console.error(`Guild command registration failed for ${guildId}: ${e.code || ''} ${e.message}`);
    }
  }

  if (successfulGuilds > 0) {
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
      console.log('Cleared global commands to prevent duplicates.');
    } catch (globalClearError) {
      console.error('Failed to clear global commands:', globalClearError.message);
    }
    return;
  }

  console.error('No guild command registrations succeeded. Falling back to global commands.');
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
    console.log('Commands registered globally. They can take up to 1 hour to appear.');
  } catch (globalError) {
    console.error('Global command registration failed:', globalError);
  }
}

function restoreScheduledMatches() {
  const data = db.get();
  try {
    const { scheduledTimers } = require('./commands/schedulematch');
    for (const [id, s] of Object.entries(data.scheduledMatches || {})) {
      const delay = s.startsAt - Date.now();
      if (delay <= 0) { delete data.scheduledMatches[id]; continue; }
      const timer = setTimeout(async () => {
        scheduledTimers.delete(id);
        try {
          const fresh = db.get();
          if (!fresh.scheduledMatches?.[id]) return;
          delete fresh.scheduledMatches[id];
          db.set(fresh);
          const ch = await client.channels.fetch(s.channelId);
          const { EmbedBuilder } = require('discord.js');
          const embed = new EmbedBuilder().setTitle('⚔️ Scheduled Match — Queue Now Open!').setColor(0x00c853)
            .setDescription(`The scheduled ${s.type.toUpperCase()} match is now open! Use \`/creatematch\` to start.`).setTimestamp();
          if (s.prize) embed.addFields({ name: '🎁 Prize', value: s.prize });
          await ch.send({ content: '@here', embeds: [embed] });
        } catch (e) { console.error('Restore scheduled match error:', e.message); }
      }, delay);
      scheduledTimers.set(id, timer);
    }
    db.set(data);
  } catch {}
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await restoreFromDiscord(client);
  db.onSet(() => scheduleDiscordBackup(client));
  await registerCommands();
  restoreScheduledMatches();
});

// ── Match number helpers ──────────────────────────────────────────────────────
function getNextMatchNumber(guildId) {
  const data = db.get();
  if (!data.matchCounters) data.matchCounters = {};
  const next = (data.matchCounters[guildId] ?? -1) + 1;
  data.matchCounters[guildId] = next;
  db.set(data);
  return next;
}

function resetMatchCounter(guildId) {
  const data = db.get();
  if (!data.matchCounters) data.matchCounters = {};
  data.matchCounters[guildId] = -1;
  db.set(data);
}

client.on('interactionCreate', async interaction => {
  // Autocomplete
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd?.autocomplete) try { await cmd.autocomplete(interaction); } catch {}
    return;
  }

  // Slash commands
  if (interaction.isChatInputCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    try { await cmd.execute(interaction, { getNextMatchNumber, resetMatchCounter }); }
    catch (e) {
      console.error(e);
      const p = { content: '❌ An error occurred.', flags: 64 };
      if (interaction.replied || interaction.deferred) await interaction.followUp(p).catch(() => {});
      else await interaction.reply(p).catch(() => {});
    }
    return;
  }

  if (!interaction.isButton()) return;
  const { customId } = interaction;
  try {

  // ── Scoreboard: reset ─────────────────────────────────────────────────────
  if (customId.startsWith('reset_confirm_')) {
    const sbId = customId.replace('reset_confirm_', '');
    const data = db.get();
    const sb = data.scoreboards[sbId];
    if (!sb) return interaction.update({ content: '❌ Not found.', components: [] });
    sb.scores = {};
    data.scoreboards[sbId] = sb;
    db.set(data);
    try {
      const ch = await client.channels.fetch(sb.channelId);
      const msg = await ch.messages.fetch(sb.messageId);
      await msg.edit({ embeds: [buildScoreboardEmbed(sb)] });
    } catch {}
    return interaction.update({ content: `✅ **${sb.name}** has been reset.`, components: [] });
  }
  if (customId === 'reset_cancel') return interaction.update({ content: 'Cancelled.', components: [] });

  // ── Scoreboard: delete ────────────────────────────────────────────────────
  if (customId.startsWith('delete_confirm_')) {
    const sbId = customId.replace('delete_confirm_', '');
    const data = db.get();
    const sb = data.scoreboards[sbId];
    if (!sb) return interaction.update({ content: '❌ Not found.', components: [] });
    try { const ch = await client.channels.fetch(sb.channelId); const msg = await ch.messages.fetch(sb.messageId); await msg.delete(); } catch {}
    const name = sb.name;
    delete data.scoreboards[sbId];
    db.set(data);
    return interaction.update({ content: `🗑️ **${name}** deleted.`, components: [] });
  }
  if (customId === 'delete_cancel') return interaction.update({ content: 'Cancelled.', components: [] });

  // Load match helpers
  const {
    buildQueueEmbed, buildQueueCancelledEmbed, timers, startBracket, canManageMatch, scheduleChannelDelete,
    buildNextRound, fetchDisplayNames, postOrUpdateBracket, logMatchResult,
    revealPrediction, scheduleMatchReminder, dmUser, postPredictionPoll, DEFAULT_LOG_CHANNEL_ID,
  } = require('./commands/creatematch');
  const { checkAchievements } = require('./commands/achievements');
  const { applyMatchElo, applyMatchStreaks, buildMatchEloSummary, getEloData } = require('./commands/elo');

  function makeJoinRow(matchId) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
      new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
      new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
    );
  }

  function makeQueueRows(matchId) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cancel_queue_${matchId}`).setLabel('Cancel Queue').setStyle(ButtonStyle.Danger),
    );
    return [makeJoinRow(matchId), cancelRow];
  }

  // ── Bo3 vote buttons ──────────────────────────────────────────────────────
  // Format: bo3|matchId|choice
  if (customId.startsWith('bo3|')) {
    const parts = customId.split('|');
    const choice = parts[parts.length - 1]; // all / finals / none / close
    const voteId = parts.slice(0, -1).join('|'); // bo3|matchId

    if (choice === 'close') {
      if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: 64 });
      const finisher = global._bo3Finishers?.get(voteId);
      if (finisher) { await finisher(); global._bo3Finishers.delete(voteId); }
      return interaction.reply({ content: '✅ Bo3 vote closed.', flags: 64 });
    }

    const data = db.get();
    const vote = data.bo3votes?.[voteId];
    if (!vote || vote.closed) return interaction.reply({ content: '❌ Vote is closed.', flags: 64 });
    vote.votes[interaction.user.id] = choice;
    db.set(data);
    const labels = { all: 'Bo3 All', finals: 'Finals Only Bo3', none: 'Standard Bo1' };
    return interaction.reply({ content: `✅ Vote recorded: **${labels[choice] || choice}**`, flags: 64 });
  }

  // ── Region vote buttons ───────────────────────────────────────────────────
  // Format: region|matchId|choice
  if (customId.startsWith('region|')) {
    const parts = customId.split('|');
    const choice = parts[parts.length - 1]; // NA / AEST / GMT / close
    const voteId = parts.slice(0, -1).join('|');

    if (choice === 'close') {
      if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: 64 });
      const finisher = global._regionFinishers?.get(voteId);
      if (finisher) { await finisher(); global._regionFinishers.delete(voteId); }
      return interaction.reply({ content: '✅ Region vote closed.', flags: 64 });
    }

    const data = db.get();
    const vote = data.regionvotes?.[voteId];
    if (!vote || vote.closed) return interaction.reply({ content: '❌ Vote is closed.', flags: 64 });
    vote.votes[interaction.user.id] = choice;
    db.set(data);
    const flags = { NA: '🌎', AEST: '🌏', GMT: '🌍' };
    return interaction.reply({ content: `✅ Voted for **${flags[choice] || ''} ${choice}**`, flags: 64 });
  }

  // ── Prediction vote buttons ───────────────────────────────────────────────
  // Format: pred|matchId|round|matchIndex|p1 or p2
  if (customId.startsWith('pred|')) {
    const parts = customId.split('|');
    const side = parts[parts.length - 1]; // p1 or p2
    const predId = parts.slice(0, -1).join('|'); // pred|matchId|round|matchIndex
    const data = db.get();
    const pred = data.predictions?.[predId];
    if (!pred) return interaction.reply({ content: '❌ Prediction not found.', flags: 64 });
    const already = pred.votes[interaction.user.id];
    pred.votes[interaction.user.id] = side;
    db.set(data);
    const label = side === 'p1' ? pred.p1Label : pred.p2Label;
    return interaction.reply({ content: already ? `✅ Vote changed to **${label}**` : `✅ Voted for **${label}**`, flags: 64 });
  }

  // ── Queue: join ───────────────────────────────────────────────────────────
  if (customId.startsWith('join_queue_')) {
    const matchId = customId.replace('join_queue_', '');
    let data = db.get();
    if (!data.matches) data.matches = {};
    let match = data.matches[matchId];
    if (!match) {
      await restoreFromDiscord(client);
      data = db.get();
      if (!data.matches) data.matches = {};
      match = data.matches[matchId];
    }
    if (!match || match.status !== 'queuing') {
      console.warn(`Join queue rejected for ${matchId}: ${match ? `status=${match.status}` : 'match missing'}`);
      return interaction.reply({ content: 'Queue is closed.', flags: 64 });
    }
    if (match.queue.includes(interaction.user.id)) return interaction.reply({ content: '⚠️ You are already in the queue!', flags: 64 });
    match.queue.push(interaction.user.id);
    data.matches[matchId] = match;
    db.set(data);
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: makeQueueRows(matchId) });
  }

  // ── Queue: leave ──────────────────────────────────────────────────────────
  if (customId.startsWith('leave_queue_')) {
    const matchId = customId.replace('leave_queue_', '');
    const data = db.get();
    if (!data.matches) data.matches = {};
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', flags: 64 });
    match.queue = match.queue.filter(id => id !== interaction.user.id);
    data.matches[matchId] = match;
    db.set(data);
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: makeQueueRows(matchId) });
  }

  // ── Queue: +1 minute ─────────────────────────────────────────────────────
  if (customId.startsWith('addminute_')) {
    const matchId = customId.replace('addminute_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: 64 });
    const data = db.get();
    if (!data.matches) data.matches = {};
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue closed.', flags: 64 });
    match.endsAt += 60000;
    data.matches[matchId] = match;
    db.set(data);
    const t = timers.get(matchId);
    if (t) {
      clearTimeout(t.timer);
      const newTimer = setTimeout(async () => { clearInterval(t.interval); await startBracket(client, matchId); }, match.endsAt - Date.now());
      timers.set(matchId, { ...t, timer: newTimer });
    }
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: makeQueueRows(matchId) });
  }

  // ── Queue: force start ────────────────────────────────────────────────────
  if (customId.startsWith('cancel_queue_')) {
    const matchId = customId.replace('cancel_queue_', '');
    const data = db.get();
    if (!data.matches) data.matches = {};
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: 'Queue is already closed.', flags: 64 });
    if (interaction.user.id !== match.hostId && !canManageMatch(interaction.member)) {
      return interaction.reply({ content: 'Only the host or match staff can cancel this queue.', flags: 64 });
    }
    const t = timers.get(matchId);
    if (t) { clearTimeout(t.timer); clearInterval(t.interval); timers.delete(matchId); }
    delete data.matches[matchId];
    db.set(data);
    return interaction.update({
      embeds: [buildQueueCancelledEmbed(match, 'Queue cancelled by the host before the match started.')],
      components: [],
    });
  }

  if (customId.startsWith('forcestart_')) {
    const matchId = customId.replace('forcestart_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: 64 });
    const data = db.get();
    if (!data.matches) data.matches = {};
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue not open.', flags: 64 });
    const minPlayers = match.testMatch ? (match.type === '1v1' ? 2 : 4) : (match.type === '1v1' ? 4 : 6);
    if (match.queue.length < minPlayers) return interaction.reply({ content: `❌ Need **${minPlayers}** players. Have **${match.queue.length}**.`, flags: 64 });
    const t = timers.get(matchId);
    if (t) { clearTimeout(t.timer); clearInterval(t.interval); timers.delete(matchId); }
    await interaction.deferUpdate();
    await startBracket(client, matchId);
    return;
  }

  // ── Winner selection ──────────────────────────────────────────────────────
  // Format: win|matchId|round|matchIndex|winnerId  (pipe-separated, no ambiguity)
  if (customId.startsWith('resend_bracket_')) {
    const matchId = customId.replace('resend_bracket_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: 64 });
    const data = db.get();
    const match = data.matches?.[matchId];
    if (!match || !match.bracket?.length) return interaction.reply({ content: 'No active bracket found.', flags: 64 });
    match.bracketMessageId = null;
    data.matches[matchId] = match;
    db.set(data);
    await postOrUpdateBracket(client, match);
    return interaction.reply({ content: 'Bracket resent.', flags: 64 });
  }

  if (customId.startsWith('cancel_match_')) {
    const matchId = customId.replace('cancel_match_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: 64 });
    const data = db.get();
    const match = data.matches?.[matchId];
    if (!match) return interaction.reply({ content: 'Match not found.', flags: 64 });
    match.status = 'cancelled';
    data.matches[matchId] = match;
    db.set(data);
    if (match.privateChannelId) {
      const ch = await client.channels.fetch(match.privateChannelId).catch(() => null);
      if (ch) await ch.send('Match cancelled by staff.').catch(() => {});
    }
    return interaction.reply({ content: 'Match cancelled.', flags: 64 });
  }

  if (customId.startsWith('win|') || customId.startsWith('dq|') || customId.startsWith('noshow|')) {
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', flags: 64 });

    const parts = customId.split('|');
    // parts: ['win', matchId, round, matchIndex, winnerId]
    if (parts.length !== 5) return interaction.reply({ content: '❌ Malformed button ID.', flags: 64 });

    await interaction.deferReply({ flags: 64 });

    const [action, matchId, roundStr, matchIndexStr, selectedUserId] = parts;
    const round = parseInt(roundStr);
    const matchIndex = parseInt(matchIndexStr);

    const data = db.get();
    const match = data.matches[matchId];
    if (!match) return interaction.editReply({ content: 'Match not found. It may have expired.' });

    const bracketRound = match.bracket[round];
    if (!bracketRound) return interaction.editReply({ content: 'Round not found.' });

    const bracketMatch = bracketRound[matchIndex];
    if (!bracketMatch) return interaction.editReply({ content: 'Match slot not found.' });
    if (bracketMatch.winner) return interaction.editReply({ content: 'Winner already selected for that match.' });

    const winnerId = action === 'win'
      ? selectedUserId
      : (bracketMatch.p1 === selectedUserId ? bracketMatch.p2 : bracketMatch.p1);
    if (!winnerId) return interaction.editReply({ content: 'Could not determine a winner for that match.' });
    const loserId = bracketMatch.p1 === winnerId ? bracketMatch.p2 : bracketMatch.p1;
    bracketMatch.winner = winnerId;
    if (action === 'dq') bracketMatch.resultReason = `<@${selectedUserId}> DQ`;
    if (action === 'noshow') bracketMatch.resultReason = `<@${selectedUserId}> no-show`;

    // Reveal prediction
    const predId = `pred|${matchId}|${round}|${matchIndex}`;
    await revealPrediction(client, predId, winnerId);

    // Credit scoreboard win
    if (match.scoreboardName) {
      const sb = Object.values(data.scoreboards || {}).find(
        s => s.guildId === match.guildId && s.name.toLowerCase() === match.scoreboardName.toLowerCase()
      );
      if (sb) {
        sb.scores[winnerId] = (sb.scores[winnerId] || 0) + 1;
        data.scoreboards[sb.id] = sb;
        try {
          const ch = await client.channels.fetch(sb.channelId);
          const msg = await ch.messages.fetch(sb.messageId);
          await msg.edit({ embeds: [buildScoreboardEmbed(sb)] });
        } catch {}
      }
    }

    // Check achievements
    try {
      const guild = await client.guilds.fetch(match.guildId);
      const newAchs = await checkAchievements(client, guild, winnerId, data);
      if (newAchs.length && match.privateChannelId) {
        const { ACHIEVEMENTS } = require('./commands/achievements');
        const earned = newAchs.map(id => ACHIEVEMENTS.find(a => a.id === id)).filter(Boolean);
        const ch = await client.channels.fetch(match.privateChannelId);
        await ch.send(`🏅 <@${winnerId}> earned: ${earned.map(a => `${a.emoji} **${a.name}**`).join(', ')}!`);
      }
    } catch {}

    if (match.privateChannelId) {
      try {
        const ch = await client.channels.fetch(match.privateChannelId);
        await ch.send(`Winner recorded: <@${winnerId}> won Round ${round + 1}, Match ${matchIndex + 1}.`);
      } catch {}
    }

    const roundComplete = bracketRound.every(m => m.winner !== null);
    const uniqueWinners = roundComplete ? [...new Set(bracketRound.map(m => m.winner))] : [];
    const isTournamentFinal = roundComplete && uniqueWinners.length === 1;

    data.matches[matchId] = match;
    db.set(data);
    await applyMatchElo(client, match, winnerId, loserId || null, round, isTournamentFinal);

    if (roundComplete) {
      if (uniqueWinners.length === 1) {
        // 🏆 Tournament over
        const champion = uniqueWinners[0];
        match.status = 'complete';
        match.champion = champion;
        const completeData = db.get();
        completeData.matches[matchId] = match;
        db.set(completeData);
        await applyMatchStreaks(client, match, champion);

        try { const guild = await client.guilds.fetch(match.guildId); await checkAchievements(client, guild, champion, completeData); } catch {}
        await postOrUpdateBracket(client, match);

        if (match.privateChannelId) {
          try {
            const ch = await client.channels.fetch(match.privateChannelId);
            const { EmbedBuilder } = require('discord.js');
            const champEntry = bracketRound.find(m => m.winner === champion);
            const champTag = champEntry?.p1Tag || champEntry?.p2Tag || '';
            const eloData = getEloData(db.get());
            const eloSummary = buildMatchEloSummary(match, eloData);
            const finalEmbed = new EmbedBuilder()
              .setTitle('🏆 Tournament Complete!').setColor(0xffd700)
              .setDescription(`👑 **Champion: <@${champion}>**${champTag ? ` (${champTag})` : ''}\n\nGG to all players!${match.prize ? `\n\n🎁 **Prize:** ${match.prize}` : ''}`)
              .addFields({ name: 'Match ELO Changes', value: eloSummary.slice(0, 1024), inline: false })
              .setTimestamp();
            await ch.send({ embeds: [finalEmbed] });
            const logChannelId = db.get().settings?.[match.guildId]?.logChannelId || DEFAULT_LOG_CHANNEL_ID;
            const logCh = await client.channels.fetch(logChannelId).catch(() => null);
            if (logCh) {
              const bracketSummary = match.bracket.map((br, r) =>
                br.map((bm, i) => {
                  const left = bm.teamLabel1 || bm.p1Tag || `<@${bm.p1}>`;
                  const right = bm.teamLabel2 || bm.p2Tag || (bm.p2 ? `<@${bm.p2}>` : 'BYE');
                  const reason = bm.resultReason ? ` (${bm.resultReason})` : '';
                  return `R${r + 1} M${i + 1}: ${left} vs ${right} -> <@${bm.winner}>${reason}`;
                }).join('\n')
              ).join('\n');
              await logCh.send({
                content: match.queue.map(id => `<@${id}>`).join(' '),
                embeds: [
                  new EmbedBuilder()
                    .setTitle(`Match #${match.matchNum ?? '?'} Complete`)
                    .setColor(0xffd700)
                    .setDescription(`Champion: <@${champion}>`)
                    .addFields(
                      { name: 'ELO Changes', value: eloSummary.slice(0, 1024), inline: false },
                      { name: 'Bracket', value: bracketSummary.slice(0, 1024), inline: false },
                    )
                    .setTimestamp(),
                ],
                allowedMentions: { parse: ['users'] },
              });
            }
          } catch {}
          scheduleChannelDelete(client, match.privateChannelId);
        }

        await dmUser(client, champion,
          `🏆 **Congratulations!** You won Match #${match.matchNum ?? '?'} (${match.type.toUpperCase()})!${match.prize ? `\n🎁 Prize: ${match.prize}` : ''}`
        );

        return interaction.editReply({ content: `Tournament over! Champion: <@${champion}>` });
      }

      // Advance to next round
      const nextRound = buildNextRound(bracketRound);
      try { const guild = await client.guilds.fetch(match.guildId); await fetchDisplayNames(guild, nextRound); } catch {}

      match.bracket.push(nextRound);
      match.currentRound = round + 1;
      const advanceData = db.get();
      advanceData.matches[matchId] = match;
      db.set(advanceData);

      for (let i = 0; i < nextRound.length; i++) {
        const bm = nextRound[i];
        if (!bm.bye && bm.p1 && bm.p2) await postPredictionPoll(client, match, bm, round + 1, i);
      }
      for (let i = 0; i < nextRound.length; i++) {
        if (!nextRound[i].bye) scheduleMatchReminder(client, match, matchId, i, round + 1);
      }
      for (const bm of nextRound) {
        if (bm.bye) continue;
        for (const pid of [bm.p1, bm.p2].filter(Boolean)) {
          await dmUser(client, pid, `⚔️ **Next round!** You're up in Round ${round + 2} of Match #${match.matchNum ?? '?'}. Head to <#${match.privateChannelId}>!`);
        }
      }

      await postOrUpdateBracket(client, match);
      return interaction.editReply({ content: `Round ${round + 1} complete - Round ${round + 2} is now live!` });
    }

    // Round still going — grant ELO, update bracket image
    const pendingData = db.get();
    pendingData.matches[matchId] = match;
    db.set(pendingData);
    await postOrUpdateBracket(client, match);
    return interaction.editReply({ content: `Winner recorded for Match ${matchIndex + 1}. Select remaining winners above.` });
  }
  } catch (e) {
    console.error('Button interaction failed:', e);
    const message = { content: 'Could not complete that button action. Please try again.', flags: 64 };
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message.content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp(message).catch(() => {});
    else await interaction.reply(message).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
