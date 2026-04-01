function isUserAllowed(tags, roles) {
  const hierarchy = { viewer:1, vip:2, moderator:3, broadcaster:4 };
  let rank = hierarchy.viewer;
  if (tags.badges?.broadcaster) rank = hierarchy.broadcaster;
  else if (tags.mod) rank = hierarchy.moderator;
  else if (tags.badges?.vip) rank = hierarchy.vip;
  if (roles.includes('subscriber') && tags.subscriber) return true;
  return roles.some(r => hierarchy[r] && rank >= hierarchy[r]);
}

function normalizeClipUrl(thumbnail) {
  if (!thumbnail) return null;
  const candidate = thumbnail.replace(/preview.*\.(jpg|png)$/,'preview.mp4').replace(/-preview.*\.(jpg|png)$/,'.mp4');
  return candidate.endsWith('.mp4') ? candidate : null;
}

module.exports = { isUserAllowed, normalizeClipUrl };