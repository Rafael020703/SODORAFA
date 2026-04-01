const fetch = require('node-fetch').default;
const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = require('./config');

let TWITCH_TOKEN = null;
let tokenExpiresAt = 0;
let tokenRefreshInterval = null;
const userDataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedData(key) {
  const cached = userDataCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.data;
  userDataCache.delete(key);
  return null;
}

function setCachedData(key, data, ttl = CACHE_TTL) {
  userDataCache.set(key, { data, expires: Date.now() + ttl });
}

async function updateAccessToken(force = false) {
  try {
    const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
    
    const resp = await fetch(url, { method: 'POST' });
    const json = await resp.json();
    
    if (!resp.ok || !json.access_token) {
      console.error(`❌ [TOKEN] Erro ao atualizar token: ${json.message || resp.statusText}`);
      TWITCH_TOKEN = null;
      tokenExpiresAt = 0;
      return false;
    }
    
    TWITCH_TOKEN = `Bearer ${json.access_token}`;
    tokenExpiresAt = Date.now() + (json.expires_in || 0) * 1000;
    
    const expiresIn = json.expires_in || 0;
    const expiresDate = new Date(tokenExpiresAt).toLocaleString();
    
    if (force) {
      console.log(`🔄 [TOKEN] Token renovado com sucesso!`);
    } else {
      console.log(`✅ [TOKEN] Token atualizado automaticamente`);
    }
    console.log(`   📅 Expira em: ${expiresDate} (${expiresIn}s)`);
    
    return true;
  } catch (err) {
    console.error(`❌ [TOKEN] Erro ao atualizar token:`, err.message);
    TWITCH_TOKEN = null;
    tokenExpiresAt = 0;
    return false;
  }
}

async function ensureToken() {
  // Se token expirou ou tá próximo de expirar (5 minutos antes), atualiza
  if (!TWITCH_TOKEN || Date.now() >= tokenExpiresAt - 5 * 60 * 1000) {
    console.log(`⏳ [TOKEN] Token expirou ou vai expirar, atualizando...`);
    await updateAccessToken();
  }
}

/**
 * Inicia refresh automático do token a cada hora
 * Garante que o token nunca expire durante operações
 */
function startTokenAutoRefresh() {
  if (tokenRefreshInterval) {
    console.log(`ℹ️  [TOKEN] Auto-refresh já está ativo`);
    return;
  }

  console.log(`🔄 [TOKEN] Iniciando auto-refresh do token...`);

  // Faz primeiro refresh imediatamente
  updateAccessToken(true);

  // Depois a cada 50 minutos (token expira em 1 hora)
  tokenRefreshInterval = setInterval(async () => {
    console.log(`\n⏰ [TOKEN] Refresh automático em andamento...`);
    await updateAccessToken();
  }, 50 * 60 * 1000);

  // Permite que o NodeJS não fique preso nesse intervalo
  tokenRefreshInterval.unref?.();
}

async function getUserDataByLogin(username) {
  if (!username) return null;
  const key = `login_${username.toLowerCase()}`;
  const cached = getCachedData(key);
  if (cached) return cached;

  await ensureToken();
  const resp = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`,
    { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  if (!resp.ok || !json?.data?.length) return null;
  const usr = json.data[0];
  setCachedData(key, usr);
  if (usr.id) setCachedData(`id_${usr.id}`, usr);
  return usr;
}

async function getUserDataById(id) {
  if (!id) return null;
  const key = `id_${id}`;
  const cached = getCachedData(key);
  if (cached) return cached;

  await ensureToken();
  const resp = await fetch(
    `https://api.twitch.tv/helix/users?id=${encodeURIComponent(id)}`,
    { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  if (!resp.ok || !json?.data?.length) return null;
  const usr = json.data[0];
  setCachedData(key, usr);
  if (usr.login) setCachedData(`login_${usr.login.toLowerCase()}`, usr);
  return usr;
}

async function getUserData(usernameOrId) {
  if (!usernameOrId) return null;
  if (/^[0-9]+$/.test(usernameOrId)) return getUserDataById(usernameOrId);
  return getUserDataByLogin(usernameOrId);
}

async function getAllUserClips(userId) {
  if (!userId) return [];
  const key = `clips_${userId}`;
  const cached = getCachedData(key);
  if (cached) return cached;
  await ensureToken();

  let all = [];
  let cursor = null;
  do {
    const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(userId)}&first=100${cursor ? `&after=${cursor}` : ''}`;
    const resp = await fetch(url, { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } });
    const json = await resp.json();
    if (!resp.ok || !json?.data) {
      console.warn(`⚠️ getAllUserClips: Erro na resposta para userId ${userId}: ${resp.status}`);
      break;
    }
    console.log(`📊 getAllUserClips: ${json.data.length} clips encontrados para userId ${userId}`);
    json.data.forEach((clip, idx) => {
      console.log(`  [${idx}] ID: ${clip.id}`);
      console.log(`       URL: ${clip.url}`);
      console.log(`       Title: ${clip.title}`);
      console.log(`       Duration: ${clip.duration}s`);
      console.log(`       Slug: ${clip.url?.split('/').pop()}`);
    });
    all = all.concat(json.data);
    cursor = json.pagination?.cursor || null;
  } while (cursor);

  console.log(`✅ getAllUserClips: Total de ${all.length} clips para userId ${userId}`);
  setCachedData(key, all, 10 * 60 * 1000);
  return all;
}

async function getClipInfo(id) {
  if (!id) return null;
  await ensureToken();
  const resp = await fetch(
    `https://api.twitch.tv/helix/clips?id=${encodeURIComponent(id)}`,
    { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  if (!resp.ok || !json?.data?.length) return null;
  return json.data[0];
}

async function getClipVideoUrl(clipSlug) {
  // Obtém URL de vídeo do clip via API GraphQL da Twitch
  if (!clipSlug) return null;
  
  try {
    await ensureToken();
    
    console.log(`\n🔍 [CLIP-URL] Buscando URL do clip: ${clipSlug}`);
    
    // Query GraphQL completa para obter todos os dados do clip incluindo video
    // Tenta obter: videoQualities (com sourceURL), clipDownloadUrl, e playback
    const query = `
      query {
        clip(slug: "${clipSlug}") {
          id
          slug
          title
          videoQualities {
            frameRate
            quality
            sourceURL
          }
          playbackAccessToken {
            signature
            value
          }
        }
      }
    `;
    
    const resp = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
        'Authorization': TWITCH_TOKEN || ''
      },
      body: JSON.stringify({ query })
    });
    
    const json = await resp.json();
    
    console.log(`   Status: ${resp.status}`);
    
    if (json?.errors) {
      console.warn(`⚠️ [CLIP-URL] GraphQL error:`, json.errors[0]?.message || 'Unknown');
      return null;
    }
    
    const clipData = json?.data?.clip;
    if (!clipData) {
      console.warn(`⚠️ [CLIP-URL] Clip não encontrado na API`);
      return null;
    }
    
    console.log(`   ✅ Clip encontrado: ${clipData.title}`);
    
    // Prioriza videoQualities (mais provável ter a URL correta)
    if (clipData.videoQualities && Array.isArray(clipData.videoQualities) && clipData.videoQualities.length > 0) {
      // Ordena por qualidade (preferir 720p ou máxima)
      const qualities = clipData.videoQualities.filter(q => q.sourceURL);
      const sorted = qualities.sort((a, b) => {
        const qA = parseInt(a.quality || '0') || 0;
        const qB = parseInt(b.quality || '0') || 0;
        return qB - qA;
      });
      
      if (sorted.length > 0) {
        const url = sorted[0].sourceURL;
        const quality = sorted[0].quality;
        console.log(`   📹 URL encontrada (${quality}p): ${url.substring(0, 80)}...`);
        return url;
      }
    }
    
    console.warn(`⚠️ [CLIP-URL] Nenhuma qualidade de vídeo encontrada`);
    return null;
  } catch (err) {
    console.warn(`⚠️ [CLIP-URL] Erro ao obter URL:`, err.message);
    return null;
  }
}

async function getAllUserClipsWithVideo(userId) {
  if (!userId) return [];
  const key = `clipsWithVideo_${userId}`;
  const cached = getCachedData(key);
  if (cached) return cached;

  // Primeiro obtém todos os clipes via Helix
  const clips = await getAllUserClips(userId);
  
  // ⚠️ DESCONTINUADO: Extrair URL é feito via download-with-token.js com acesso a DevTools
  // Retorna clips como-estão (sem video_url pois não conseguimos extrair automaticamente)
  setCachedData(key, clips, 10 * 60 * 1000);
  return clips;
}


async function createClip(broadcasterId, token) {
  if (!broadcasterId || !token) return null;
  const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  return Array.isArray(json?.data) && json.data.length ? json.data[0].id : null;
}

async function getStream(username) {
  if (!username) return null;
  const key = `stream_${username.toLowerCase()}`;
  const cached = userDataCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.data;

  await ensureToken();
  const resp = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(username)}`,
    { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  if (!resp.ok || !json?.data) return null;
  
  const stream = json.data.length > 0 ? json.data[0] : null;
  if (stream) setCachedData(key, stream, 1 * 60 * 1000); // Cache por 1 minuto
  return stream;
}

/**
 * Tenta obter URL de clip via token de autorização
 * Busca em endpoints que geram token automático
 */
async function extractClipUrlViaToken(clipSlug) {
  if (!clipSlug) return null;
  
  console.log(`\n🔐 [TOKEN-EXTRACTION] Tentando extrair token para: ${clipSlug}`);
  
  try {
    // Estratégia 1: Endpoint Usher (Twitch streaming)
    console.log(`   📡 Endpoint 1: usher.ttvnw.net`);
    try {
      const resp = await fetch(`https://usher.ttvnw.net/api/v2/clip/${clipSlug}`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': TWITCH_TOKEN,
          'User-Agent': 'Mozilla/5.0'
        }
      });
      
      if (resp.ok) {
        const data = await resp.json();
        if (data.clip_uri) {
          console.log(`      ✅ Token obtido via usher endpoint`);
          return data.clip_uri;
        }
      }
    } catch (e) {}
    
    // Estratégia 2: GraphQL para obter clip_uri
    console.log(`   📡 Endpoint 2: GraphQL clip query`);
    try {
      const gqlQuery = `
        query {
          clip(slug: "${clipSlug}") {
            videoQualities {
              sourceURL
            }
            broadcaster {
              login
              displayName
            }
          }
        }
      `.trim();
      
      const resp = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': TWITCH_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: gqlQuery })
      });

      if (resp.ok) {
        const json = await resp.json();
        const url = json.data?.clip?.videoQualities?.[0]?.sourceURL;
        if (url) {
          console.log(`      ✅ URL obtida via GraphQL`);
          return url;
        }
      }
    } catch (e) {}
    
    console.log(`   ⚠️  Nenhum endpoint de token funcionou`);
    return null;
  } catch (err) {
    console.error(`   ❌ Erro na extração de token:`, err.message);
    return null;
  }
}

module.exports = {
  getUserDataByLogin,
  getUserDataById,
  getUserData,
  getAllUserClips,
  getAllUserClipsWithVideo,
  getClipVideoUrl,
  getClipInfo,
  createClip,
  getStream,
  updateAccessToken,
  startTokenAutoRefresh,
  extractClipUrlViaToken
};