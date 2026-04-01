const fs = require('fs');
const path = require('path');

const CHANNELS_CONFIGS_FILE = path.join(__dirname, '..', 'channelsConfigs.json');

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

let channelConfigs = {};
let channelsToMonitor = [];
const channelState = new Map();

function cloneDefaultAllowedCommands() {
  return JSON.parse(JSON.stringify(defaultConfig.allowedCommands));
}

function loadConfigs() {
  try {
    channelConfigs = JSON.parse(fs.readFileSync(CHANNELS_CONFIGS_FILE));
    channelsToMonitor = Object.keys(channelConfigs);
  } catch {
    channelConfigs = {};
    channelsToMonitor = [];
  }
}

function saveConfigs() {
  try {
    fs.writeFileSync(CHANNELS_CONFIGS_FILE, JSON.stringify(channelConfigs, null, 2));
  } catch (err) {
    console.error('Erro ao salvar channel configs:', err);
  }
}

function getChannelsToMonitor() {
  return [...new Set(channelsToMonitor.map(c => c.toLowerCase()))];
}

function addChannelToMonitor(chan) {
  const key = (chan || '').toLowerCase();
  if (!key) return;
  if (!channelsToMonitor.includes(key)) {
    channelsToMonitor.push(key);
  }
}

function getChannelConfig(chan) {
  const key = (chan || '').toLowerCase();
  if (!channelConfigs[key]) {
    channelConfigs[key] = { allowedCommands: cloneDefaultAllowedCommands(), userId: null, login: key };
    saveConfigs();
  }
  const out = { ...channelConfigs[key] };
  out.allowedCommands = { ...defaultConfig.allowedCommands, ...out.allowedCommands };
  return out;
}

function saveChannelConfig(chan, newConfig) {
  const key = (chan || '').toLowerCase();
  if (!key || !newConfig || typeof newConfig !== 'object') return;

  channelConfigs[key] = {
    allowedCommands: newConfig.allowedCommands || cloneDefaultAllowedCommands(),
    userId: newConfig.userId || channelConfigs[key]?.userId || null,
    login: newConfig.login || channelConfigs[key]?.login || key
  };
  addChannelToMonitor(key);
  saveConfigs();
}

function initChannelState(chan) {
  if (!chan) return null;
  const key = chan.toLowerCase();
  if (!channelState.has(key)) {
    channelState.set(key, {
      clipQueue: [],
      isPlaying: false,
      lastClip: null,
      repeatUser: null,
      playedSo: [],
      playedUserClips: [],
      totalClipsPlayed: 0
    });
  }
  return channelState.get(key);
}

function getChannelState(chan) {
  if (!chan) return null;
  const key = chan.toLowerCase();
  return channelState.get(key) || initChannelState(key);
}

function getAllChannels() {
  return new Set([...Object.keys(channelConfigs), ...Array.from(channelState.keys())]);
}

function removeChannel(chan) {
  if (!chan) return;
  const key = chan.toLowerCase();
  delete channelConfigs[key];
  channelState.delete(key);
  channelsToMonitor = channelsToMonitor.filter(c => c !== key);
  saveConfigs();
}

function ensureChannelAuthorized(chan) {
  if (!chan) return null;
  const key = chan.toLowerCase();
  if (!channelConfigs[key]) {
    channelConfigs[key] = { allowedCommands: cloneDefaultAllowedCommands(), userId: null, login: key };
    saveConfigs();
  }
  initChannelState(key);
  addChannelToMonitor(key);
  return key;
}

module.exports = {
  loadConfigs,
  getChannelsToMonitor,
  addChannelToMonitor,
  getChannelConfig,
  saveChannelConfig,
  initChannelState,
  getChannelState,
  getAllChannels,
  cloneDefaultAllowedCommands,
  ensureChannelAuthorized,
  removeChannel,
  defaultConfig
};
