const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { DARK_BLUE } = require('../utils');

const ACHIEVEMENTS = [
  { id: 'first_win',        name: 'First Blood',        emoji: '🩸', description: 'First ever win',         roleName: '🩸 First Blood'        },
  { id: 'wins_10',          name: 'Veteran',             emoji: '🎖️', description: '10 total wins',          roleName: '🎖️ Veteran'            },
  { id: 'wins_25',          name: 'Elite',               emoji: '💎', description: '25 total wins',          roleName: '💎 Elite'               },
  { id: 'wins_50',          name: 'Legend',              emoji: '🔱', description: '50 total wins',          roleName: '🔱 Legend'              },
  { id: 'streak_5',         name: 'On Fire',             emoji: '🔥', description: '5-win streak',           roleName: '🔥 On Fire'             },
  { id: 'tournament_champ', name: 'Tournament Champion', emoji: '🏆', description: 'Won a tournament',       roleName: '🏆 Tournament Champion' },
];

// Achievement earning disabled — re-enable by restoring checkAchievements logic
async function checkAchievements() { return []; }

module.exports = {
  data: new SlashCommandBuilder()
    .setName('achievements')
    .setDescription("View your or another user's earned achievement badges")
    .addUserOption(o => o.setName('user').setDescription('User to check (default: yourself)').setRequired(false)),

  async execute(interaction) {
    const data = db.get();
    const guildId = interaction.guildId;
    const target = interaction.options.getUser('user') || interaction.user;
    const earned = data.achievements?.[guildId]?.[target.id] || [];

    const lines = ACHIEVEMENTS.map(a =>
      `${earned.includes(a.id) ? a.emoji : '⬜'} **${a.name}** — ${a.description}`
    );

    const embed = new EmbedBuilder()
      .setTitle(`🏅 Achievements — ${target.username}`)
      .setColor(DARK_BLUE)
      .setDescription(lines.join('\n'))
      .addFields({ name: 'Earned', value: `${earned.length} / ${ACHIEVEMENTS.length}`, inline: true })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  checkAchievements,
  ACHIEVEMENTS,
};
