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
if (!PORT || PORT < 1024) PORT = 3000;

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

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
  profile.accessToken = accessToken;
  return done(null, profile);
}));
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  // Redireciona direto para autenticação, sem tela intermediária
  return passport.authenticate('twitch')(req, res, next);
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

// ————— Rotas —————
app.get('/', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.get('/auth/twitch', passport.authenticate('twitch'));
app.get('/auth/twitch/callback',
  passport.authenticate('twitch', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);
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
  const chan = req.body.channel.toLowerCase();
  if (!channelsToMonitor.includes(chan)) {
    channelsToMonitor.push(chan);
    // Cria config padrão se não existir
    if (!channelConfigs[chan]) {
      channelConfigs[chan] = { allowedCommands: defaultConfig.allowedCommands };
    }
    fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
    client.join(chan).catch(console.error);
  }
  res.json({ success: true });
});

// Salva configurações vindas do front

app.post('/save-config', ensureAuth, (req, res) => {
  const chan = req.user.display_name.toLowerCase();
  channelConfigs[chan] = {
    allowedCommands: req.body.allowedCommands
  };
  fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
  res.json({ success: true });
});

app.get('/overlay/:channel', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/overlay.html'))
);

// ————— Twitch API Helpers —————
let TWITCH_TOKEN   = null;
let tokenExpiresAt = 0;

async function updateAccessToken() {
  const url = `https://id.twitch.tv/oauth2/token` +
              `?client_id=${TWITCH_CLIENT_ID}` +
              `&client_secret=${TWITCH_CLIENT_SECRET}` +
              `&grant_type=client_credentials`;
  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json();
  TWITCH_TOKEN   = `Bearer ${data.access_token}`;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
}

async function getUserData(username) {
  if (!TWITCH_TOKEN || Date.now() >= tokenExpiresAt - 60000) {
    await updateAccessToken();
  }
  const resp = await fetch(
    `https://api.twitch.tv/helix/users?login=${username}`,
    { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  return json.data[0] || null;
}

async function getAllUserClips(userId) {
  let all = [], cursor = null;
  do {
    const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${userId}&first=100${cursor?`&after=${cursor}`:''}`;
    const resp = await fetch(url, { headers: { 'Client-ID':TWITCH_CLIENT_ID, 'Authorization':TWITCH_TOKEN } });
    const json = await resp.json();
    all.push(...json.data);
    cursor = json.pagination?.cursor || null;
  } while (cursor);
  return all;
}

async function getClipInfo(id) {
  if (!TWITCH_TOKEN || Date.now() >= tokenExpiresAt - 60000) {
    await updateAccessToken();
  }
  const resp = await fetch(
    `https://api.twitch.tv/helix/clips?id=${id}`,
    { headers:{ 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': TWITCH_TOKEN } }
  );
  const json = await resp.json();
  return json.data[0] || null;
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
  options: { debug: true },
  identity:{ username: BOT_USERNAME, password: BOT_OAUTH },
  channels: channelsToMonitor
});
client.connect().catch(console.error);

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
    if (!info) return;
    console.log(`[${chan}] !watch -> ${info.url}`);
    clipQueues[chan] = [];
    repeatCfg[chan]  = null;
    lastClip[chan]   = { id, duration: info.duration, url: info.url };
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
  const user = rep[1].toLowerCase();
  repeatCfg[chan] = user;
  console.log(`[${chan}] modo repeat ativado para ${user}`);
  // já enfileira o primeiro
  await queueUserClip(chan, user);
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
    queueUserClip(chan, message.match(/^!so\s+@?(\w+)/i)[1].toLowerCase());
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
  if (!ud) return;
  const clips = await getAllUserClips(ud.id);
  // filtra já tocados em so/repeat
  const pool  = clips.filter(c => !playedSo[chan].includes(c.id) && !playedUserClips[chan].includes(c.id));
  if (!pool.length) {
    playedSo[chan] = [];
    playedUserClips[chan] = [];
    return queueUserClip(chan, user);
  }
  const pick = pool[Math.floor(Math.random()*pool.length)];
  playedSo[chan].push(pick.id);
  if (repeatCfg[chan] === user) playedUserClips[chan].push(pick.id);
  clipQueues[chan].push({ id: pick.id, duration: pick.duration, url: pick.url });
  playNext(chan);
}

// ————— toca próximo —————
function playNext(chan) {
  if (isPlaying[chan] || !clipQueues[chan].length) return;
  const clip = clipQueues[chan].shift();
  lastClip[chan]  = clip;
  isPlaying[chan] = true;
  console.log(`Reproduzindo em ${chan} → ${clip.url}`);
  io.to(chan).emit('novoClip', clip);
}

// ————— WebSocket —————
io.on('connection', socket => {
  let chan = socket.handshake.query.channel?.replace('#','');
  if (!chan) return;
  socket.join(chan);
  isPlaying[chan] = false;

  socket.on('clipFinalizado', async () => {
    isPlaying[chan] = false;
    // se modo repeat ativo, enfileira mais um
    if (repeatCfg[chan]) {
      await queueUserClip(chan, repeatCfg[chan]);
    }
    playNext(chan);
  });
  socket.on('fecharOverlay', () => {}); // só para enviar
});

// ————— Inicia —————
server.listen(PORT, () =>
  console.log(`Servidor rodando em http://localhost:${PORT}`)
);
