const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function profilePath(app) {
  return path.join(app.getPath('userData'), 'local-profile.json');
}

function validProfile(profile) {
  return profile
    && profile.provider === 'local'
    && /^local_[0-9a-f-]{36}$/.test(profile.id)
    && /^space_[0-9a-f-]{36}$/.test(profile.spaceId)
    && typeof profile.name === 'string'
    && profile.name.length > 0;
}

function normalizeLocalProfileName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('This field is required.');
  if (name.length > 60) throw new Error('Your name must be 60 characters or fewer.');
  if (!/^[A-Za-z ]+$/.test(name)) throw new Error('English letters only.');
  return name;
}

async function readLocalProfile(app) {
  try {
    const profile = JSON.parse(await fs.readFile(profilePath(app), 'utf8'));
    return validProfile(profile) ? profile : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function createLocalProfile(app, name, randomUUID = crypto.randomUUID) {
  const profile = {
    provider: 'local',
    id: `local_${randomUUID()}`,
    spaceId: `space_${randomUUID()}`,
    name: normalizeLocalProfileName(name),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(profilePath(app), JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 });
  return profile;
}

module.exports = { createLocalProfile, normalizeLocalProfileName, readLocalProfile };
