// server.js
const express = require('express');
const http = require('http');
const session = require('express-session');
const { sessionMiddleware } = require('./src/sessionStore');
const passport = require('passport');
const { Strategy: TwitchStrategy } = require('passport-twitch-new');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const jwt = require('jsonwebtoken');

const config = require('./src/config');
const state = require('./src/state');
const twitchApi = require('./src/twitchApi');
const discordApi = require('./src/discordApi');
const persistence = require('./src/persistence');
const VideoManager = require('./src/videoManager');
const VideoDownloader = require('./src/videoDownloader');
const clipTokenExtractor = require('./src/clipTokenExtractor');

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_TOKEN,
  CALLBACK_URL,
  SESSION_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
  ADMIN_JWT_SECRET,
  PORT,
  BOT_USERNAME: BOT_NAME,
  BOT_OAUTH: BOT_OAUTH_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URL,
  DISCORD_BOT_TOKEN,
  BASE_URL
} = config;

let BOT_USERNAME = BOT_NAME;
let BOT_OAUTH = BOT_OAUTH_TOKEN;

if (!BOT_USERNAME || !BOT_OAUTH) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));
    BOT_USERNAME = BOT_USERNAME || creds.username;
    BOT_OAUTH = BOT_OAUTH || creds.oauth;
  } catch {
    // fallback compatível
  }
}

if (!BOT_USERNAME || !BOT_OAUTH) {
  console.error('Erro: BOT_USERNAME e BOT_OAUTH_TOKEN devem estar definidos em .env ou credentials.json');
  process.exit(1);
}

// ————— App e Socket.IO —————
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ————— Video Manager + Downloader —————
const videoManager = new VideoManager(path.join(__dirname, 'data/videos'));
const videoDownloader = new VideoDownloader(TWITCH_CLIENT_ID, TWITCH_TOKEN);

// ————— Iniciar auto-refresh do token Twitch —————
twitchApi.startTokenAutoRefresh();

// Limpeza automática de vídeos antigos a cada 24h (DESABILITADO)
// setInterval(async () => {
//   try {
//     console.log('\n🧹 [CLEANUP] Executando limpeza de vídeos antigos...');
//     const removed = await videoManager.cleanupOldVideos(7 * 24 * 60 * 60 * 1000);
//     const totalSize = await videoManager.getTotalSize();
//     console.log(`📊 [CLEANUP] Espaço usado: ${videoManager.formatBytes(totalSize)}`);
//     if (removed > 0) {
//       console.log(`✅ [CLEANUP] ${removed} vídeos antigos removidos`);
//     }
//   } catch (err) {
//     console.error(`❌ [CLEANUP] Erro:`, err.message);
//   }
// }, 24 * 60 * 60 * 1000);

console.log(`✅ Video Manager inicializado`);
console.log(`📁 Diretório: ${path.join(__dirname, 'data/videos')}`);

// ————— Middleware de segurança e otimização —————
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Cache estático (1 dia)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  index: false
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
passport.serializeUser((user, done) => {
  console.log('[AUTH] Serializando usuário:', {
    id: user.id,
    login: user.login || user.username,
    display_name: user.display_name,
    profile_image_url: user.profile_image_url
  });
  done(null, {
    id: user.id,
    login: user.login || user.username,
    username: user.username,
    display_name: user.display_name,
    profile_image_url: user.profile_image_url,
    email: user.email,
    accessToken: user.accessToken
  });
});
passport.deserializeUser((obj, done) => {
  console.log('[AUTH] Desserializando usuário:', obj.id);
  done(null, obj);
});
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

  // Armazena a página original de onde veio o request
  req.session.returnTo = req.originalUrl;
  
  // caso contrário, redireciona o browser para iniciar o OAuth
  return res.redirect('/auth/twitch');
}

function ensureAdmin(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'not_admin' });
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload && payload.user === ADMIN_USER) {
      req.admin = payload;
      return next();
    }
    return res.status(401).json({ ok: false, error: 'not_admin' });
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'not_admin' });
  }
}

// ————— Configs e Canais (unificado) —————
state.loadConfigs();

// helper: keep a tiny mapping for runtime alias
function getCurrentMonitorChannels() {
  return state.getChannelsToMonitor();
}

// ————— Rotas —————
// Root: página inicial de projetos
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
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
  res.redirect('/sodorafa');
});

// Home page (pública) — Landing page da plataforma
app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Endpoint de estatísticas (pode ser públic para dashboard)
app.get('/api/stats', (req, res) => {
  // Se o usuário não está autenticado, retorna stats públicas
  const userProfiles = persistence.loadUserProfiles();
  const streamersMonitored = persistence.loadStreamersMonitored();
  
  const totalUsers = userProfiles.size;
  const totalStreamersMonitored = streamersMonitored.size;
  
  // Calcula stats adicionais
  let totalWebhooks = 0;
  let activeMonitoring = 0;
  
  for (const [userId, profile] of userProfiles) {
    if (profile.discordWebhook) totalWebhooks++;
  }
  
  for (const [userId, streamers] of streamersMonitored) {
    if (Array.isArray(streamers)) {
      activeMonitoring += streamers.filter(s => s && s.monitoringActive !== false).length;
    }
  }
  
  res.json({
    totalUsers,
    totalStreamersMonitored,
    totalWebhooks,
    activeMonitoring,
    uptimeSeconds: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// GET /api/users — Lista de todos os usuários (protegido)
app.get('/api/users', ensureAuth, (req, res) => {
  try {
    const userProfiles = persistence.loadUserProfiles();
    const users = Array.from(userProfiles.values()).map(profile => ({
      twitch_id: profile.id,
      display_name: profile.displayName || profile.username || 'Usuário',
      displayName: profile.displayName || profile.username || 'Usuário',
      profileImageUrl: profile.profileImageUrl,
      avatar: profile.profileImageUrl,
      email: profile.email || null,
      created_at: profile.createdAt || new Date(),
      last_login: profile.lastLogin || new Date(),
      discord_connected: !!profile.discordId
    }));

    res.json(users);
  } catch (err) {
    console.error('Error loading users:', err);
    res.status(500).json({ error: 'Erro ao carregar usuários' });
  }
});

// ====== ADMIN LOGIN HANDLER (sem middleware para permitir acesso)======
app.get('/admin', (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) {
    try {
      jwt.verify(token, ADMIN_JWT_SECRET);
      // Se token válido, serve o painel admin
      return res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
    } catch {
      // invalid token: fall through to login page
    }
  }
  // Served página de login
  return res.send(`
    <!doctype html><html><head><meta charset="utf-8"><title>Admin Login</title></head><body style="font-family:Arial,sans-serif;background:#071129;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;"><div style="background:#0f1b42;padding:20px;border-radius:10px;border:1px solid #2b4d98;"><h2 style="margin-top:0;">Painel Admin</h2><form method="post" action="/admin/login"><div style="margin-bottom:8px;"><label style="display:block;margin-bottom:4px;">Usuário</label><input name="user" style="width:100%;padding:6px;border:1px solid #2e4f94;border-radius:6px;" /></div><div style="margin-bottom:12px;"><label style="display:block;margin-bottom:4px;">Senha</label><input name="pass" type="password" style="width:100%;padding:6px;border:1px solid #2e4f94;border-radius:6px;" /></div><button style="width:100%;padding:8px;border:none;background:#2d9cff;color:#fff;border-radius:6px;">Entrar</button></form></div></body></html>
  `);
});

app.post('/admin/login', (req, res) => {
  const user = (req.body.user || '').trim();
  const pass = (req.body.pass || '').trim();
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = jwt.sign({ user: ADMIN_USER }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
    res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.headers['x-forwarded-proto'] === 'https' });
    return res.redirect('/admin');
  }
  return res.status(401).send('Usuário ou senha inválidos. <a href="/admin">Voltar</a>');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  return res.redirect('/admin');
});

// Retorna configurações públicas (para o frontend)
app.get('/api/config', (req, res) => {
  res.json({
    discordClientId: DISCORD_CLIENT_ID,
    discordRedirectUrl: DISCORD_REDIRECT_URL,
    baseUrl: BASE_URL
  });
});

// Meu Perfil (protegido) — integração Discord + monitoramento de streamers
app.get('/profile', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ====== LIVESTWITCH ROUTES ======
app.get('/livestwitch', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'livestwitch', 'index.html'));
});

app.get('/livestwitch/dashboard', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'livestwitch', 'dashboard.html'));
});

// Rota legacy para compatibilidade
app.get('/monitoring', ensureAuth, (req, res) => {
  res.redirect('/livestwitch');
});

// ====== SODORAFA ROUTES ======
app.get('/sodorafa', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sodorafa', 'index.html'));
});

app.get('/sodorafa/overlay', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sodorafa', 'overlay.html'));
});

app.get('/sodorafa/autoclipes', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sodorafa', 'autoclipes.html'));
});

// ====== ADMIN API ROUTES ======
app.get('/admin/api/channels', ensureAdmin, async (req, res) => {
  const channels = state.getAllChannels();
  const out = [];
  for (const channel of channels) {
    const resolved = await ensureChannelHasFreshName(channel);
    const cfg = state.getChannelConfig(resolved);
    const st = state.getChannelState(resolved);
    const ud = await twitchApi.getUserDataByLogin(resolved);
    out.push({
      channel: resolved,
      displayName: ud?.display_name || resolved,
      avatar: ud?.profile_image_url || null,
      totalClipsPlayed: st.totalClipsPlayed || 0,
      queueLength: st.clipQueue.length,
      isPlaying: st.isPlaying,
      repeatUser: st.repeatUser,
      lastClip: st.lastClip,
      allowedCommands: cfg.allowedCommands
    });
  }
  res.json(out);
});

app.post('/admin/api/reset-metrics', ensureAdmin, (req, res) => {
  const channel = (req.body.channel || '').toLowerCase().trim();
  if (channel) {
    const st = state.getChannelState(channel);
    if (st) {
      st.totalClipsPlayed = 0;
      return res.json({ ok: true, channel, totalClipsPlayed: 0 });
    }
    return res.status(404).json({ ok: false, error: 'channel_not_found' });
  }
  for (const key of state.getAllChannels()) {
    const st = state.getChannelState(key);
    if (st) st.totalClipsPlayed = 0;
  }
  return res.json({ ok: true, resetAll: true });
});

app.get('/admin/api/users', ensureAdmin, async (req, res) => {
  const channels = state.getAllChannels();
  const users = [];
  for (const channel of channels) {
    const resolved = await ensureChannelHasFreshName(channel);
    const cfg = state.getChannelConfig(resolved);
    const st = state.getChannelState(resolved);
    const ud = await twitchApi.getUserDataByLogin(resolved);
    users.push({
      channel: resolved,
      displayName: ud?.display_name || resolved,
      avatar: ud?.profile_image_url || null,
      totalClipsPlayed: st.totalClipsPlayed || 0,
      isPlaying: st.isPlaying,
      queueLength: st.clipQueue.length,
      allowedCommands: cfg.allowedCommands
    });
  }
  res.json(users);
});

app.post('/admin/api/users/add', ensureAdmin, (req, res) => {
  const channel = (req.body.channel || '').toLowerCase().trim();
  if (!channel || !/^[a-z0-9_]+$/.test(channel)) {
    return res.status(400).json({ ok: false, error: 'invalid_channel' });
  }
  const cfg = state.getChannelConfig(channel);
  if (!cfg) {
    state.saveChannelConfig(channel, { allowedCommands: state.cloneDefaultAllowedCommands() });
  }
  state.initChannelState(channel);
  state.addChannelToMonitor(channel);
  return res.json({ ok: true, channel });
});

app.post('/admin/api/users/delete', ensureAdmin, (req, res) => {
  const channel = (req.body.channel || '').toLowerCase().trim();
  if (!channel) {
    return res.status(400).json({ ok: false, error: 'invalid_channel' });
  }
  state.removeChannel(channel);
  return res.json({ ok: true, channel });
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
    
    // Recupera a página original, ou usa dashboard como padrão
    const returnTo = req.session?.returnTo || '/dashboard';
    delete req.session.returnTo; // Limpa para não reutilizar depois
    
    res.redirect(returnTo);
  }
);

// logout mantém a mesma lógica existente
app.get('/logout', (req, res, next) =>
  req.logout(err => err ? next(err) : req.session.destroy(() => res.redirect('/')))
);
// Retorna configurações atuais do canal/logado
app.get('/get-config', ensureAuth, async (req, res) => {
  const chan = req.user.display_name.toLowerCase();
  const ud = await twitchApi.getUserDataByLogin(chan);
  const actualLogin = ud?.login?.toLowerCase() || chan;
  const updatedChannel = await ensureChannelHasFreshName(actualLogin);
  state.initChannelState(updatedChannel);
  const cfg = state.getChannelConfig(updatedChannel);
  res.json({
    username: ud?.display_name || req.user.display_name,
    avatar: ud?.profile_image_url || null,
    allowedCommands: cfg.allowedCommands
  });
});

// Adiciona canal à lista de monitoramento
app.post('/add-channel', ensureAuth, async (req, res) => {
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
    
    state.addChannelToMonitor(chan);

    const ud = await twitchApi.getUserDataByLogin(chan);
    if (!ud) {
      return res.status(404).json({ success: false, error: 'channel_not_found' });
    }

    state.saveChannelConfig(ud.login.toLowerCase(), {
      allowedCommands: state.cloneDefaultAllowedCommands(),
      userId: ud.id,
      login: ud.login.toLowerCase()
    });
    state.initChannelState(ud.login.toLowerCase());
    console.log(`🔗 Entrando no chat: #${ud.login.toLowerCase()}`);
    client.join(ud.login.toLowerCase()).catch(err => console.error(`❌ Erro ao entrar no canal #${ud.login.toLowerCase()}:`, err));
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
    
    state.saveChannelConfig(chan, { allowedCommands });
    state.initChannelState(chan);
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

  // channelConfigs foi lido no startup; garantimos que a chave exista se houver config
  const cfg = state.getChannelConfig(chan);
  if (cfg) {
    return res.json({ ok: true });
  }
  return res.status(404).json({ ok: false, message: 'channel_not_found' });
});
app.get('/overlay/:channel', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'sodorafa', 'overlay.html'))
);

// Página pública que reproduz clipes infinitamente para qualquer canal (não requer cadastro)
app.get('/autoclipes/:channel', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'autoclipes.html'))
);

// Endpoint público: retorna clipes de um canal via Twitch API (usa token do servidor)
app.get('/api/public/clips/:channel', async (req, res) => {
  const chan = (req.params.channel || '').toLowerCase();
  if (!chan) return res.status(400).json({ ok: false, message: 'missing_channel' });
  try {
    const ud = await twitchApi.getUserData(chan);
    if (!ud) return res.status(404).json({ ok: false, message: 'user_not_found' });
    const clips = await twitchApi.getAllUserClips(ud.id);
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
    channels: state.getChannelsToMonitor().length,
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
  const chan = (req.user.display_name || '').toLowerCase();
  if (!chan) {
    return res.status(400).json({ ok: false, error: 'missing_user' });
  }

  const st = state.getChannelState(chan);
  if (!st) {
    return res.status(404).json({ ok: false, error: 'channel_not_found' });
  }

  return res.json({
    channel: chan,
    queueLength: st.clipQueue.length,
    isPlaying: st.isPlaying,
    totalClipsPlayed: st.totalClipsPlayed || 0,
    repeatUser: st.repeatUser || null,
    lastClip: st.lastClip ? {
      id: st.lastClip.id,
      url: st.lastClip.url,
      duration: st.lastClip.duration
    } : null
  });
});

app.get('/metrics/:channel', ensureAuth, (req, res) => {
  const chan = (req.params.channel || '').toLowerCase();
  if (!chan) return res.status(400).json({ ok: false, error: 'missing_channel' });

  const st = state.getChannelState(chan);
  if (!st) {
    return res.status(404).json({ ok: false, error: 'channel_not_found' });
  }

  return res.json({
    channel: chan,
    queueLength: st.clipQueue.length,
    isPlaying: st.isPlaying,
    totalClipsPlayed: st.totalClipsPlayed || 0,
    repeatUser: st.repeatUser || null,
    lastClip: st.lastClip ? {
      id: st.lastClip.id,
      url: st.lastClip.url,
      duration: st.lastClip.duration
    } : null
  });
});

// ————— Twitch API Helpers (delegated to src/twitchApi.js) —————

async function ensureChannelHasFreshName(chan) {
  const key = (chan || '').toLowerCase();
  const cfg = state.getChannelConfig(key);
  if (!cfg) return key;

  let userData = null;
  if (cfg.userId) {
    userData = await twitchApi.getUserDataById(cfg.userId);
  }
  if (!userData) {
    userData = await twitchApi.getUserDataByLogin(key);
  }
  if (!userData || !userData.login) return key;

  const currentLogin = userData.login.toLowerCase();
  if (currentLogin === key) {
    state.saveChannelConfig(key, {
      allowedCommands: cfg.allowedCommands,
      userId: userData.id,
      login: currentLogin
    });
    return key;
  }

  console.log(`🔁 Renomeando canal interno ${key} → ${currentLogin}`);
  const newConfig = {
    allowedCommands: cfg.allowedCommands,
    userId: userData.id,
    login: currentLogin
  };
  state.saveChannelConfig(currentLogin, newConfig);

  const oldState = state.getChannelState(key);
  if (oldState) {
    const newState = state.initChannelState(currentLogin);
    Object.assign(newState, oldState);
  }

  state.removeChannel(key);
  state.addChannelToMonitor(currentLogin);
  return currentLogin;
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
  channels: state.getChannelsToMonitor()
});

client.on('connected', (addr, port) => {
  console.log(`✅ Bot conectado ao Twitch IRC (${addr}:${port})`);
  const channels = state.getChannelsToMonitor();
  channels.forEach(chan => {
    console.log(`  📺 Monitorando chat: #${chan}`);
  });
});

client.on('join', (chan, user) => {
  if (user === BOT_USERNAME) {
    const channelName = chan.replace('#', '').toLowerCase();
    console.log(`✅ Bot entrou no chat: #${channelName}`);
  }
});

client.on('part', (chan, user) => {
  if (user === BOT_USERNAME) {
    const channelName = chan.replace('#', '').toLowerCase();
    console.log(`❌ Bot saiu do chat: #${channelName}`);
  }
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
  const chan = chanFull.replace('#','').toLowerCase();
  console.log(`Usuário ${user} banido em ${chan}.`);
  io.to(`overlay:${chan}`).emit('playBanSound');
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

const MAX_HISTORY = 100;

function getPlayerState(chan) {
  return state.initChannelState(chan);
}

function queueClip(chan, clip) {
  const state = getPlayerState(chan);
  if (!clip || !clip.id) return;
  state.clipQueue.push(clip);
  if (!state.isPlaying) {
    playNext(chan);
  }
}

function playNext(chan) {
  const state = getPlayerState(chan);
  if (state.isPlaying || state.clipQueue.length === 0) return;

  const next = state.clipQueue.shift();
  if (!next) return;

  state.lastClip = next;
  state.totalClipsPlayed = (state.totalClipsPlayed || 0) + 1;
  state.isPlaying = true;
  console.log(`▶️ [${chan}] Reproduzindo próximo clip: ${next.id}`);
  console.log(`   📊 Dados do clip enviados para o overlay:`);
  console.log(`   - id (slug): ${next.id}`);
  console.log(`   - duration: ${next.duration}`);
  console.log(`   - url: ${next.url}`);
  console.log(`   - thumbnail: ${next.thumbnail}`);
  io.to(`overlay:${chan}`).emit('novoClip', next);
}

function normalizeClipUrl(thumbnail) {
  if (!thumbnail) return null;
  let candidate = thumbnail.replace(/preview.*\.(jpg|png)$/,'preview.mp4').replace(/-preview.*\.(jpg|png)$/,'.mp4');
  return candidate.endsWith('.mp4') ? candidate : null;
}

function extractClipSlug(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('clips.twitch.tv')) {
      return u.pathname.slice(1); // Remove a barra inicial
    }
  } catch (e) {}
  return url.split('/').pop(); // Fallback: pega a última parte
}

function ensureChannelAuthorized(chan) {
  if (!chan) return;
  const key = chan.toLowerCase();
  const cfg = state.getChannelConfig(key);
  if (!cfg) {
    state.ensureChannelAuthorized(key);
  }
}

// escuta chat
client.on('message', async (channelFull, tags, message, self) => {
  if (self) return;
  const chan = channelFull.replace('#', '').toLowerCase();
  const cfg  = state.getChannelConfig(chan);
  const playerState = state.getChannelState(chan);
  state.ensureChannelAuthorized(chan);

  // — !watch: limpa fila e reproduz um clipe específico
  if (/^!watch(\s|$)/i.test(message)) {
    if (!cfg.allowedCommands.watch.enabled || !isUserAllowed(tags, cfg.allowedCommands.watch.roles)) return;
    let id = (message.split(' ')[1] || '').trim();
    if (!id) return;
    try {
      const u = new URL(id);
      if (u.hostname.includes('clips.twitch.tv')) {
        id = u.pathname.slice(1);
      } else if (u.hostname.includes('twitch.tv') && u.pathname.includes('/clip/')) {
        id = u.pathname.split('/clip/')[1];
      }
    } catch (_) {}

    const info = await getClipInfo(id);
    if (!info) {
      console.warn(`⚠️ [${chan}] !watch: clip não encontrado: ${id}`);
      return;
    }

    const clip = {
      id: extractClipSlug(info.url),
      duration: info.duration || 15,
      url: info.url,
      thumbnail: info.thumbnail_url || null,
      video: normalizeClipUrl(info.thumbnail_url)
    };

    playerState.clipQueue = [];
    playerState.repeatUser = null;
    queueClip(chan, clip);
    return;
  }

  // — !replay: repete o último clipe
  if (/^!replay$/i.test(message)) {
    if (!cfg.allowedCommands.replay.enabled || !isUserAllowed(tags, cfg.allowedCommands.replay.roles)) return;
    if (!playerState.lastClip) return;
    console.log(`[${chan}] !replay -> ${playerState.lastClip.url}`);
    playerState.clipQueue = [];
    playerState.repeatUser = null;
    queueClip(chan, playerState.lastClip);
    return;
  }

  // — !repeat: modo contínuo para um usuário
  const rep = message.match(/^!repeat\s+@?(\w+)/i);
  if (rep) {
    if (!cfg.allowedCommands.repeat.enabled || !isUserAllowed(tags, cfg.allowedCommands.repeat.roles)) return;
    const user = rep[1].toLowerCase();
    if (user.length < 3 || user.length > 25 || !/^[a-z0-9_]+$/.test(user)) {
      console.warn(`[${chan}] !repeat: username inválido: ${user}`);
      return;
    }
    playerState.repeatUser = user;
    console.log(`🔁 [${chan}] Modo repeat ativado para ${user}`);
    await queueUserClip(chan, user).catch(err => console.error(`❌ [${chan}] Erro ao enfileirar clip de ${user}:`, err));
    return;
  }

  // — !stoprepeat: desativa modo repeat
  if (/^!stoprepeat$/i.test(message)) {
    if (!cfg.allowedCommands.repeat.enabled || !isUserAllowed(tags, cfg.allowedCommands.repeat.roles)) return;
    console.log(`[${chan}] modo repeat desativado`);
    playerState.repeatUser = null;
    return;
  }

  // — !stop: cancela tudo
  if (/^!stop$/i.test(message)) {
    if (!cfg.allowedCommands.stop.enabled || !isUserAllowed(tags, cfg.allowedCommands.stop.roles)) return;
    console.log(`[${chan}] !stop`);
    playerState.clipQueue = [];
    playerState.repeatUser = null;
    playerState.isPlaying = false;
    io.to(`overlay:${chan}`).emit('fecharOverlay');
    return;
  }

  // — !so: shoutout aleatório
  const soMatch = message.match(/^!so\s+@?(\w+)/i);
  if (soMatch) {
    if (!cfg.allowedCommands.so.enabled || !isUserAllowed(tags, cfg.allowedCommands.so.roles)) return;
    const targetUser = soMatch[1].toLowerCase();
    if (targetUser.length < 3 || targetUser.length > 25 || !/^[a-z0-9_]+$/.test(targetUser)) {
      console.warn(`[${chan}] !so: username inválido: ${targetUser}`);
      return;
    }
    console.log(`👋 [${chan}] !so ${targetUser}`);
    queueUserClip(chan, targetUser).catch(err => console.error(`❌ [${chan}] Erro ao enfileirar clip de ${targetUser}:`, err));
    return;
  }

  // — !clip: cria clip e loga URL
  if (/^!clip/i.test(message)) {
    if (!cfg.allowedCommands.clip.enabled || !isUserAllowed(tags, cfg.allowedCommands.clip.roles)) return;
    try {
      const ud = await twitchApi.getUserData(chan);
      if (!ud) {
        console.warn(`[${chan}] !clip: usuário não encontrado`);
        return;
      }
      const clipId = await twitchApi.createClip(ud.id, cfg.userAccessToken);
      if (clipId) {
        const url = `https://clips.twitch.tv/${clipId}`;
        console.log(`[${chan}] !clip criado -> ${url}`);
        client.say(channelFull, `Clipe criado: ${url}`);
      }
    } catch (e) {
      console.error(e);
    }
    return;
  }

  // — !repeat: modo repeat de clipes de um usuário
  const repeatMatch = message.match(/^!repeat\s+@?(\w+)/i);
  if (repeatMatch) {
    if (!cfg.allowedCommands.so?.enabled || !isUserAllowed(tags, cfg.allowedCommands.so?.roles)) return;
    const targetUser = repeatMatch[1].toLowerCase();
    if (targetUser.length < 3 || targetUser.length > 25 || !/^[a-z0-9_]+$/.test(targetUser)) {
      console.warn(`[${chan}] !repeat: username inválido: ${targetUser}`);
      return;
    }
    
    const state = getPlayerState(chan);
    if (state.repeatUser === targetUser) {
      console.log(`🔁 [${chan}] !repeat DESATIVADO para ${targetUser}`);
      state.repeatUser = null;
      state.playedUserClips = [];
      client.say(channelFull, `🔁 Repeat desativado`);
    } else {
      console.log(`🔁 [${chan}] !repeat ATIVADO para ${targetUser}`);
      state.repeatUser = targetUser;
      state.playedUserClips = [];
      client.say(channelFull, `🔁 Repeat ativado para ${targetUser}! Clipes aleatórios em loop.`);
      // Inicia o repeat buscando o primeiro clipe
      queueUserClip(chan, targetUser).catch(err => console.error(`❌ Erro ao enfileirar clip repeat:`, err));
    }
    return;
  }
});

// ————— montagem de fila —————
async function queueUserClip(chan, user) {
  const state = getPlayerState(chan);
  
  console.log(`\n🎬 [${chan}] !so ${user}: Buscando clipes na Twitch...`);
  
  try {
    // Buscar dados do usuário
    const userData = await twitchApi.getUserDataByLogin(user);
    if (!userData) {
      console.warn(`⚠️ [${chan}] Usuário ${user} não encontrado na Twitch`);
      return;
    }
    
    const userId = userData.id;
    console.log(`✓ [${chan}] Usuário encontrado: ${userData.login} (ID: ${userId})`);
    
    // Buscar todos os clips da Twitch
    const twitchClips = await twitchApi.getAllUserClips(userId);
    if (!twitchClips || twitchClips.length === 0) {
      console.warn(`⚠️ [${chan}] Nenhum clip encontrado para ${user} na Twitch`);
      return;
    }
    
    console.log(`🎬 [${chan}] Encontrados ${twitchClips.length} clip(s) na Twitch`);
    
    // Filtrar clipes já baixados para não repetir tão rápido
    const allLocalClips = await videoManager.getAllClips();
    const localSlugs = new Set(
      allLocalClips
        .filter(c => c.streamer.toLowerCase() === user.toLowerCase())
        .map(c => c.slug)
    );
    
    // Preferir clipes novos, mas permitir repetição se necessário
    let clipsToConsider = twitchClips.filter(clip => !localSlugs.has(clip.url.split('/').pop()));
    if (clipsToConsider.length === 0) {
      console.log(`📝 [${chan}] Todos os clipes já foram baixados, usando aleatório...`);
      clipsToConsider = twitchClips; // Permitir repetição
    }
    
    // Selecionar um clip ALEATÓRIO
    const selectedClip = clipsToConsider[Math.floor(Math.random() * clipsToConsider.length)];
    const clipSlug = selectedClip.url.split('/').pop();
    
    try {
      // Buscar nome real do clip via API
      let clipName = selectedClip.title;
      const clipDetailsFromAPI = await twitchApi.getClipInfoBySlug(clipSlug);
      if (clipDetailsFromAPI && clipDetailsFromAPI.title) {
        clipName = clipDetailsFromAPI.title;
      }
      
      // Extrair token via Puppeteer (com fallback manual)
      const { url: downloadUrl, extractedAt, method } = await clipTokenExtractor.extractClipTokenViaHeadless(clipSlug);
      
      // Preparar diretório
      const outputDir = path.join(__dirname, 'data', 'videos', user.toLowerCase(), clipSlug);
      
      // Usar nome real do clip para o arquivo (sanitizando caracteres inválidos em nomes de arquivo)
      const sanitizedClipName = clipName.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
      const outputPath = path.join(outputDir, `${sanitizedClipName}.mp4`);
      
      // Verificar se já foi baixado
      if (fs.existsSync(outputPath)) {
        console.log(`✓ Clipe já existe no disco`);
      } else {
        // Fazer download
        await clipTokenExtractor.downloadClipWithToken(downloadUrl, outputPath);
      }
      
      // Salvar metadata
      const metadata = {
        slug: clipSlug,
        streamer: user.toLowerCase(),
        title: clipName,
        creator: selectedClip.creator_name,
        views: selectedClip.view_count,
        duration: selectedClip.duration || 15,
        createdAt: selectedClip.created_at,
        downloadedAt: new Date().toISOString(),
        downloadMethod: method
      };
      
      fs.writeFileSync(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
      
    } catch (downloadErr) {
      console.error(`❌ [${chan}] Erro ao baixar clipe:`, downloadErr.message);
      return;
    }
    
    // Enfileira para reprodução
    const clip = {
      id: clipSlug,
      channel: user,
      duration: selectedClip.duration || 15,
      url: `/videos/${user}/${clipSlug}/${sanitizedClipName}.mp4`,
      thumbnail: null,
      title: clipName
    };
    
    state.clipQueue.push(clip);
    playNext(chan);
    
    // Se está em modo repeat, marca para próxima
    if (state.repeatUser === user) {
      state.playedUserClips.push(clipSlug);
    }
    
  } catch (err) {
    console.error(`❌ [${chan}] Erro ao processar clipes:`, err.message);
  }
}

/**
 * Baixa e salva um clip localmente
 * @param {string} slug - Slug único do clip
 * @param {string} streamerName - Nome do streamer (username) para organizar pasta
 * @param {string} videoUrl - URL do vídeo MP4 para baixar
 * @returns {Promise<string>} - Caminho local do arquivo salvo
 */
async function downloadAndSaveClip(slug, streamerName, videoUrl) {
  try {
    console.log(`\n📥 [DOWNLOAD] Iniciando download ${slug}`);
    console.log(`   Streamer: ${streamerName}`);
    console.log(`   URL: ${videoUrl.substring(0, 80)}...`);

    // 1. Verifica se já existe no cache local
    const existing = await videoManager.getVideoPath(slug, streamerName);
    if (existing) {
      console.log(`   ✅ Clip encontrado no cache: ${existing}`);
      return existing;
    }

    // 2. Baixa o arquivo
    console.log(`   ⏳ Baixando arquivo...`);
    const downloadResult = await videoDownloader.download(videoUrl, {
      maxRetries: 3,
      timeout: 60000,
      onProgress: (progress) => {
        const percent = progress.percent || 0;
        const sizeMB = (progress.total / 1024 / 1024).toFixed(2);
        console.log(`   📊 Progresso: ${percent}% (${sizeMB}MB)`);
      }
    });

    if (!downloadResult || !downloadResult.stream) {
      throw new Error('Falha ao obter stream de download');
    }

    // 3. Salva o arquivo usando VideoManager
    console.log(`   💾 Salvando arquivo...`);
    const saveResult = await videoManager.saveVideo(
      slug, 
      streamerName, 
      downloadResult.stream, 
      {
        videoUrl,
        downloadedAt: new Date().toISOString(),
        size: downloadResult.size || 0
      }
    );

    console.log(`   ✅ Arquivo salvo com sucesso!`);
    console.log(`      Caminho: ${saveResult.videoPath}`);
    console.log(`      Tamanho: ${videoManager.formatBytes(saveResult.size)}`);

    return saveResult.videoPath;
  } catch (err) {
    console.error(`   ❌ Erro ao baixar/salvar clip ${slug}:`, err.message);
    throw err;
  }
}

// ————— PROFILE SYSTEM —————
// Storage com persistência em arquivos JSON
let UserProfiles = persistence.loadUserProfiles();
let StreamersMonitored = persistence.loadStreamersMonitored();

// Cooldown para evitar notificações duplicadas (Por streamer em ms)
const streamerNotificationCooldown = new Map();
const NOTIFICATION_COOLDOWN = 10 * 1000; // 10 segundos

// Função auxiliar para verificar status ao vivo
async function checkStreamerLive(login) {
  try {
    const stream = await twitchApi.getStream(login);
    return !!stream; // Retorna true se está ao vivo, false caso contrário
  } catch (err) {
    console.error(`Erro ao verificar live status de ${login}:`, err);
    return false;
  }
}

// Função para notificar via Discord webhook
async function notifyStreamerLive(userId, streamer) {
  try {
    const profile = UserProfiles.get(userId);
    if (!profile?.discordWebhookUrl) return false;

    // Evitar spam - verificar se já notificou nos últimos 30 minutos
    const lastNotification = streamer.lastLiveNotification || 0;
    if (Date.now() - lastNotification < 30 * 60 * 1000) {
      console.log(`⏭️ Notificação recente para ${streamer.displayName}, pulando...`);
      return false;
    }

    // Criar embed customizado
    const embed = discordApi.createStreamLiveEmbed(streamer, streamer.profileImageUrl);
    const sent = await discordApi.sendWebhookMessage(profile.discordWebhookUrl, embed);
    
    if (sent) {
      streamer.lastLiveNotification = Date.now();
      console.log(`✅ Notificação enviada para ${streamer.displayName} via Discord`);
    }
    
    return sent;
  } catch (err) {
    console.error(`Erro ao notificar streamer ${streamer.displayName}:`, err);
    return false;
  }
}

// Função para verificar e notificar streamers ao vivo (executar periodicamente)
async function checkAndNotifyLiveStreamers() {
  try {
    for (const [userId, streamers] of StreamersMonitored.entries()) {
      for (const streamer of streamers) {
        const isLive = await checkStreamerLive(streamer.streamerName);
        const wasLive = streamer.isLive;

        streamer.isLive = isLive;
        streamer.lastChecked = new Date();

        // Notificar quando mudar de offline para live
        if (isLive && !wasLive) {
          console.log(`🔴 ${streamer.displayName} ficou LIVE! Notificação agendada em 10s...`);
          
          // Agendar notificação em 10 segundos (permitir que stream estabilize)
          setTimeout(async () => {
            // Verificar se ainda está online após 10 segundos
            const stillLive = await checkStreamerLive(streamer.streamerName);
            if (stillLive) {
              await notifyStreamerLive(userId, streamer);
            } else {
              console.log(`⏭️ ${streamer.displayName} saiu da live antes de notificar`);
            }
          }, NOTIFICATION_COOLDOWN);
        }
      }
      // Atualizar no map
      StreamersMonitored.set(userId, streamers);
    }
    
    // Salvar dados após verificação
    persistence.saveStreamersMonitored(StreamersMonitored);
  } catch (err) {
    console.error('Live check error:', err);
  }
}

// GET /api/profile
app.get('/api/profile', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('[API-PROFILE] Buscando perfil do usuário:', userId);
    console.log('[API-PROFILE] Dados da sessão:', {
      id: req.user.id,
      login: req.user.login,
      username: req.user.username,
      display_name: req.user.display_name,
      profile_image_url: req.user.profile_image_url,
      email: req.user.email
    });
    
    let profile = UserProfiles.get(userId);
    
    if (!profile) {
      console.log('[API-PROFILE] Perfil não encontrado, criando novo para:', userId);
      // Criar novo perfil com dados atuais da sessão
      profile = {
        id: req.user.id,
        username: req.user.login || req.user.username,
        displayName: req.user.display_name,
        email: req.user.email || '',
        profileImageUrl: req.user.profile_image_url,
        createdAt: new Date(),
        discordId: null,
        discord: null,
        discordWebhookUrl: null,
        notificationsEnabled: true
      };
      console.log('[API-PROFILE] Novo perfil criado:', {
        username: profile.username,
        displayName: profile.displayName,
        profileImageUrl: profile.profileImageUrl
      });
      UserProfiles.set(userId, profile);
    } else {
      console.log('[API-PROFILE] Perfil encontrado, atualizando dados');
      // Atualizar dados do perfil com informações atuais da sessão
      const oldImage = profile.profileImageUrl;
      profile.username = req.user.login || req.user.username || profile.username;
      profile.displayName = req.user.display_name || profile.displayName;
      profile.profileImageUrl = req.user.profile_image_url || profile.profileImageUrl;
      profile.email = req.user.email || profile.email;
      console.log('[API-PROFILE] Perfil atualizado:', {
        username: profile.username,
        displayName: profile.displayName,
        profileImageUrl: profile.profileImageUrl,
        imageChanged: oldImage !== profile.profileImageUrl
      });
    }

    const streamers = StreamersMonitored.get(userId) || [];
    
    const responseData = {
      ...profile,
      streamersMonitoring: streamers.length
    };
    
    console.log('[API-PROFILE] Retornando perfil:', {
      username: responseData.username,
      displayName: responseData.displayName,
      profileImageUrl: responseData.profileImageUrl,
      discordId: responseData.discordId,
      streamersMonitoring: responseData.streamersMonitoring
    });
    
    res.json(responseData);
  } catch (err) {
    console.error('[API-PROFILE] Erro ao carregar perfil:', err);
    console.error('[API-PROFILE] Stack:', err.stack);
    res.status(500).json({ error: 'Erro ao carregar perfil' });
  }
});

// GET /api/discord/guilds - Listar servidores Discord do usuário
app.get('/api/discord/guilds', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = UserProfiles.get(userId);
    
    if (!profile?.discord?.accessToken) {
      return res.status(400).json({ error: 'Discord não vinculado' });
    }

    console.log('[API-DISCORD-GUILDS] Listando servidores Discord para:', userId);
    
    const guilds = await discordApi.getUserGuilds(profile.discord.accessToken);
    console.log('[API-DISCORD-GUILDS] Encontrados', guilds.length, 'servidores');
    
    res.json({ guilds });
  } catch (err) {
    console.error('[API-DISCORD-GUILDS] Erro:', err);
    res.status(500).json({ error: 'Erro ao listar servidores' });
  }
});

// GET /api/discord/guilds/:guildId/channels - Listar canais de um servidor
app.get('/api/discord/guilds/:guildId/channels', ensureAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    
    console.log('[API-DISCORD-CHANNELS] Listando canais do servidor:', guildId);
    
    const channels = await discordApi.getGuildChannels(guildId, DISCORD_BOT_TOKEN);
    console.log('[API-DISCORD-CHANNELS] Encontrados', channels.length, 'canais');
    
    res.json({ channels });
  } catch (err) {
    console.error('[API-DISCORD-CHANNELS] Erro:', err);
    res.status(500).json({ error: 'Erro ao listar canais' });
  }
});

// PUT /api/profile
app.put('/api/profile', ensureAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const { email, notificationsEnabled } = req.body;
    
    let profile = UserProfiles.get(userId);
    if (!profile) {
      return res.status(404).json({ error: 'Perfil não encontrado' });
    }

    profile.notificationsEnabled = typeof notificationsEnabled === 'boolean' ? notificationsEnabled : true;
    
    UserProfiles.set(userId, profile);
    persistence.saveUserProfiles(UserProfiles);
    res.json({ success: true, profile });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

// POST /api/profile/webhook - Salvar webhook com validação
app.post('/api/profile/webhook', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ error: 'URL de webhook é obrigatória' });
    }

    // Validar webhook
    const isValid = await discordApi.validateWebhook(webhookUrl);
    if (!isValid) {
      return res.status(400).json({ error: 'Webhook inválido. Verifique a URL' });
    }

    let profile = UserProfiles.get(userId);
    if (!profile) {
      return res.status(404).json({ error: 'Perfil não encontrado' });
    }

    profile.discordWebhookUrl = webhookUrl;
    UserProfiles.set(userId, profile);
    persistence.saveUserProfiles(UserProfiles);
    
    // Enviar mensagem de confirmação
    const confirmEmbed = discordApi.createTestEmbed();
    await discordApi.sendWebhookMessage(webhookUrl, confirmEmbed);
    
    res.json({ success: true, message: 'Webhook salvo e validado com sucesso!' });
  } catch (err) {
    console.error('Webhook save error:', err);
    res.status(500).json({ error: 'Erro ao salvar webhook' });
  }
});

// GET /auth/discord/callback - Callback do OAuth Discord
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.redirect('/profile?error=discord_auth_failed');
    }

    if (!code) {
      return res.redirect('/profile?error=no_code');
    }

    // Fazer token exchange
    const tokenData = await discordApi.exchangeCodeForToken(code);
    const discordUser = await discordApi.getUserData(tokenData.access_token);

    // Buscar Twitch user da sessão
    if (!req.user) {
      return res.redirect('/auth/twitch');
    }

    const userId = req.user.id;
    let profile = UserProfiles.get(userId);
    
    if (!profile) {
      profile = {
        id: userId,
        username: req.user.login,
        displayName: req.user.display_name,
        email: req.user.email || '',
        profileImageUrl: req.user.profile_image_url,
        createdAt: new Date(),
        discordId: null,
        discord: null,
        discordWebhookUrl: null,
        notificationsEnabled: true
      };
    }

    // Atualizar com dados do Discord
    profile.discordId = discordUser.id;
    profile.discord = {
      id: discordUser.id,
      username: discordUser.username,
      tag: discordUser.tag,
      email: discordUser.email,
      avatar: discordUser.avatar,
      verified: discordUser.verified,
      accessToken: tokenData.access_token,
      linkedAt: new Date()
    };

    UserProfiles.set(userId, profile);
    persistence.saveUserProfiles(UserProfiles);
    console.log(`✅ Discord vinculado para usuário ${userId}: ${discordUser.tag}`);

    res.redirect('/profile?discord_linked=true');
  } catch (err) {
    console.error('Discord OAuth callback error:', err);
    res.redirect('/profile?error=discord_auth_error');
  }
});

// GET /api/profile/discord - Buscar dados do Discord
app.get('/api/profile/discord', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = UserProfiles.get(userId);
    
    if (!profile || !profile.discord) {
      return res.status(404).json({ error: 'Discord não vinculado' });
    }

    res.json(profile.discord);
  } catch (err) {
    console.error('Discord get error:', err);
    res.status(500).json({ error: 'Erro ao buscar dados Discord' });
  }
});

// POST /api/profile/discord/webhook/test - Testar webhook
app.post('/api/profile/discord/webhook/test', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = UserProfiles.get(userId);
    
    if (!profile || !profile.discordWebhookUrl) {
      return res.status(400).json({ error: 'Webhook não configurado' });
    }

    // Validar webhook
    const isValid = await discordApi.validateWebhook(profile.discordWebhookUrl);
    if (!isValid) {
      return res.status(400).json({ error: 'Webhook inválido ou expirado' });
    }

    // Enviar teste
    const testEmbed = discordApi.createTestEmbed();
    const sent = await discordApi.sendWebhookMessage(profile.discordWebhookUrl, testEmbed);
    
    if (!sent) {
      return res.status(400).json({ error: 'Erro ao enviar mensagem de teste' });
    }

    res.json({ success: true, message: 'Mensagem de teste enviada!' });
  } catch (err) {
    console.error('Webhook test error:', err);
    res.status(500).json({ error: 'Erro ao testar webhook' });
  }
});

// DELETE /api/profile/discord
app.delete('/api/profile/discord', ensureAuth, (req, res) => {
  try {
    const userId = req.user.id;
    let profile = UserProfiles.get(userId);
    
    if (!profile) {
      return res.status(404).json({ error: 'Perfil não encontrado' });
    }

    profile.discordId = null;
    profile.discord = null;
    profile.discordWebhookUrl = null;
    UserProfiles.set(userId, profile);
    persistence.saveUserProfiles(UserProfiles);

    res.json({ success: true });
  } catch (err) {
    console.error('Discord disconnect error:', err);
    res.status(500).json({ error: 'Erro ao desconectar' });
  }
});

// GET /api/streamers
app.get('/api/streamers', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('[API-STREAMERS] Listando streamers para usuário:', userId);
    
    const streamers = StreamersMonitored.get(userId) || [];
    console.log('[API-STREAMERS] Encontrados', streamers.length, 'streamers');
    
    // Enriquecer dados com informações da Twitch
    const enriched = await Promise.all(
      streamers.map(async (s) => {
        try {
          const twitchUser = await twitchApi.getUserDataByLogin(s.streamerName);
          if (twitchUser) {
            const isLive = await checkStreamerLive(twitchUser.login);
            const result = {
              ...s,
              id: twitchUser.id,
              displayName: twitchUser.display_name,
              profileImageUrl: twitchUser.profile_image_url,
              isLive: isLive
            };
            console.log(`[API-STREAMERS] Streamer ${s.streamerName} enriquecido - Live: ${isLive}`);
            return result;
          }
        } catch (e) {
          console.error(`[API-STREAMERS] Erro ao enriquecer dados de ${s.streamerName}:`, e);
        }
        return s;
      })
    );
    
    console.log('[API-STREAMERS] Retornando', enriched.length, 'streamers');
    res.json(enriched);
  } catch (err) {
    console.error('[API-STREAMERS] Erro ao listar streamers:', err);
    console.error('[API-STREAMERS] Stack:', err.stack);
    res.status(500).json({ error: 'Erro ao listar streamers' });
  }
});

// POST /api/streamers
app.post('/api/streamers', ensureAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { streamerName, discordServerId, discordChannelId } = req.body;

    console.log('[API-STREAMERS-POST] Adicionando streamer:', {
      userId,
      streamerName,
      discordServerId,
      discordChannelId
    });

    if (!streamerName || !discordServerId || !discordChannelId) {
      console.warn('[API-STREAMERS-POST] Campos obrigatórios faltando');
      return res.status(400).json({ error: 'Preencha todos os campos' });
    }

    // Validar streamer na Twitch
    console.log('[API-STREAMERS-POST] Buscando streamer na Twitch:', streamerName);
    const twitchUser = await twitchApi.getUserDataByLogin(streamerName.toLowerCase());
    
    if (!twitchUser) {
      console.warn('[API-STREAMERS-POST] Streamer não encontrado na Twitch:', streamerName);
      return res.status(404).json({ error: 'Streamer não encontrado na Twitch' });
    }

    console.log('[API-STREAMERS-POST] Streamer encontrado na Twitch:', twitchUser.id, twitchUser.login);

    if (!StreamersMonitored.has(userId)) {
      StreamersMonitored.set(userId, []);
    }
    
    // Verificar se já existe
    const list = StreamersMonitored.get(userId);
    if (list.some(s => s.streamerName === twitchUser.login.toLowerCase())) {
      console.warn('[API-STREAMERS-POST] Streamer já está sendo monitorado');
      return res.status(400).json({ error: 'Streamer já está sendo monitorado' });
    }

    const streamer = {
      id: twitchUser.id,
      userId,
      streamerName: twitchUser.login.toLowerCase(),
      displayName: twitchUser.display_name,
      profileImageUrl: twitchUser.profile_image_url,
      discordServerId,
      discordChannelId,
      isLive: false,
      lastLiveNotification: null,
      lastChecked: new Date(),
      addedAt: new Date()
    };

    console.log('[API-STREAMERS-POST] Streamer criado:', streamer);

    list.push(streamer);
    StreamersMonitored.set(userId, list);
    persistence.saveStreamersMonitored(StreamersMonitored);

    console.log('[API-STREAMERS-POST] Streamer adicionado com sucesso');
    res.json({ success: true, streamer });
  } catch (err) {
    console.error('Streamer add error:', err);
    res.status(500).json({ error: 'Erro ao adicionar streamer' });
  }
});

// DELETE /api/streamers/:streamerId
app.delete('/api/streamers/:streamerId', ensureAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const { streamerId } = req.params;

    const list = StreamersMonitored.get(userId) || [];
    const idx = list.findIndex(s => s.id === streamerId);
    
    if (idx === -1) {
      return res.status(404).json({ error: 'Streamer não encontrado' });
    }

    list.splice(idx, 1);
    StreamersMonitored.set(userId, list);
    persistence.saveStreamersMonitored(StreamersMonitored);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Streamer remove error:', err);
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

// ————— API Download de Clips —————

// POST /api/extract-clip-url - DESCONTINUADO
// A extração automática de URL não é mais possível
// Use download-with-token.js com URL completa do DevTools
app.post('/api/extract-clip-url', async (req, res) => {
  return res.status(410).json({ 
    error: 'Endpoint descontinuado',
    message: 'A extração automática de URL não é mais funcional',
    instructions: 'Use download-with-token.js com a URL completa extraída do DevTools Network tab'
  });
});

// POST /api/download-clip - Faz download do clipe e salva localmente
app.post('/api/download-clip', async (req, res) => {
  try {
    const { video_url, clip_slug, streamer_name } = req.body;

    if (!video_url || !clip_slug) {
      return res.status(400).json({ error: 'video_url e clip_slug são obrigatórios' });
    }

    console.log(`\n📥 [DOWNLOAD-CLIP] Iniciando download`);
    console.log(`   Slug: ${clip_slug}`);
    console.log(`   Streamer: ${streamer_name || 'unknown'}`);
    console.log(`   URL: ${video_url.substring(0, 80)}...`);

    // Faz download e salva
    const result = await downloadAndSaveClip(
      clip_slug,
      streamer_name || 'unknown',
      video_url
    );

    if (!result) {
      console.error(`❌ [DOWNLOAD-CLIP] Falha ao baixar: ${clip_slug}`);
      return res.status(400).json({ 
        error: 'Falha ao baixar o vídeo',
        clip_slug 
      });
    }

    console.log(`✅ [DOWNLOAD-CLIP] Download completo: ${result}`);

    res.json({
      success: true,
      clip_slug,
      file_path: result
    });
  } catch (err) {
    console.error('[DOWNLOAD-CLIP] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/get-streamers - Lista streamers monitorados
app.get('/api/get-streamers', (req, res) => {
  try {
    const streamers = new Set();

    // Coleta todos os streamers de todos os usuários
    for (const [userId, streamerList] of StreamersMonitored) {
      if (Array.isArray(streamerList)) {
        streamerList.forEach(s => {
          if (s.streamerName) {
            streamers.add(s.streamerName);
          }
        });
      }
    }

    const streamerArray = Array.from(streamers).sort();
    console.log(`[GET-STREAMERS] Retornando ${streamerArray.length} streamers`);

    res.json({
      success: true,
      streamers: streamerArray
    });
  } catch (err) {
    console.error('[GET-STREAMERS] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/get-streamers - Lista streamers monitorados
app.get('/api/get-streamers', (req, res) => {
  try {
    const streamers = new Set();

    // Coleta todos os streamers de todos os usuários
    for (const [userId, streamerList] of StreamersMonitored) {
      if (Array.isArray(streamerList)) {
        streamerList.forEach(s => {
          if (s.streamerName) {
            streamers.add(s.streamerName);
          }
        });
      }
    }

    const streamerArray = Array.from(streamers).sort();
    console.log(`[GET-STREAMERS] Retornando ${streamerArray.length} streamers`);

    res.json({
      success: true,
      streamers: streamerArray
    });
  } catch (err) {
    console.error('[GET-STREAMERS] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clips-list - Lista todos os clipes baixados
app.get('/api/clips-list', async (req, res) => {
  try {
    console.log(`\n📋 [CLIPS-LIST] Listando todos os clipes...`);
    
    const clipsList = await videoManager.getAllClips();
    let totalSize = 0;

    const clips = clipsList.map(clip => {
      totalSize += clip.size || 0;
      return {
        streamer: clip.streamer,
        slug: clip.slug,
        size: clip.size || 0,
        downloadedAt: clip.downloadedAt,
        title: clip.title,
        duration: clip.duration
      };
    });

    console.log(`   ✅ Total: ${clips.length} clipes (${videoManager.formatBytes(totalSize)})`);

    res.json({
      success: true,
      clips,
      totalSize,
      count: clips.length
    });
  } catch (err) {
    console.error('[CLIPS-LIST] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clips-delete - Deleta um clipe
app.post('/api/clips-delete', async (req, res) => {
  try {
    const { streamer, slug } = req.body;

    if (!streamer || !slug) {
      return res.status(400).json({ error: 'streamer e slug são obrigatórios' });
    }

    console.log(`\n🗑️  [CLIPS-DELETE] Deletando: ${streamer}/${slug}`);

    const success = await videoManager.deleteVideo(slug, streamer);

    if (!success) {
      return res.status(404).json({ error: 'Clipe não encontrado' });
    }

    console.log(`   ✅ Clipe deletado com sucesso`);

    res.json({
      success: true,
      message: 'Clipe deletado com sucesso'
    });
  } catch (err) {
    console.error('[CLIPS-DELETE] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /videos/:streamer/:slug/clip.mp4 - Serve arquivo de vídeo
app.get('/videos/:streamer/:slug/clip.mp4', async (req, res) => {
  try {
    const { streamer, slug } = req.params;

    const videoPath = await videoManager.getVideoPath(slug, streamer);

    if (!videoPath) {
      console.warn(`⚠️  Vídeo não encontrado: ${streamer}/${slug}`);
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    console.log(`📹 Servindo vídeo: ${streamer}/${slug}`);

    // Configura headers para streaming
    res.type('video/mp4');
    res.sendFile(videoPath, (err) => {
      if (err && err.code !== 'ERR_HTTP_HEADERS_SENT') {
        console.error('Erro ao enviar vídeo:', err);
      }
    });
  } catch (err) {
    console.error('[VIDEOS-STREAM] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ————— WebSocket —————
io.on('connection', socket => {
  let chan = (socket.handshake.query.channel || '').toLowerCase().replace('#','');
  if (!chan) {
    console.warn('⚠️ Conexão WebSocket sem canal especificado');
    socket.disconnect(true);
    return;
  }

  // segurança: só permite overlays para canais registrados
  const cfg = state.getChannelConfig(chan);
  if (!cfg) {
    console.warn(`⚠️ Conexão WebSocket para canal não registrado: ${chan}`);
    socket.disconnect(true);
    return;
  }

  const room = `overlay:${chan}`;
  console.log(`🔌 [${chan}] Nova conexão WebSocket (room: ${room})`);
  socket.join(room);

  const playerState = state.initChannelState(chan);
  const channelState = state.getChannelState(chan);

  // Quando o overlay informar que um clipe finalizou
  socket.on('clipFinalizado', async () => {
    console.log(`✔️ [${chan}] Clip finalizado`);
    const s = state.getChannelState(chan);
    s.isPlaying = false;

    if (s.repeatUser) {
      await queueUserClip(chan, s.repeatUser).catch(err => {
        console.error(`❌ [${chan}] Erro no repeat:`, err);
      });
    }

    if (s.clipQueue.length > 0) {
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

// ════════════════════════════════════════════════════════
// ═══════ VIDEO STREAMING & MANAGEMENT ROUTES ═══════════
// ════════════════════════════════════════════════════════

/**
 * GET /api/video/:slug.mp4
 * Serve vídeo do clipe (download automático se não existe)
 */
app.get('/api/video/:slug.mp4', async (req, res) => {
  try {
    const { slug } = req.params;
    const { channel } = req.query;

    // Validação de slug (evita path traversal)
    if (!slug.match(/^[A-Za-z0-9_-]+$/)) {
      console.warn(`⚠️ [VIDEO] Slug inválido: ${slug}`);
      return res.status(400).json({ error: 'Invalid slug format' });
    }

    // Validação de channel (streamer name)
    if (!channel) {
      console.warn(`⚠️ [VIDEO] Channel não fornecido para slug ${slug}`);
      return res.status(400).json({ error: 'Channel parameter required' });
    }

    console.log(`\n📍 [VIDEO] GET /api/video/${slug}.mp4?channel=${channel}`);

    // Verifica cache local
    let videoPath = await videoManager.getVideoPath(slug, channel);

    if (videoPath) {
      console.log(`✅ [VIDEO] Usando cache: ${channel}/${slug}`);
    } else {
      console.log(`⬇️ [VIDEO] Clip não em cache, iniciando download: ${channel}/${slug}`);

      try {
        // Obtém URL real do vídeo
        console.log(`🔍 [VIDEO] Buscando URL real do vídeo...`);
        const videoUrl = await videoDownloader.getClipVideoURL(slug, channel);
        
        if (!videoUrl) {
          console.error(`❌ [VIDEO] Falha ao obter URL do vídeo para ${channel}/${slug} (retornou null/undefined)`);
          return res.status(503).json({
            error: 'Unable to fetch video URL',
            message: 'VideoDownloader não conseguiu obter URL (tente verificar GraphQL token ou Twitch API)'
          });
        }
        
        console.log(`✅ [VIDEO] URL obtida: ${videoUrl.substring(0, 80)}...`);

        // Inicia download
        console.log(`📥 [VIDEO] Iniciando download...`);
        const { stream, size } = await videoDownloader.download(videoUrl, {
          maxRetries: 3,
          timeout: 120000,
          onProgress: (progress) => {
            const percent = progress.percent;
            if (percent === 25 || percent === 50 || percent === 75 || percent >= 95) {
              console.log(
                `📥 [VIDEO] ${percent}% - ` +
                `${videoManager.formatBytes(progress.downloaded)} / ` +
                `${videoManager.formatBytes(progress.total)}`
              );
            }
          }
        });

        console.log(`✅ [VIDEO] Download completo! Salvando...`);

        // Salva localmente
        const result = await videoManager.saveVideo(slug, channel, stream, {
          source: 'twitch',
          downloadedAt: new Date().toISOString(),
          size
        });

        videoPath = result.videoPath;
        console.log(`💾 [VIDEO] Salvo em: ${videoPath} (${videoManager.formatBytes(size)})`);
      } catch (dlErr) {
        console.error(`❌ [VIDEO] Falha no download: ${dlErr.message}`);
        return res.status(500).json({
          error: 'Failed to download video',
          message: dlErr.message
        });
      }
    }

    // Serve o arquivo
    const stat = await fs.promises.stat(videoPath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=604800');

    const readStream = fs.createReadStream(videoPath);
    readStream.pipe(res);

    readStream.on('error', (err) => {
      console.error(`❌ [VIDEO] Erro ao servir: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming video' });
      }
    });

    console.log(`✅ [VIDEO] Servindo: ${slug}`);
  } catch (err) {
    console.error(`❌ [VIDEO] Erro geral:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
  }
});

/**
 * GET /api/videos
 * Lista todos os vídeos em cache
 */
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await videoManager.listVideos();
    const totalSize = await videoManager.getTotalSize();

    res.json({
      status: 'ok',
      count: videos.length,
      totalSize: videoManager.formatBytes(totalSize),
      videos: videos.sort((a, b) => new Date(b.downloadedAt) - new Date(a.downloadedAt))
    });
  } catch (err) {
    console.error(`❌ [API] Erro em /api/videos:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/video/:slug
 * Remove vídeo do cache (requer autenticação)
 */
app.delete('/api/video/:slug', (req, res) => {
  try {
    const token = req.cookies?.admin_token || req.headers['x-admin-token'];
    if (!token || !req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { slug } = req.params;
    const { channel } = req.query;

    if (!slug.match(/^[A-Za-z0-9_-]+$/)) {
      return res.status(400).json({ error: 'Invalid slug' });
    }

    if (!channel) {
      return res.status(400).json({ error: 'Channel parameter required' });
    }

    videoManager.deleteVideo(slug, channel).then(success => {
      if (success) {
        res.json({ success: true, message: `Vídeo ${channel}/${slug} removido` });
      } else {
        res.status(404).json({ error: 'Video not found' });
      }
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health
 * Status do servidor
 */
app.get('/api/health', async (req, res) => {
  try {
    const totalSize = await videoManager.getTotalSize();
    const videos = await videoManager.listVideos();

    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      videoCache: {
        videos: videos.length,
        sizeBytes: totalSize,
        sizeFormatted: videoManager.formatBytes(totalSize)
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

// ════════════════════════════════════════════════════════

// ————— Inicia —————
server.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log('🔑 TWITCH_CLIENT_ID:', TWITCH_CLIENT_ID);
  console.log('📍 CALLBACK_URL:', CALLBACK_URL);
  console.log('🎯 Canais monitorados:', state.getChannelsToMonitor().length);
  console.log('========================================\n');

  // Iniciar verificação periódica de streamers live
  checkAndNotifyLiveStreamers(); // Executar uma vez ao iniciar
  setInterval(checkAndNotifyLiveStreamers, 1 * 60 * 1000); // Executar a cada 1 minuto
  console.log('🔍 Sistema de notificações de stream ativado (verificação a cada 1 min)');
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
