// server.js
const express = require('express');
const http = require('http');
const session = require('express-session');
const { sessionMiddleware } = require('./sessionStore');
const passport = require('passport');
const { Strategy: TwitchStrategy } = require('passport-twitch-new');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;

// ————— Config Twitch (hard‑coded) —————
require('dotenv').config();
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const SESSION_SECRET       = process.env.SESSION_SECRET;
const CALLBACK_URL         = process.env.CALLBACK_URL;
let PORT = parseInt(process.env.PORT, 10);
if (!PORT || PORT < 1024) PORT = 80;


// ————— Credenciais do bot —————
let BOT_USERNAME, BOT_OAUTH;
try {
  const creds     = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));
  BOT_USERNAME    = creds.username;
  BOT_OAUTH       = creds.oauth;
} catch {
  console.error('Erro lendo credentials.json; finalize o setup.');
  process.exit(1);
}

// ————— App e Socket.IO —————
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ————— Middleware de segurança e otimização —————
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Cache estático (1 dia)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

// Rate limiting simples (100 req/min por IP)
const rateLimit = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000; // 1 minuto
  const max = 100;
  
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, []);
  }
  
  const requests = rateLimit.get(ip).filter(time => now - time < windowMs);
  
  if (requests.length >= max) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  requests.push(now);
  rateLimit.set(ip, requests);
  
  // Limpar cache a cada 5 minutos
  if (Math.random() < 0.01) {
    for (const [key, times] of rateLimit.entries()) {
      if (times.every(t => now - t > windowMs)) {
        rateLimit.delete(key);
      }
    }
  }
  
  next();
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ————— OAuth Twitch —————
passport.serializeUser((user, done) =>
  done(null, { id: user.id, display_name: user.display_name, accessToken: user.accessToken })
);
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new TwitchStrategy({
  clientID:     TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  callbackURL:  CALLBACK_URL,
  scope:        'user:read:email clips:edit'
}, (accessToken, refreshToken, profile, done) => {
  console.log('🎉 Twitch OAuth callback executado');
  console.log('👤 Perfil:', profile?.display_name || profile?.username);
  profile.accessToken = accessToken;
  return done(null, profile);
}));
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();

  // Detecta requisições que não querem HTML (fetch/XHR/API)
  const accept = req.headers.accept || '';
  const isAjaxLike = req.xhr
    || (req.headers['x-requested-with'] === 'XMLHttpRequest')
    || (accept && accept.indexOf('text/html') === -1); // se não aceita HTML, trata como API

  if (isAjaxLike) {
    // responde 401 para chamadas AJAX/fetch — evita redirect para Twitch e CORS
    return res.status(401).json({ error: 'not_authenticated' });
  }

  // caso contrário, redireciona o browser para iniciar o OAuth
  return res.redirect('/auth/twitch');
}

// ————— Configs e Canais (unificado) —————
const CHANNELS_CONFIGS_FILE = path.join(__dirname, 'channelsConfigs.json');
let channelConfigs = {};
let channelsToMonitor = [];
try {
  channelConfigs = JSON.parse(fs.readFileSync(CHANNELS_CONFIGS_FILE));
  channelsToMonitor = Object.keys(channelConfigs);
} catch {
  channelConfigs = {};
  channelsToMonitor = [];
}

const defaultConfig = {
  allowedCommands: {
    watch:  { enabled: false, roles: ['broadcaster'] },
    replay: { enabled: false, roles: ['broadcaster'] },
    repeat: { enabled: false, roles: ['broadcaster'] },
    so:     { enabled: false, roles: ['broadcaster'] },
    stop:   { enabled: false, roles: ['broadcaster'] },
    clip:   { enabled: false, roles: ['moderator'] }
  }
};

// helper: retorna uma cópia profunda das allowedCommands padrão
function cloneDefaultAllowedCommands() {
  // usa JSON para deep clone simples (suficiente aqui)
  return JSON.parse(JSON.stringify(defaultConfig.allowedCommands));
}

// ————— Rotas —————
// Root: se não autenticado → inicia OAuth; se autenticado → dashboard
app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/auth/twitch');
  return res.redirect('/dashboard');
});

// Página de login simples (usada como failureRedirect)
app.get('/login', (req, res) => {
  // página mínima com link para iniciar OAuth; pode ser trocada por um arquivo estático se preferir
  res.send(`
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Login - TwitchClips</title></head>
      <body style="font-family: Arial, sans-serif; text-align:center; padding:40px;">
        <h2>Conecte com Twitch</h2>
        <p><a href="/auth/twitch" style="padding:12px 18px; background:#9146FF; color:#fff; border-radius:6px; text-decoration:none;">Login com Twitch</a></p>
      </body>
    </html>
  `);
});

// Dashboard (protegido) — serve a UI principal
app.get('/dashboard', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// OAuth routes
app.get('/auth/twitch', (req, res, next) => {
  console.log('🔑 Iniciando autenticação Twitch');
  console.log('📍 CALLBACK_URL configurado:', CALLBACK_URL);
  passport.authenticate('twitch')(req, res, next);
});
app.get('/auth/twitch/callback',
  (req, res, next) => {
    console.log('🔙 Callback recebido da Twitch');
    console.log('📍 URL completa:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('📋 Query params:', req.query);
    next();
  },
  passport.authenticate('twitch', { failureRedirect: '/login' }),
  (req, res) => {
    console.log('✅ Autenticação bem-sucedida!');
    console.log('👤 Usuário:', req.user?.display_name);
    res.redirect('/dashboard');
  }
);

// logout mantém a mesma lógica existente
app.get('/logout', (req, res, next) =>
  req.logout(err => err ? next(err) : req.session.destroy(() => res.redirect('/')))
);
// Retorna configurações atuais do canal/logado
app.get('/get-config', ensureAuth, (req, res) => {
  const chan = req.user.display_name.toLowerCase();
  // Garante que exista uma configuração padrão se ainda não tiver
  if (!channelConfigs[chan]) {
    channelConfigs[chan] = { allowedCommands: defaultConfig.allowedCommands };
  }
  res.json({
    username: req.user.display_name,
    allowedCommands: channelConfigs[chan].allowedCommands
  });
});

// Adiciona canal à lista de monitoramento
app.post('/add-channel', ensureAuth, (req, res) => {
  try {
    const chan = (req.body.channel || '').toLowerCase().trim();
    
    // Validação
    if (!chan || chan.length < 3 || chan.length > 25) {
      return res.status(400).json({ success: false, error: 'invalid_channel_name' });
    }
    
    // Sanitização (apenas letras, números e underscore)
    if (!/^[a-z0-9_]+$/.test(chan)) {
      return res.status(400).json({ success: false, error: 'invalid_characters' });
    }
    
    if (!channelsToMonitor.includes(chan)) {
      channelsToMonitor.push(chan);
      // Cria config padrão se não existir
      if (!channelConfigs[chan]) {
        channelConfigs[chan] = { allowedCommands: cloneDefaultAllowedCommands() };
      }
      fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
      client.join(chan).catch(err => console.error('Erro ao entrar no canal:', err));
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao adicionar canal:', err);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// Salva configurações vindas do front
app.post('/save-config', ensureAuth, (req, res) => {
  try {
    const chan = req.user.display_name.toLowerCase();
    const { allowedCommands } = req.body;
    
    // Validação básica
    if (!allowedCommands || typeof allowedCommands !== 'object') {
      return res.status(400).json({ success: false, error: 'invalid_config' });
    }
    
    // Validar estrutura de cada comando
    const validRoles = ['broadcaster', 'moderator', 'vip', 'subscriber', 'viewer'];
    const validCommands = ['watch', 'replay', 'repeat', 'so', 'stop', 'clip'];
    
    for (const [cmd, config] of Object.entries(allowedCommands)) {
      if (!validCommands.includes(cmd)) continue;
      
      if (typeof config.enabled !== 'boolean' || !Array.isArray(config.roles)) {
        return res.status(400).json({ success: false, error: 'invalid_command_config' });
      }
      
      if (!config.roles.every(role => validRoles.includes(role))) {
        return res.status(400).json({ success: false, error: 'invalid_role' });
      }
    }
    
    channelConfigs[chan] = { allowedCommands };
    fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao salvar config:', err);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});
// Rota pública para verificar se existe configuração para um overlay de canal
app.get('/overlay/check/:channel', (req, res) => {
  const chan = (req.params.channel || '').toLowerCase();
  if (!chan) return res.status(400).json({ ok: false, message: 'missing_channel' });

  // channelConfigs foi lido no startup; garantimos que a chave exista
  if (channelConfigs[chan]) {
    return res.json({ ok: true });
  }
  return res.status(404).json({ ok: false, message: 'channel_not_found' });
});
app.get('/overlay/:channel', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/overlay.html'))
);

// Página pública que reproduz clipes infinitamente para qualquer canal (não requer cadastro)
app.get('/autoclipes/:channel', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/autoclipes.html'))
);

// Endpoint público: retorna clipes de um canal via Twitch API (usa token do servidor)
app.get('/api/public/clips/:channel', async (req, res) => {
  const chan = (req.params.channel || '').toLowerCase();
  if (!chan) return res.status(400).json({ ok: false, message: 'missing_channel' });
  try {
    const ud = await getUserData(chan);
    if (!ud) return res.status(404).json({ ok: false, message: 'user_not_found' });
    const clips = await getAllUserClips(ud.id);
    const out = (clips || []).map(c => ({ id: c.id, duration: c.duration, url: c.url, thumbnail: c.thumbnail_url }));
    return res.json(out);
  } catch (err) {
    console.error('Erro em /api/public/clips/:channel', err);
    return res.status(500).json({ ok: false, message: 'internal_error' });
  }
});

// ————— Endpoints de monitoramento —————
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    channels: channelsToMonitor.length,
    cache: {
      users: userDataCache.size,
      rateLimit: rateLimit.size
    },
    twitch: {
      connected: client?.readyState?.() === 'OPEN',
      tokenValid: TWITCH_TOKEN && Date.now() < tokenExpiresAt
    }
  };
  res.json(health);
});

app.get('/metrics', ensureAuth, (req, res) => {
  const metrics = {
    queues: Object.fromEntries(
      Object.entries(clipQueues).map(([chan, queue]) => [chan, queue.length])
    ),
    playing: Object.fromEntries(
      Object.entries(isPlaying).filter(([_, playing]) => playing)
    ),
    repeatMode: Object.fromEntries(
      Object.entries(repeatCfg).filter(([_, user]) => user)
    )
  };
  res.json(metrics);
});

// ————— Twitch API Helpers —————
let TWITCH_TOKEN   = null;
let tokenExpiresAt = 0;

// Cache para dados de usuários (5 minutos)
const userDataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedData(key) {
  const cached = userDataCache.get(key);
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }
  userDataCache.delete(key);
  return null;
}

function setCachedData(key, data, ttl = CACHE_TTL) {
  userDataCache.set(key, {
    data,
    expires: Date.now() + ttl
  });
}

// Limpar cache periodicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userDataCache.entries()) {
    if (now >= value.expires) {
      userDataCache.delete(key);
    }
  }
}, 60000); // Limpar a cada minuto

async function updateAccessToken() {
  const url = `https://id.twitch.tv/oauth2/token` +
              `?client_id=${TWITCH_CLIENT_ID}` +
              `&client_secret=${TWITCH_CLIENT_SECRET}` +
              `&grant_type=client_credentials`;
  try {
    const resp = await fetch(url, { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.access_token) {
      console.error('updateAccessToken: erro ao obter token', resp.status, data);
      TWITCH_TOKEN = null;
      tokenExpiresAt = 0;
      return;
    }
    TWITCH_TOKEN   = `Bearer ${data.access_token}`;
    tokenExpiresAt = Date.now() + (data.expires_in || 0) * 1000;
  } catch (err) {
    console.error('updateAccessToken: exceção', err);
    TWITCH_TOKEN = null;
    tokenExpiresAt = 0;
  }
}

async function getUserData(username) {
  if (!username) return null;
  
  // Verificar cache primeiro
  const cacheKey = `user_${username.toLowerCase()}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  
  if (!TWITCH_TOKEN || Date.now() >= tokenExpiresAt - 60000) {
    await updateAccessToken();
  }
  try {
    const resp = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`,
      { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
    );
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json || !Array.isArray(json.data)) {
      console.warn('getUserData: resposta inesperada', resp.status, json);
      return null;
    }
    const userData = json.data[0] || null;
    if (userData) {
      setCachedData(cacheKey, userData);
    }
    return userData;
  } catch (err) {
    console.error('getUserData: exceção', err);
    return null;
  }
}

async function getAllUserClips(userId) {
  if (!userId) return [];
  
  // Cache de clips por usuário (10 minutos)
  const cacheKey = `clips_${userId}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  
  let all = [], cursor = null;
  try {
    do {
      const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(userId)}&first=100${cursor?`&after=${cursor}`:''}`;
      const resp = await fetch(url, { headers: { 'Client-ID':TWITCH_CLIENT_ID, 'Authorization':TWITCH_TOKEN } });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json) {
        console.warn('getAllUserClips: resposta inesperada', resp.status, json);
        break;
      }
      if (Array.isArray(json.data)) all.push(...json.data);
      cursor = json.pagination?.cursor || null;
    } while (cursor);
    
    // Cache por 10 minutos
    if (all.length > 0) {
      setCachedData(cacheKey, all, 10 * 60 * 1000);
    }
  } catch (err) {
    console.error('getAllUserClips: exceção', err);
  }
  return all;
}

async function getClipInfo(id) {
  if (!id) return null;
  if (!TWITCH_TOKEN || Date.now() >= tokenExpiresAt - 60000) {
    await updateAccessToken();
  }
  try {
    const resp = await fetch(
      `https://api.twitch.tv/helix/clips?id=${encodeURIComponent(id)}`,
      { headers:{ 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
    );
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      console.warn('getClipInfo: Twitch API retornou erro', resp.status, json);
      return null;
    }
    if (!json || !Array.isArray(json.data) || json.data.length === 0) {
      // nenhum clipe encontrado — log para debugar caso necessário
      console.warn('getClipInfo: nenhum dado para clip', id, json);
      return null;
    }
    return json.data[0];
  } catch (err) {
    console.error('getClipInfo: exceção', err);
    return null;
  }
}

async function createClip(broadcasterId, token) {
  const url  = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`;
  const resp = await fetch(url, {
    method:'POST',
    headers:{
      'Client-ID':TWITCH_CLIENT_ID,
      'Authorization':`Bearer ${token}`,
      'Content-Type':'application/json'
    }
  });
  const json = await resp.json();
  return json.data[0] || null;
}

// ————— TMI.js Bot —————
const client = new tmi.Client({
  options: { 
    debug: false,
    messagesLogLevel: 'info'
  },
  connection: {
    reconnect: true,
    maxReconnectAttempts: 10,
    maxReconnectInterval: 30000,
    reconnectDecay: 1.5,
    reconnectInterval: 1000,
    secure: true,
    timeout: 9000
  },
  identity:{ username: BOT_USERNAME, password: BOT_OAUTH },
  channels: channelsToMonitor
});

client.on('connected', (addr, port) => {
  console.log(`✅ Bot conectado ao Twitch IRC (${addr}:${port})`);
});

client.on('disconnected', (reason) => {
  console.warn(`⚠️ Bot desconectado:`, reason);
});

client.on('reconnect', () => {
  console.log('🔄 Reconectando ao Twitch IRC...');
});

client.connect().catch(err => {
  console.error('❌ Erro ao conectar bot TMI:', err);
  process.exit(1);
});

// toca som ao ban
client.on('ban', (chanFull, user) => {
  const chan = chanFull.replace('#','');
  console.log(`Usuário ${user} banido em ${chan}.`);
  io.to(chan).emit('playBanSound');
});

// helpers de permissão
function isUserAllowed(tags, roles) {
  const hierarchy = { viewer:1, vip:2, moderator:3, broadcaster:4 };
  let rank = hierarchy.viewer;
  if (tags.badges?.broadcaster) rank = hierarchy.broadcaster;
  else if (tags.mod)                rank = hierarchy.moderator;
  else if (tags.badges?.vip)        rank = hierarchy.vip;
  if (roles.includes('subscriber') && tags.subscriber) return true;
  return roles.some(r => hierarchy[r] && rank >= hierarchy[r]);
}

// estruturas de fila/cache
const clipQueues    = {};
const isPlaying     = {};
const lastClip      = {};
const repeatCfg     = {}; // user para repeat
const playedSo      = {};
const playedUserClips = {};
const MAX_HISTORY   = 100;

// escuta chat
client.on('message', async (channelFull, tags, message, self) => {
  if (self) return;
  const chan = channelFull.replace('#','');

  // init
  clipQueues[chan]     ??= [];
  isPlaying[chan]      ??= false;
  playedSo[chan]       ??= [];
  playedUserClips[chan]??= [];
  lastClip[chan]       ??= null;
  repeatCfg[chan]      ??= null;

  const cfg = channelConfigs[chan] || { allowedCommands: defaultConfig.allowedCommands };
  cfg.allowedCommands  = { ...defaultConfig.allowedCommands, ...cfg.allowedCommands };

  // — !watch: limpa fila e reproduz um clipe específico
  if (/^!watch(\s|$)/i.test(message)) {
    if (!cfg.allowedCommands.watch.enabled || !isUserAllowed(tags, cfg.allowedCommands.watch.roles)) return;
let id = message.split(' ')[1] || '';
try {
  const u = new URL(id);
  // clips.twitch.tv/SLUG
  if (u.hostname.includes('clips.twitch.tv')) {
    id = u.pathname.slice(1);
  }
  // www.twitch.tv/USER/clip/SLUG
  else if (u.hostname.includes('twitch.tv') && u.pathname.includes('/clip/')) {
    id = u.pathname.split('/clip/')[1];
  }
} catch {}

    const info = await getClipInfo(id);
    if (!info) {
      console.warn(`⚠️ [${chan}] !watch: clip não encontrado: ${id}`);
      return;
    }
    const thumbnail = info.thumbnail_url || null;
    let videoUrl = null;
    if (thumbnail) {
      // tenta gerar alguns candidatos comuns de MP4 a partir da URL de preview
      const candidate = thumbnail.replace(/preview.*\.(jpg|png)$/,'preview.mp4').replace(/-preview.*\.(jpg|png)$/,'.mp4');
      if (candidate && candidate.endsWith('.mp4')) videoUrl = candidate;
    }
    console.log(`👁️ [${chan}] !watch -> ${info.url} (video: ${videoUrl || 'n/a'})`);
    clipQueues[chan] = [];
    repeatCfg[chan]  = null;
    lastClip[chan]   = { id, duration: info.duration, url: info.url, video: videoUrl, thumbnail };
    isPlaying[chan]  = true;
    io.to(chan).emit('novoClip', lastClip[chan]);
    return;
  }

  // — !replay: repete o último clipe
  if (/^!replay$/i.test(message)) {
    if (!cfg.allowedCommands.replay.enabled || !isUserAllowed(tags, cfg.allowedCommands.replay.roles)) return;
    if (!lastClip[chan]) return;
    console.log(`[${chan}] !replay -> ${lastClip[chan].url}`);
    clipQueues[chan] = [];
    repeatCfg[chan]  = null;
    isPlaying[chan]  = true;
    io.to(chan).emit('novoClip', lastClip[chan]);
    return;
  }

  // — !repeat: modo contínuo para um usuário
const rep = message.match(/^!repeat\s+@?(\w+)/i);
if (rep) {
  // respeita configuração e permissões do canal
  if (!cfg.allowedCommands.repeat.enabled || !isUserAllowed(tags, cfg.allowedCommands.repeat.roles)) return;
  const user = rep[1].toLowerCase();
  
  // Validação do username
  if (user.length < 3 || user.length > 25 || !/^[a-z0-9_]+$/.test(user)) {
    console.warn(`[${chan}] !repeat: username inválido: ${user}`);
    return;
  }
  
  repeatCfg[chan] = user;
  console.log(`🔁 [${chan}] Modo repeat ativado para ${user}`);
  // já enfileira o primeiro
  await queueUserClip(chan, user).catch(err => {
    console.error(`❌ [${chan}] Erro ao enfileirar clip de ${user}:`, err);
  });
  return;
}


  // — !stoprepeat: desativa modo repeat
  if (/^!stoprepeat$/i.test(message)) {
    if (!cfg.allowedCommands.repeat.enabled || !isUserAllowed(tags, cfg.allowedCommands.repeat.roles)) return;
    console.log(`[${chan}] modo repeat desativado`);
    repeatCfg[chan] = null;
    return;
  }

  // — !stop: cancela tudo
  if (/^!stop$/i.test(message)) {
    if (!cfg.allowedCommands.stop.enabled || !isUserAllowed(tags, cfg.allowedCommands.stop.roles)) return;
    console.log(`[${chan}] !stop`);
    clipQueues[chan]     = [];
    repeatCfg[chan]      = null;
    isPlaying[chan]      = false;
      // lastClip[chan] = null;    ← não limpar
    io.to(chan).emit('fecharOverlay');
    return;
  }

  // — !so: shoutout aleatório
  if (/^!so\s+@?(\w+)/i.test(message)) {
    if (!cfg.allowedCommands.so.enabled || !isUserAllowed(tags, cfg.allowedCommands.so.roles)) return;
    const targetUser = message.match(/^!so\s+@?(\w+)/i)[1].toLowerCase();
    
    // Validação
    if (targetUser.length < 3 || targetUser.length > 25 || !/^[a-z0-9_]+$/.test(targetUser)) {
      console.warn(`[${chan}] !so: username inválido: ${targetUser}`);
      return;
    }
    
    console.log(`👋 [${chan}] !so ${targetUser}`);
    queueUserClip(chan, targetUser).catch(err => {
      console.error(`❌ [${chan}] Erro ao enfileirar clip de ${targetUser}:`, err);
    });
    return;
  }

  // — !clip: cria clip e loga URL
  if (/^!clip/i.test(message)) {
    if (!cfg.allowedCommands.clip.enabled || !isUserAllowed(tags, cfg.allowedCommands.clip.roles)) return;
    try {
      const ud  = await getUserData(chan);
     const clipId = await createClip(ud.id, cfg.userAccessToken);
if (clipId) {
  const url = `https://clips.twitch.tv/${clipId}`;
  console.log(`[${chan}] !clip criado -> ${url}`);
  client.say(channelFull, `Clipe criado: ${url}`);
}

    } catch(e) { console.error(e); }
    return;
  }
});
 

// ————— montagem de fila —————
async function queueUserClip(chan, user) {
  const ud    = await getUserData(user);
  if (!ud) {
    console.warn(`⚠️ [${chan}] Usuário não encontrado: ${user}`);
    return;
  }
  
  const clips = await getAllUserClips(ud.id);
  if (!clips || clips.length === 0) {
    console.warn(`⚠️ [${chan}] ${user} não tem clips disponíveis`);
    return;
  }
  
  // filtra já tocados em so/repeat
  const pool  = clips.filter(c => !playedSo[chan].includes(c.id) && !playedUserClips[chan].includes(c.id));
  if (!pool.length) {
    console.log(`🔄 [${chan}] Resetando histórico de clips de ${user}`);
    playedSo[chan] = [];
    playedUserClips[chan] = [];
    return queueUserClip(chan, user);
  }
  const pick = pool[Math.floor(Math.random()*pool.length)];
  playedSo[chan].push(pick.id);
  if (repeatCfg[chan] === user) playedUserClips[chan].push(pick.id);
  
  // Limitar histórico
  if (playedSo[chan].length > MAX_HISTORY) {
    playedSo[chan] = playedSo[chan].slice(-MAX_HISTORY);
  }
  if (playedUserClips[chan].length > MAX_HISTORY) {
    playedUserClips[chan] = playedUserClips[chan].slice(-MAX_HISTORY);
  }
  
  const thumbnail = pick.thumbnail_url || null;
  let videoUrl = null;
  if (thumbnail) {
    const candidate = thumbnail.replace(/preview.*\.(jpg|png)$/,'preview.mp4').replace(/-preview.*\.(jpg|png)$/,'.mp4');
    if (candidate && candidate.endsWith('.mp4')) videoUrl = candidate;
  }
  clipQueues[chan].push({ id: pick.id, duration: pick.duration, url: pick.url, video: videoUrl, thumbnail });
  console.log(`➕ [${chan}] Clip de ${user} adicionado à fila (${clipQueues[chan].length} na fila)`);
  playNext(chan);
}

// ————— toca próximo —————
const playNextDebounce = new Map();

function playNext(chan) {
  // garante inicialização das estruturas por canal
  clipQueues[chan]       ??= [];
  isPlaying[chan]        ??= false;
  playedSo[chan]         ??= [];
  playedUserClips[chan]  ??= [];
  lastClip[chan]         ??= null;
  repeatCfg[chan]        ??= null;

  // se já está tocando ou não há fila, não faz nada
  if (isPlaying[chan] || !clipQueues[chan].length) return;

  // Debounce para evitar múltiplas execuções simultâneas
  if (playNextDebounce.has(chan)) {
    clearTimeout(playNextDebounce.get(chan));
  }
  
  const timeoutId = setTimeout(() => {
    playNextDebounce.delete(chan);
    
    if (isPlaying[chan] || !clipQueues[chan].length) return;
    
    const clip = clipQueues[chan].shift();
    lastClip[chan]  = clip;
    isPlaying[chan] = true;
    console.log(`▶️ [${chan}] Reproduzindo → ${clip.url} (video: ${clip.video ? 'sim' : 'não'})`);
    console.debug('▶️ clip object:', clip);
    io.to(chan).emit('novoClip', clip);
  }, 100);
  
  playNextDebounce.set(chan, timeoutId);
}

// ————— WebSocket —————
io.on('connection', socket => {
  let chan = socket.handshake.query.channel?.replace('#','');
  if (!chan) {
    console.warn('⚠️ Conexão WebSocket sem canal especificado');
    socket.disconnect(true);
    return;
  }

  console.log(`🔌 [${chan}] Nova conexão WebSocket`);
  socket.join(chan);

  // Inicializa estruturas do canal caso ainda não existam
  clipQueues[chan]       ??= [];
  isPlaying[chan]        ??= false;
  playedSo[chan]         ??= [];
  playedUserClips[chan]  ??= [];
  lastClip[chan]         ??= null;
  repeatCfg[chan]        ??= null;

  // Quando o overlay informar que um clipe finalizou
  socket.on('clipFinalizado', async () => {
    console.log(`✔️ [${chan}] Clip finalizado`);
    isPlaying[chan] = false;
    
    // Se estiver em modo repeat, enfileira próximo
    if (repeatCfg[chan]) {
      await queueUserClip(chan, repeatCfg[chan]).catch(err => {
        console.error(`❌ [${chan}] Erro no repeat:`, err);
      });
    }
    
    // Tenta tocar o próximo da fila
    if (clipQueues[chan] && clipQueues[chan].length > 0) {
      playNext(chan);
    }
  });

  socket.on('fecharOverlay', () => {
    console.log(`🚫 [${chan}] Overlay fechado`);
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 [${chan}] WebSocket desconectado`);
  });
});

// ————— Inicia —————
server.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log('🔑 TWITCH_CLIENT_ID:', TWITCH_CLIENT_ID);
  console.log('📍 CALLBACK_URL:', CALLBACK_URL);
  console.log('🎯 Canais monitorados:', channelsToMonitor.length);
  console.log('========================================\n');
});

// ————— Graceful Shutdown —————
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️ Recebido sinal ${signal}, encerrando gracefully...`);
  
  // Para de aceitar novas conexões
  server.close(() => {
    console.log('✅ Servidor HTTP fechado');
  });
  
  // Desconecta do Twitch IRC
  if (client) {
    try {
      await client.disconnect();
      console.log('✅ Bot IRC desconectado');
    } catch (err) {
      console.error('❌ Erro ao desconectar bot:', err);
    }
  }
  
  // Salva configurações
  try {
    fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
    console.log('✅ Configurações salvas');
  } catch (err) {
    console.error('❌ Erro ao salvar configurações:', err);
  }
  
  console.log('👋 Encerrando processo...\n');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
  console.error('❌ Exceção não capturada:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
});
