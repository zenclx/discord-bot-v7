const { SlashCommandBuilder } = require('discord.js');
const addplayer = require('./addplayer');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('latejoin')
    .setDescription('Late-add a player before the bracket starts')
    .addUserOption(o => o.setName('player').setDescription('Player to add').setRequired(true))
    .addStringOption(o => o.setName('matchid').setDescription('Optional match ID').setRequired(false)),

  execute: addplayer.execute,
};
