require('dotenv').config();
const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Trust the platform's reverse proxy (Render/Railway/etc.) so we get the real client IP
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const store = db.get();
const JWT_SECRET = store.jwtSecret;
const TOKEN_EXPIRY = '30d';

// ---------- Bootstrap the Owner account ----------
(function bootstrapOwner() {
  const ownerUsername = (process.env.OWNER_USERNAME || 'owner').trim();
  const ownerPassword = process.env.OWNER_PASSWORD || 'changeme123';
  const key = ownerUsername.toLowerCase();

  const existingOwner = Object.values(store.users).find(u => u.role === 'owner');
  if (!existingOwner) {
    store.users[key] = {
      username: ownerUsername,
      passwordHash: bcrypt.hashSync(ownerPassword, 10),
      role: 'owner',
      mustResetPassword: false,
      lastIp: null,
      style: defaultStyle(),
      city: null,
      createdAt: Date.now()
    };
    db.saveNow();
    console.log(`Owner account bana diya: "${ownerUsername}". Isi username/password se kisi bhi device se login karein.`);
    if (ownerPassword === 'changeme123') {
      console.warn('⚠️  Aap default owner password use kar rahe hain. .env file mein OWNER_PASSWORD zaroor badal dein.');
    }
  }
})();

// ---------- Helpers ----------
function usernameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function isValidUsername(name) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(name);
}

function defaultStyle() {
  return { nameColor: '#5b8cff', nameBold: true, msgColor: '#e8eaf0', msgBold: false };
}

function sanitizeStyle(style) {
  const hexColor = /^#[0-9a-fA-F]{6}$/;
  const s = style || {};
  const safe = defaultStyle();
  if (typeof s.nameColor === 'string' && hexColor.test(s.nameColor)) safe.nameColor = s.nameColor;
  if (typeof s.msgColor === 'string' && hexColor.test(s.msgColor)) safe.msgColor = s.msgColor;
  safe.nameBold = !!s.nameBold;
  safe.msgBold = !!s.msgBold;
  return safe;
}

function sanitizeCity(city) {
  return String(city || '').trim().slice(0, 60);
}

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || '';
}

function getSocketIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function isIpBanned(ip) {
  return !!store.bans.ips[ip];
}

function isFingerprintBanned(fp) {
  return !!(fp && store.bans.fingerprints[fp]);
}

function isDeviceBanned(deviceId) {
  return !!(deviceId && store.bans.deviceIds[deviceId]);
}

function isUsernameBanned(nameKey) {
  return !!store.bans.usernames[nameKey];
}

function getActiveKick(nameKey) {
  const k = store.kicks[nameKey];
  if (!k) return null;
  if (Date.now() >= k.until) {
    delete store.kicks[nameKey];
    db.save();
    return null;
  }
  return k;
}

function signToken(user) {
  return jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login zaroori hai.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const key = usernameKey(decoded.username);
    const user = store.users[key];
    if (!user) return res.status(401).json({ error: 'Account nahi mila.' });
    req.user = user;
    req.userKey = key;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expire ho gaya, dobara login karein.' });
  }
}

// ---------- REST: auth ----------
app.post('/api/register', (req, res) => {
  const { username, password, fingerprint, deviceId } = req.body || {};
  const ip = getClientIp(req);

  if (isIpBanned(ip) || isFingerprintBanned(fingerprint) || isDeviceBanned(deviceId)) {
    return res.status(403).json({ error: 'Aap ka device/network block hai.' });
  }
  if (!isValidUsername(username || '')) {
    return res.status(400).json({ error: 'Username 3-20 characters ka ho, sirf letters/numbers/underscore.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password kam az kam 6 characters ka hona chahiye.' });
  }

  const key = usernameKey(username);
  if (isUsernameBanned(key)) return res.status(403).json({ error: 'Ye username block hai.' });
  if (store.users[key]) return res.status(409).json({ error: 'Ye username pehle se registered hai.' });

  store.users[key] = {
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'member',
    mustResetPassword: false,
    lastIp: ip,
    lastFingerprint: fingerprint || null,
    lastDeviceId: deviceId || null,
    style: defaultStyle(),
    city: null,
    createdAt: Date.now()
  };
  db.saveNow();

  const token = signToken(store.users[key]);
  res.json({ token, username: store.users[key].username, role: store.users[key].role, mustResetPassword: false, style: store.users[key].style });
});

app.post('/api/login', (req, res) => {
  const { username, password, fingerprint, deviceId } = req.body || {};
  const ip = getClientIp(req);
  const key = usernameKey(username);
  const user = store.users[key];

  if (!user) return res.status(401).json({ error: 'Username ya password ghalat hai.' });
  if (isIpBanned(ip) || isFingerprintBanned(fingerprint) || isDeviceBanned(deviceId)) {
    return res.status(403).json({ error: 'Aap ka device/network block hai.' });
  }
  if (isUsernameBanned(key)) return res.status(403).json({ error: 'Ye account block hai.' });

  const kick = getActiveKick(key);
  if (kick) {
    const remainingMin = Math.ceil((kick.until - Date.now()) / 60000);
    return res.status(403).json({ error: `Aap kick hain. Dobara koshish karein ${remainingMin} minute baad.`, kickedUntil: kick.until });
  }

  if (!bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Username ya password ghalat hai.' });
  }

  user.lastIp = ip;
  if (fingerprint) user.lastFingerprint = fingerprint;
  if (deviceId) user.lastDeviceId = deviceId;
  db.save();

  const token = signToken(user);
  res.json({ token, username: user.username, role: user.role, mustResetPassword: !!user.mustResetPassword, style: user.style || defaultStyle() });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = req.user;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Naya password kam az kam 6 characters ka ho.' });
  }
  if (!user.mustResetPassword) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password ghalat hai.' });
    }
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  user.mustResetPassword = false;
  db.saveNow();
  res.json({ ok: true });
});

app.post('/api/update-style', authMiddleware, (req, res) => {
  const style = sanitizeStyle(req.body || {});
  req.user.style = style;
  db.saveNow();
  res.json({ ok: true, style });
});

// ---------- In-memory room state (who's chatting right now) ----------
// rooms[roomName] = { users: { socketId: {username, role, isGuest} }, history: [] }
const rooms = {};

// ---------- Global online-users registry (app-wide, independent of which room) ----------
// onlineUsers[usernameKey] = { username, role, isGuest, city, style, sockets: Set<socketId> }
const onlineUsers = {};

// ---------- Pending private-message requests (in-memory only, not persisted) ----------
// dmRequests["fromKey->toKey"] = { from, to, createdAt }
const dmRequests = {};

function getOnlineUsersList() {
  return Object.values(onlineUsers).map(u => ({
    username: u.username, role: u.role, isGuest: u.isGuest, city: u.city || null, style: u.style
  }));
}

function broadcastOnlineUsers() {
  io.emit('online_users_update', getOnlineUsersList());
}

function emitToUser(nameKey, event, payload) {
  const entry = onlineUsers[nameKey];
  if (!entry) return;
  entry.sockets.forEach(sid => {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit(event, payload);
  });
}

function convKey(userA, userB) {
  return [usernameKey(userA), usernameKey(userB)].sort().join('::');
}

function getOrCreateConversation(userA, userB) {
  const key = convKey(userA, userB);
  if (!store.dmConversations[key]) {
    store.dmConversations[key] = { participants: [userA, userB], messages: [], createdAt: Date.now() };
    db.saveNow();
  }
  return { key, conv: store.dmConversations[key] };
}

function clearPendingRequestsBetween(userA, userB) {
  const a = usernameKey(userA), b = usernameKey(userB);
  delete dmRequests[a + '->' + b];
  delete dmRequests[b + '->' + a];
}

function isParticipant(conv, nameKey) {
  return conv.participants.some(p => usernameKey(p) === nameKey);
}

function getMyDmConversationsList(myUsername) {
  const myKey = usernameKey(myUsername);
  const result = [];
  for (const [key, conv] of Object.entries(store.dmConversations)) {
    if (!isParticipant(conv, myKey)) continue;
    const other = conv.participants.find(p => usernameKey(p) !== myKey) || conv.participants[0];
    const last = conv.messages[conv.messages.length - 1] || null;
    result.push({
      convKey: key,
      withUsername: other,
      lastMessage: last ? last.text : '',
      lastTime: last ? last.time : conv.createdAt
    });
  }
  result.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  return result;
}

function getRoomUserList(roomName) {
  if (!rooms[roomName]) return [];
  return Object.values(rooms[roomName].users).map(u => ({ username: u.username, role: u.role, isGuest: u.isGuest, style: u.style }));
}

function findSocketsByUsername(roomName, nameKey) {
  const room = rooms[roomName];
  if (!room) return [];
  return Object.entries(room.users)
    .filter(([, u]) => usernameKey(u.username) === nameKey)
    .map(([sid]) => sid);
}

function findAnySocketByUsername(nameKey) {
  // search across all rooms
  for (const roomName of Object.keys(rooms)) {
    const sids = findSocketsByUsername(roomName, nameKey);
    if (sids.length) return { roomName, sids };
  }
  return null;
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;
  let currentRole = 'guest';

  socket.on('join_room', ({ room, username, token, isGuest, fingerprint, deviceId, style }) => {
    room = (room || 'general').trim().slice(0, 40) || 'general';
    const ip = getSocketIp(socket);

    if (isIpBanned(ip) || isFingerprintBanned(fingerprint) || isDeviceBanned(deviceId)) {
      socket.emit('join_error', { reason: 'device_banned', message: 'Aap ka device/network is chat se block hai.' });
      return;
    }

    socket.data.fingerprint = fingerprint || null;
    socket.data.deviceId = deviceId || null;

    let resolvedUsername = null;
    let role = 'guest';
    let guest = true;
    let resolvedStyle = sanitizeStyle(style);

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const key = usernameKey(decoded.username);
        const user = store.users[key];
        if (!user) {
          socket.emit('join_error', { reason: 'invalid_session', message: 'Session invalid hai, dobara login karein.' });
          return;
        }
        resolvedUsername = user.username;
        role = user.role;
        guest = false;
        user.lastIp = ip;
        if (fingerprint) user.lastFingerprint = fingerprint;
        if (deviceId) user.lastDeviceId = deviceId;
        resolvedStyle = user.style || sanitizeStyle(style);
        db.save();
      } catch (e) {
        socket.emit('join_error', { reason: 'invalid_session', message: 'Session expire ho gaya, dobara login karein.' });
        return;
      }
    } else {
      const name = (username || '').trim().slice(0, 24);
      if (!name) {
        socket.emit('join_error', { reason: 'bad_username', message: 'Naam likhna zaroori hai.' });
        return;
      }
      const key = usernameKey(name);
      if (store.users[key]) {
        socket.emit('join_error', { reason: 'name_taken', message: 'Ye naam registered hai, login karein ya doosra guest naam chunein.' });
        return;
      }
      resolvedUsername = name;
      role = 'guest';
      guest = true;
    }

    const nameKey = usernameKey(resolvedUsername);

    if (isUsernameBanned(nameKey)) {
      socket.emit('join_error', { reason: 'banned', message: 'Ye account/naam block hai. Sirf owner unban kar sakta hai.' });
      return;
    }

    const kick = getActiveKick(nameKey);
    if (kick) {
      const remainingMs = kick.until - Date.now();
      socket.emit('join_error', {
        reason: 'kicked',
        message: `Aap kick hain.`,
        remainingMs
      });
      return;
    }

    // Leave previous room if any
    if (currentRoom) {
      socket.leave(currentRoom);
      if (rooms[currentRoom]) {
        delete rooms[currentRoom].users[socket.id];
        io.to(currentRoom).emit('system_message', `${currentUsername} chala gaya (left).`);
        io.to(currentRoom).emit('user_list', getRoomUserList(currentRoom));
      }
    }

    currentRoom = room;
    currentUsername = resolvedUsername;
    currentRole = role;

    if (!rooms[room]) {
      rooms[room] = { users: {}, history: [] };
    }
    rooms[room].users[socket.id] = { username: resolvedUsername, role, isGuest: guest, style: resolvedStyle };
    socket.join(room);

    // Register in the global online-users list (independent of which room), used for the private-message sidebar
    const existingOnline = onlineUsers[nameKey];
    const existingCity = existingOnline ? existingOnline.city : (store.users[nameKey] ? store.users[nameKey].city : null);
    if (!existingOnline) {
      onlineUsers[nameKey] = { username: resolvedUsername, role, isGuest: guest, city: existingCity, style: resolvedStyle, sockets: new Set() };
    } else {
      existingOnline.role = role;
      existingOnline.style = resolvedStyle;
    }
    onlineUsers[nameKey].sockets.add(socket.id);
    socket.data.usernameKey = nameKey;
    broadcastOnlineUsers();

    // Deliver any DM requests that arrived while this user was offline
    Object.values(dmRequests).forEach(r => {
      if (usernameKey(r.to) === nameKey) {
        socket.emit('dm_request_received', { from: r.from });
      }
    });

    socket.emit('history', rooms[room].history);
    socket.emit('joined', { room, username: resolvedUsername, role, isGuest: guest, style: resolvedStyle });

    io.to(room).emit('system_message', `${resolvedUsername} shamil ho gaya (joined).`);
    io.to(room).emit('user_list', getRoomUserList(room));
  });

  socket.on('chat_message', (text) => {
    if (!currentRoom || !currentUsername) return;
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;

    const roomUser = rooms[currentRoom]?.users[socket.id];
    const msg = {
      username: currentUsername,
      role: currentRole,
      text,
      style: (roomUser && roomUser.style) || defaultStyle(),
      time: new Date().toISOString()
    };

    rooms[currentRoom].history.push(msg);
    if (rooms[currentRoom].history.length > 100) {
      rooms[currentRoom].history.shift();
    }

    io.to(currentRoom).emit('chat_message', msg);
  });

  socket.on('update_style', (style) => {
    if (!currentRoom || !currentUsername) return;
    const safe = sanitizeStyle(style);
    const roomUser = rooms[currentRoom]?.users[socket.id];
    if (roomUser) roomUser.style = safe;

    const key = usernameKey(currentUsername);
    if (onlineUsers[key]) onlineUsers[key].style = safe;

    // Persist for registered users so it carries over to future logins/devices
    const user = store.users[key];
    if (user) {
      user.style = safe;
      db.saveNow();
    }

    socket.emit('style_saved', safe);
    io.to(currentRoom).emit('user_list', getRoomUserList(currentRoom));
    broadcastOnlineUsers();
  });

  socket.on('typing', () => {
    if (currentRoom && currentUsername) {
      socket.to(currentRoom).emit('typing', currentUsername);
    }
  });

  // --- Owner: promote / demote admin (registered users only) ---
  socket.on('make_admin', ({ targetUsername }) => {
    if (currentRole !== 'owner') return;
    const key = usernameKey(targetUsername);
    const user = store.users[key];
    if (!user) {
      socket.emit('action_error', { message: 'Sirf registered users ko admin banaya ja sakta hai (guest nahi).' });
      return;
    }
    if (user.role === 'owner') return;
    user.role = 'admin';
    db.saveNow();
    refreshRoleEverywhere(key);
    if (currentRoom) io.to(currentRoom).emit('system_message', `${user.username} ab admin hai.`);
  });

  socket.on('remove_admin', ({ targetUsername }) => {
    if (currentRole !== 'owner') return;
    const key = usernameKey(targetUsername);
    const user = store.users[key];
    if (!user || user.role !== 'admin') return;
    user.role = 'member';
    db.saveNow();
    refreshRoleEverywhere(key);
    if (currentRoom) io.to(currentRoom).emit('system_message', `${user.username} ab admin nahi raha.`);
  });

  // --- Owner or Admin: timed kick ---
  socket.on('kick_user', ({ targetUsername, minutes }) => {
    if (currentRole !== 'owner' && currentRole !== 'admin') return;
    const key = usernameKey(targetUsername);
    if (key === usernameKey(currentUsername)) return;

    const targetRecord = store.users[key];
    if (targetRecord && targetRecord.role === 'owner') return; // owner can never be kicked
    if (targetRecord && targetRecord.role === 'admin' && currentRole !== 'owner') return; // only owner kicks admins

    const mins = Math.min(Math.max(parseInt(minutes, 10) || 5, 1), 10080); // 1 min to 7 days
    store.kicks[key] = { until: Date.now() + mins * 60000, by: currentUsername };
    db.saveNow();

    const found = findAnySocketByUsername(key);
    if (found) {
      found.sids.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('kicked', { minutes: mins, by: currentUsername });
          s.leave(found.roomName);
        }
        delete rooms[found.roomName].users[sid];
      });
      io.to(found.roomName).emit('system_message', `${targetUsername} ko ${mins} minute ke liye kick kar diya gaya (by ${currentUsername}).`);
      io.to(found.roomName).emit('user_list', getRoomUserList(found.roomName));
    }
  });

  // --- Owner only: permanent ban (by username + last known IP + device fingerprint) ---
  socket.on('ban_user', ({ targetUsername, reason }) => {
    if (currentRole !== 'owner') return;
    const key = usernameKey(targetUsername);
    if (key === usernameKey(currentUsername)) return;

    const targetRecord = store.users[key];
    if (targetRecord && targetRecord.role === 'owner') return;

    store.bans.usernames[key] = { reason: reason || '', bannedBy: currentUsername, bannedAt: Date.now() };

    // Capture IP + device fingerprint from their active connection, or fall back to last known values
    let ip = null, fingerprint = null, deviceId = null;
    const found = findAnySocketByUsername(key);
    if (found) {
      found.sids.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          ip = getSocketIp(s);
          fingerprint = s.data.fingerprint || null;
          deviceId = s.data.deviceId || null;
          s.emit('kicked', { banned: true, by: currentUsername });
          s.leave(found.roomName);
        }
        delete rooms[found.roomName].users[sid];
      });
      io.to(found.roomName).emit('system_message', `${targetUsername} ko permanently block kar diya gaya (by ${currentUsername}).`);
      io.to(found.roomName).emit('user_list', getRoomUserList(found.roomName));
    }
    if (targetRecord) {
      if (!ip) ip = targetRecord.lastIp;
      if (!fingerprint) fingerprint = targetRecord.lastFingerprint;
      if (!deviceId) deviceId = targetRecord.lastDeviceId;
    }
    if (ip) store.bans.ips[ip] = { reason: reason || '', bannedBy: currentUsername, bannedAt: Date.now(), relatedUsername: targetUsername };
    if (fingerprint) store.bans.fingerprints[fingerprint] = { reason: reason || '', bannedBy: currentUsername, bannedAt: Date.now(), relatedUsername: targetUsername };
    if (deviceId) store.bans.deviceIds[deviceId] = { reason: reason || '', bannedBy: currentUsername, bannedAt: Date.now(), relatedUsername: targetUsername };
    db.saveNow();
    socket.emit('ban_list', getBanList());
  });

  socket.on('unban_user', ({ targetUsername }) => {
    if (currentRole !== 'owner') return;
    const key = usernameKey(targetUsername);
    delete store.bans.usernames[key];
    // also remove any IP/fingerprint/device bans linked to this username
    for (const ip of Object.keys(store.bans.ips)) {
      if (store.bans.ips[ip].relatedUsername && usernameKey(store.bans.ips[ip].relatedUsername) === key) delete store.bans.ips[ip];
    }
    for (const fp of Object.keys(store.bans.fingerprints)) {
      if (store.bans.fingerprints[fp].relatedUsername && usernameKey(store.bans.fingerprints[fp].relatedUsername) === key) delete store.bans.fingerprints[fp];
    }
    for (const did of Object.keys(store.bans.deviceIds)) {
      if (store.bans.deviceIds[did].relatedUsername && usernameKey(store.bans.deviceIds[did].relatedUsername) === key) delete store.bans.deviceIds[did];
    }
    db.saveNow();
    socket.emit('ban_list', getBanList());
  });

  socket.on('unban_ip', ({ ip }) => {
    if (currentRole !== 'owner') return;
    delete store.bans.ips[ip];
    db.saveNow();
    socket.emit('ban_list', getBanList());
  });

  socket.on('unban_fingerprint', ({ fingerprint }) => {
    if (currentRole !== 'owner') return;
    delete store.bans.fingerprints[fingerprint];
    db.saveNow();
    socket.emit('ban_list', getBanList());
  });

  socket.on('unban_device', ({ deviceId }) => {
    if (currentRole !== 'owner') return;
    delete store.bans.deviceIds[deviceId];
    db.saveNow();
    socket.emit('ban_list', getBanList());
  });

  socket.on('get_bans', () => {
    if (currentRole !== 'owner') return;
    socket.emit('ban_list', getBanList());
  });

  // --- Owner only: reset a user's password ---
  socket.on('reset_password', ({ targetUsername }) => {
    if (currentRole !== 'owner') return;
    const key = usernameKey(targetUsername);
    const user = store.users[key];
    if (!user) {
      socket.emit('action_error', { message: 'Ye guest hai, registered account nahi — password reset nahi ho sakta.' });
      return;
    }
    const tempPassword = Math.random().toString(36).slice(-8);
    user.passwordHash = bcrypt.hashSync(tempPassword, 10);
    user.mustResetPassword = true;
    db.saveNow();
    socket.emit('password_reset_result', { targetUsername: user.username, tempPassword });
  });

  // --- Profile: set your own city (shown to others in your profile card) ---
  socket.on('set_profile', ({ city }) => {
    if (!currentUsername) return;
    const cleanCity = sanitizeCity(city);
    const key = usernameKey(currentUsername);
    if (onlineUsers[key]) onlineUsers[key].city = cleanCity;
    const user = store.users[key];
    if (user) {
      user.city = cleanCity;
      db.saveNow();
    }
    broadcastOnlineUsers();
  });

  // --- Private messaging: requests ---
  socket.on('send_dm_request', ({ toUsername }) => {
    if (!currentUsername) return;
    const toKey = usernameKey(toUsername);
    const myKey = usernameKey(currentUsername);
    if (toKey === myKey) return;
    if (!onlineUsers[toKey]) {
      socket.emit('action_error', { message: 'Ye user is waqt online nahi hai.' });
      return;
    }

    if (currentRole === 'owner') {
      // Owner bypass: no request needed, conversation opens immediately
      clearPendingRequestsBetween(currentUsername, toUsername);
      const { key, conv } = getOrCreateConversation(currentUsername, toUsername);
      emitToUser(myKey, 'dm_conversation_opened', { convKey: key, withUsername: toUsername });
      emitToUser(toKey, 'dm_conversation_opened', { convKey: key, withUsername: currentUsername, byOwner: true });
      return;
    }

    const reqKey = myKey + '->' + toKey;
    dmRequests[reqKey] = { from: currentUsername, to: toUsername, createdAt: Date.now() };
    emitToUser(toKey, 'dm_request_received', { from: currentUsername });
    socket.emit('dm_request_sent', { to: toUsername });
  });

  socket.on('accept_dm_request', ({ fromUsername }) => {
    if (!currentUsername) return;
    const fromKey = usernameKey(fromUsername);
    const myKey = usernameKey(currentUsername);
    const reqKey = fromKey + '->' + myKey;
    if (!dmRequests[reqKey]) {
      socket.emit('action_error', { message: 'Ye request ab available nahi hai.' });
      return;
    }
    delete dmRequests[reqKey];
    const { key } = getOrCreateConversation(fromUsername, currentUsername);
    emitToUser(myKey, 'dm_conversation_opened', { convKey: key, withUsername: fromUsername });
    emitToUser(fromKey, 'dm_conversation_opened', { convKey: key, withUsername: currentUsername, accepted: true });
  });

  socket.on('decline_dm_request', ({ fromUsername }) => {
    if (!currentUsername) return;
    const fromKey = usernameKey(fromUsername);
    const myKey = usernameKey(currentUsername);
    delete dmRequests[fromKey + '->' + myKey];
    emitToUser(fromKey, 'dm_request_declined', { by: currentUsername });
  });

  // --- Private messaging: conversation ---
  socket.on('send_dm_message', ({ toUsername, text }) => {
    if (!currentUsername) return;
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;

    const key = convKey(currentUsername, toUsername);
    let conv = store.dmConversations[key];

    if (!conv) {
      if (currentRole === 'owner') {
        conv = getOrCreateConversation(currentUsername, toUsername).conv;
        clearPendingRequestsBetween(currentUsername, toUsername);
      } else {
        socket.emit('action_error', { message: 'Pehle private message request accept honi zaroori hai.' });
        return;
      }
    }

    const myKey = usernameKey(currentUsername);
    const style = (onlineUsers[myKey] && onlineUsers[myKey].style) || defaultStyle();
    const msg = { from: currentUsername, text, style, time: new Date().toISOString() };

    conv.messages.push(msg);
    if (conv.messages.length > 300) conv.messages.shift();
    db.saveNow();

    const payload = { convKey: key, msg };
    emitToUser(usernameKey(currentUsername), 'dm_message', payload);
    emitToUser(usernameKey(toUsername), 'dm_message', payload);
  });

  socket.on('get_my_dm_conversations', () => {
    if (!currentUsername) return;
    socket.emit('my_dm_conversations', getMyDmConversationsList(currentUsername));
  });

  socket.on('get_dm_thread', ({ withUsername }) => {
    if (!currentUsername) return;
    const key = convKey(currentUsername, withUsername);
    const conv = store.dmConversations[key];
    if (!conv) {
      socket.emit('dm_thread', { convKey: key, withUsername, messages: [] });
      return;
    }
    if (!isParticipant(conv, usernameKey(currentUsername)) && currentRole !== 'owner') return;
    socket.emit('dm_thread', { convKey: key, withUsername, messages: conv.messages });
  });

  // --- Owner only: view ALL private conversations (oversight) ---
  socket.on('owner_list_dm_conversations', () => {
    if (currentRole !== 'owner') return;
    const list = Object.entries(store.dmConversations).map(([key, conv]) => {
      const last = conv.messages[conv.messages.length - 1] || null;
      return {
        convKey: key,
        participants: conv.participants,
        messageCount: conv.messages.length,
        lastTime: last ? last.time : conv.createdAt
      };
    });
    list.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    socket.emit('owner_dm_conversations_list', list);
  });

  socket.on('owner_get_dm_thread', ({ convKey: key }) => {
    if (currentRole !== 'owner') return;
    const conv = store.dmConversations[key];
    if (!conv) return;
    socket.emit('owner_dm_thread', { convKey: key, participants: conv.participants, messages: conv.messages });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].users[socket.id];
      io.to(currentRoom).emit('system_message', `${currentUsername} chala gaya (left).`);
      io.to(currentRoom).emit('user_list', getRoomUserList(currentRoom));
    }

    const key = socket.data.usernameKey;
    if (key && onlineUsers[key]) {
      onlineUsers[key].sockets.delete(socket.id);
      if (onlineUsers[key].sockets.size === 0) {
        delete onlineUsers[key];
      }
      broadcastOnlineUsers();
    }
  });

  function refreshRoleEverywhere(nameKey) {
    const found = findAnySocketByUsername(nameKey);
    if (!found) return;
    const user = store.users[nameKey];
    found.sids.forEach(sid => {
      rooms[found.roomName].users[sid].role = user.role;
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('role_updated', { role: user.role });
    });
    io.to(found.roomName).emit('user_list', getRoomUserList(found.roomName));
  }
});

function getBanList() {
  return {
    usernames: Object.entries(store.bans.usernames).map(([key, v]) => ({ username: key, ...v })),
    ips: Object.entries(store.bans.ips).map(([ip, v]) => ({ ip, ...v })),
    fingerprints: Object.entries(store.bans.fingerprints).map(([fingerprint, v]) => ({ fingerprint, ...v })),
    deviceIds: Object.entries(store.bans.deviceIds).map(([deviceId, v]) => ({ deviceId, ...v }))
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server chal raha hai: http://localhost:${PORT}`);
});
