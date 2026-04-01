const tmi = require('tmi.js');
const { isUserAllowed, normalizeClipUrl } = require('./utils');
const { getClipInfo, getUserData, getAllUserClips } = require('./twitchApi');

const MAX_HISTORY = 100;

function createBot({ BOT_USERNAME, BOT_OAUTH, channelsToMonitor, getChannelConfig, getPlayerState, initChannelState, queueClip, queueUserClip, client }) {
  const clientTmi = new tmi.Client({
    options:{debug:false,messagesLogLevel:'info'},
    connection:{reconnect:true,secure:true,timeout:9000},
    identity:{ username: BOT_USERNAME, password: BOT_OAUTH },
    channels: channelsToMonitor
  });

  clientTmi.on('connected', (addr, port) => console.log(`✅ Bot conectado ao Twitch IRC (${addr}:${port})`));
  clientTmi.on('disconnected', reason => console.warn('⚠️ Bot desconectado:', reason));
  clientTmi.on('reconnect', () => console.log('🔄 Reconectando ao Twitch IRC...'));

  clientTmi.on('message', async (channelFull, tags, message, self) => {
    if (self) return;
    const chan = channelFull.replace('#','').toLowerCase();
    const cfg = getChannelConfig(chan);
    const state = getPlayerState(chan);
    initChannelState(chan);

    if (/^!watch(\s|$)/i.test(message)) {
      if (!cfg.allowedCommands.watch.enabled || !isUserAllowed(tags,cfg.allowedCommands.watch.roles)) return;
      let id = (message.split(' ')[1]||'').trim(); if(!id)return;
      try{const u=new URL(id); if(u.hostname.includes('clips.twitch.tv'))id=u.pathname.slice(1); else if(u.hostname.includes('twitch.tv')&&u.pathname.includes('/clip/')) id=u.pathname.split('/clip/')[1];}catch(_){ }
      const info = await getClipInfo(id); if(!info){console.warn(`[${chan}] !watch clipe não encontrado ${id}`); return;}
      const clip={id:info.id,duration:info.duration||15,url:info.url,thumbnail:info.thumbnail_url||null,video:normalizeClipUrl(info.thumbnail_url)};
      state.clipQueue=[]; state.repeatUser=null; queueClip(chan,clip); return;
    }

    if (/^!replay$/i.test(message)) {
      if (!cfg.allowedCommands.replay.enabled || !isUserAllowed(tags,cfg.allowedCommands.replay.roles)) return;
      if (!state.lastClip) return;
      state.clipQueue=[]; state.repeatUser=null; queueClip(chan, state.lastClip); return;
    }

    const rep = message.match(/^!repeat\s+@?(\w+)/i);
    if (rep) {
      if (!cfg.allowedCommands.repeat.enabled || !isUserAllowed(tags,cfg.allowedCommands.repeat.roles)) return;
      const user = rep[1].toLowerCase(); if (!/^[a-z0-9_]{3,25}$/.test(user)) return;
      state.repeatUser=user;
      console.log(`🔁 [${chan}] repeat ativado para ${user}`);
      await queueUserClip(chan,user).catch(err=>console.error(`❌ [${chan}] repeat erro`,err));
      return;
    }

    if (/^!stoprepeat$/i.test(message)) { if (!cfg.allowedCommands.repeat.enabled||!isUserAllowed(tags,cfg.allowedCommands.repeat.roles)) return; state.repeatUser=null; return; }
    if (/^!stop$/i.test(message)) { if (!cfg.allowedCommands.stop.enabled||!isUserAllowed(tags,cfg.allowedCommands.stop.roles)) return; state.clipQueue=[]; state.repeatUser=null; state.isPlaying=false; client.emit('fecharOverlay',chan); return; }

    const soMatch = message.match(/^!so\s+@?(\w+)/i);
    if (soMatch) {
      if (!cfg.allowedCommands.so.enabled || !isUserAllowed(tags,cfg.allowedCommands.so.roles)) return;
      const target = soMatch[1].toLowerCase(); if(!/^[a-z0-9_]{3,25}$/.test(target)) return;
      queueUserClip(chan,target).catch(err=>console.error(`❌ [${chan}] so erro`,err));
      return;
    }

    if (/^!clip/i.test(message)) {
      if (!cfg.allowedCommands.clip.enabled || !isUserAllowed(tags,cfg.allowedCommands.clip.roles)) return;
      try {
        const ud = await getUserData(chan);
        if (!ud) return;
        const created = await createClip(ud.id, cfg.userAccessToken);
        if (created) clientTmi.say(channelFull, `Clipe criado: https://clips.twitch.tv/${created}`);
      } catch (err) { console.error(err); }
      return;
    }
  });

  return clientTmi;
}

module.exports = { createBot };
