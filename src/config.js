require('dotenv').config();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_TOKEN = process.env.TWITCH_TOKEN || '';
const CALLBACK_URL = process.env.CALLBACK_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret-session';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'secret123';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME || null;
const BOT_OAUTH = process.env.BOT_OAUTH_TOKEN || process.env.BOT_OAUTH || null;

// Discord OAuth
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || 'http://localhost:3000/auth/discord/callback';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null; // opcional
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

module.exports = {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_TOKEN,
  CALLBACK_URL,
  SESSION_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
  ADMIN_JWT_SECRET,
  PORT,
  BOT_USERNAME,
  BOT_OAUTH,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URL,
  DISCORD_BOT_TOKEN,
  BASE_URL
};