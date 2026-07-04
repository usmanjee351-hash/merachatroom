const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.json');
const BACKUP_PATH = path.join(__dirname, 'data.backup.json');
const TMP_PATH = path.join(__dirname, 'data.json.tmp');

function defaultData() {
  return {
    jwtSecret: crypto.randomBytes(32).toString('hex'),
    // users keyed by lowercase username
    // { username (original case), passwordHash, role: 'owner'|'admin'|'member', mustResetPassword,
    //   lastIp, lastFingerprint, lastDeviceId, style: {nameColor,nameBold,msgColor,msgBold}, createdAt }
    users: {},
    bans: {
      usernames: {}, // lowercaseUsername -> { reason, bannedBy, bannedAt }
      ips: {},        // ip -> { reason, bannedBy, bannedAt, relatedUsername }
      fingerprints: {}, // canvas/device fingerprint hash -> { reason, bannedBy, bannedAt, relatedUsername }
      deviceIds: {}     // browser-local persistent id -> { reason, bannedBy, bannedAt, relatedUsername }
    },
    kicks: {}, // lowercaseUsername -> { until: timestampMs, by }
    // dmConversations keyed by sorted "userkeyA::userkeyB"
    // { participants: [usernameA, usernameB], messages: [{from, text, time}], createdAt }
    dmConversations: {}
  };
}

function tryParse(raw) {
  const parsed = JSON.parse(raw);
  const fresh = defaultData();
  return { ...fresh, ...parsed, bans: { ...fresh.bans, ...(parsed.bans || {}) } };
}

function load() {
  // 1. Try the main file
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      if (raw.trim().length > 0) return tryParse(raw);
    } catch (e) {
      console.error('⚠️  data.json parhne mein masla:', e.message);
    }
  }

  // 2. Main file missing/corrupt — try the backup before giving up
  if (fs.existsSync(BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(BACKUP_PATH, 'utf8');
      if (raw.trim().length > 0) {
        console.warn('⚠️  Backup file se data recover kar liya (data.backup.json).');
        const recovered = tryParse(raw);
        writeFileAtomic(DB_PATH, recovered);
        return recovered;
      }
    } catch (e) {
      console.error('⚠️  Backup bhi parh nahi saka:', e.message);
    }
  }

  // 3. Nothing usable found — only now create a fresh database
  console.log('Naya data.json bana rahe hain (pehli baar chalane par ye normal hai).');
  const data = defaultData();
  writeFileAtomic(DB_PATH, data);
  return data;
}

function writeFileAtomic(targetPath, obj) {
  const json = JSON.stringify(obj, null, 2);
  fs.writeFileSync(TMP_PATH, json);
  fs.renameSync(TMP_PATH, targetPath); // atomic on the same filesystem — no half-written file risk
}

let data = load();

function saveNow() {
  try {
    // Keep a rolling backup of the last known-good state before overwriting
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, BACKUP_PATH);
    }
    writeFileAtomic(DB_PATH, data);
  } catch (e) {
    console.error('❌ data.json save karne mein masla (data memory mein mehfooz hai):', e.message);
  }
}

// All saves are immediate & synchronous — for a personal chat app this is cheap,
// and it guarantees a registration/login/ban is never lost to a crash before a debounce timer fires.
module.exports = {
  get: () => data,
  save: saveNow,
  saveNow
};
