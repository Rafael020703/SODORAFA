const fetch = require('node-fetch').default;
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URL, DISCORD_BOT_TOKEN } = require('./config');

/**
 * ============================================
 * DISCORD API MANAGER
 * Gerencia OAuth, webhooks e notificações
 * ============================================
 */

// Cache de dados de usuários Discord
const userCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

function getCachedUser(discordId) {
  const cached = userCache.get(discordId);
  if (cached && Date.now() < cached.expires) return cached.data;
  userCache.delete(discordId);
  return null;
}

function setCachedUser(discordId, data) {
  userCache.set(discordId, { data, expires: Date.now() + CACHE_TTL });
}

/**
 * Faz token exchange com Discord
 * @param {string} code - Código de autorização do Discord
 * @returns {Promise<Object>} Access token + user data
 */
async function exchangeCodeForToken(code) {
  if (!code) throw new Error('Code é obrigatório');

  const url = 'https://discord.com/api/oauth2/token';
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: DISCORD_REDIRECT_URL,
    scope: 'identify email'
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const json = await resp.json();
  if (!resp.ok || !json.access_token) {
    throw new Error(json.error_description || 'Erro ao fazer token exchange');
  }

  return json;
}

/**
 * Busca dados do usuário Discord
 * @param {string} accessToken - Token de acesso do Discord
 * @returns {Promise<Object>} Dados do usuário {id, username, discriminator, email, avatar}
 */
async function getUserData(accessToken) {
  if (!accessToken) throw new Error('Access token é obrigatório');

  const resp = await fetch('https://discord.com/api/users/@me', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  const json = await resp.json();
  if (!resp.ok || !json.id) {
    throw new Error('Erro ao buscar dados do usuário Discord');
  }

  // Montar URL do avatar
  const avatarUrl = json.avatar 
    ? `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${(parseInt(json.discriminator, 10) % 5)}.png`;

  const userData = {
    id: json.id,
    username: json.username,
    discriminator: json.discriminator,
    tag: `${json.username}#${json.discriminator}`,
    email: json.email,
    avatar: avatarUrl,
    verified: json.verified
  };

  setCachedUser(json.id, userData);
  return userData;
}

/**
 * Valida URL de webhook Discord
 * @param {string} webhookUrl - URL do webhook
 * @returns {Promise<Boolean>} True se webhook é válido
 */
async function validateWebhook(webhookUrl) {
  if (!webhookUrl || typeof webhookUrl !== 'string') return false;
  if (!webhookUrl.includes('discord.com/api/webhooks/')) return false;

  try {
    const resp = await fetch(webhookUrl);
    return resp.status === 200 || resp.status === 204;
  } catch (err) {
    console.error('Webhook validation error:', err.message);
    return false;
  }
}

/**
 * Envia mensagem para webhook Discord
 * @param {string} webhookUrl - URL do webhook
 * @param {Object} payload - Payload da mensagem (embed format)
 * @returns {Promise<Boolean>} True se enviado com sucesso
 */
async function sendWebhookMessage(webhookUrl, payload) {
  if (!webhookUrl) throw new Error('Webhook URL é obrigatória');
  if (!payload) throw new Error('Payload é obrigatório');

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return resp.ok || resp.status === 204;
  } catch (err) {
    console.error('Webhook send error:', err.message);
    return false;
  }
}

/**
 * Cria embed para notificação de stream live
 * @param {Object} streamer - Dados do streamer
 * @param {String} streamerLogoUrl - URL da logo do streamer
 * @returns {Object} Embed formatado
 */
function createStreamLiveEmbed(streamer, streamerLogoUrl) {
  return {
    embeds: [{
      title: `🔴 ${streamer.displayName} está LIVE!`,
      description: 'Clique no link abaixo para assistir',
      url: `https://twitch.tv/${streamer.streamerName}`,
      color: 16711680, // Vermelho
      thumbnail: {
        url: streamerLogoUrl || streamer.profileImageUrl
      },
      fields: [
        {
          name: 'Streamer',
          value: `[${streamer.displayName}](https://twitch.tv/${streamer.streamerName})`,
          inline: true
        },
        {
          name: 'Status',
          value: '🔴 AO VIVO',
          inline: true
        }
      ],
      footer: {
        text: 'SODORAFA - Notificações de Streamer',
        icon_url: 'https://cdn.betterttv.net/emoticon/55ef226be6f12d4cd33cad6a/3x'
      },
      timestamp: new Date().toISOString()
    }],
    content: streamer.notifyEveryone ? '@everyone' : null
  };
}

/**
 * Cria embed para teste de webhook
 * @returns {Object} Embed formatado
 */
function createTestEmbed() {
  return {
    embeds: [{
      title: '✅ Webhook Funcionando!',
      description: 'Você receberá notificações de streams ao vivo neste canal',
      color: 32768, // Verde
      footer: {
        text: 'SODORAFA - System',
        icon_url: 'https://cdn.betterttv.net/emoticon/55ef226be6f12d4cd33cad6a/3x'
      },
      timestamp: new Date().toISOString()
    }]
  };
}

/**
 * Obtém informações do webhook (ID e token)
 * @param {string} webhookUrl - URL do webhook completo
 * @returns {Object} {id, token} ou null
 */
function parseWebhookUrl(webhookUrl) {
  if (!webhookUrl) return null;
  
  try {
    // Format: https://discord.com/api/webhooks/{id}/{token}
    const match = webhookUrl.match(/webhooks\/(\d+)\/([a-zA-Z0-9_-]+)/);
    return match ? { id: match[1], token: match[2] } : null;
  } catch (err) {
    return null;
  }
}

/**
 * Lista os servidores Discord onde o usuário é admin
 * @param {string} accessToken - Access token do usuário
 * @returns {Promise<Array>} Lista de servidores
 */
async function getUserGuilds(accessToken) {
  const resp = await fetch('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!resp.ok) throw new Error('Erro ao buscar servidores');

  const guilds = await resp.json();
  
  // Filtrar apenas servidores onde usuário é admin
  return guilds.filter(g => {
    // Verificar se possui permissão ADMINISTRATOR (1 << 3 = 8)
    const adminPermission = 8;
    return (g.permissions & adminPermission) === adminPermission;
  }).map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null
  }));
}

/**
 * Lista os canais de um servidor Discord
 * @param {string} guildId - ID do servidor
 * @param {string} botToken - Token do bot Discord
 * @returns {Promise<Array>} Lista de canais de texto
 */
async function getGuildChannels(guildId, botToken) {
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` }
  });

  if (!resp.ok) throw new Error('Erro ao buscar canais');

  const channels = await resp.json();
  
  // Filtrar apenas canais de texto (type 0)
  return channels.filter(c => c.type === 0).map(c => ({
    id: c.id,
    name: c.name,
    position: c.position
  })).sort((a, b) => a.position - b.position);
}

module.exports = {
  exchangeCodeForToken,
  getUserData,
  validateWebhook,
  sendWebhookMessage,
  createStreamLiveEmbed,
  createTestEmbed,
  parseWebhookUrl,
  getCachedUser,
  setCachedUser,
  getUserGuilds,
  getGuildChannels
};
