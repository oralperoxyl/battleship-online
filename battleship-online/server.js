'use strict';
/* Морской бой 98 — сервер. Комната = машина состояний:
 * lobby(2 players) → placement → battle → over
 * Классический флот: 1x4, 2x3, 3x2, 4x1 (20 клеток). Попал — стреляешь ещё раз.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const { SIZE, CELLS, FLEET, TOTAL_SHIP_CELLS, neighbors8, validatePlacement, autoPlacement, buildBoard } = require('./lib');
const T_PLACE = (+process.env.T_PLACE || 90) * 1000;
const T_SHOT = (+process.env.T_SHOT || 45) * 1000;
const ROOM_TTL = 10 * 60 * 1000;

const rooms = new Map();
const queue = []; // ws waiting for quick match
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();
function genCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanText = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function send(p, obj) { if (p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(obj)); } catch (_) {} } }
function broadcast(room, obj) { room.players.forEach(p => send(p, obj)); }
function other(room, id) { return room.players.find(p => p.id !== id); }

function log(room, text) {
  const e = { text, ts: now() };
  room.log.push(e);
  if (room.log.length > 300) room.log.shift();
  broadcast(room, { t: 'log', e });
}

/* ---------------- board build (uses lib) ---------------- */

/* ---------------- room lifecycle ---------------- */
function makeRoom() {
  const room = {
    code: genCode(), players: [], phase: 'lobby', turn: null,
    boards: {}, placed: {}, deadline: 0, timer: null, killTimer: null,
    log: [], createdAt: now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, ws, nick) {
  const p = { id: uid(), token: uid(), nick, ws, online: true };
  room.players.push(p);
  ws._room = room; ws._pid = p.id;
  return p;
}

function stateFor(room, p) {
  const opp = other(room, p.id);
  const myBoard = room.boards[p.id];
  const oppBoard = opp ? room.boards[opp.id] : null;
  return {
    t: 'state', code: room.code, phase: room.phase,
    you: { id: p.id, nick: p.nick },
    opponent: opp ? { id: opp.id, nick: opp.nick, online: opp.online, placed: !!room.placed[opp.id] } : null,
    yourTurn: room.turn === p.id,
    deadline: room.deadline, serverNow: now(),
    myShips: myBoard ? myBoard.ships.map(s => s.cells) : null,
    myHitsTaken: myBoard ? [...myBoard.hits.keys ? [] : []] : null, // unused placeholder
    myBoardHits: myBoard ? myBoard.hits.map((v, i) => v ? i : -1).filter(i => i >= 0) : [],
    oppShotsAtMe: myBoard ? myBoard.hits.map((v, i) => v ? { i, hit: myBoard.shipCells.has(i) } : null).filter(Boolean) : [],
    myShotsAtOpp: oppBoard ? oppBoard.hits.map((v, i) => v ? { i, hit: oppBoard.shipCells.has(i) } : null).filter(Boolean) : [],
    sunkMine: myBoard ? myBoard.ships.filter(s => s.cells.every(c => s.hits.has(c))).map(s => s.cells) : [],
    sunkOpp: oppBoard ? oppBoard.ships.filter(s => s.cells.every(c => s.hits.has(c))).map(s => s.cells) : [],
  };
}
function syncAll(room) { room.players.forEach(p => send(p, stateFor(room, p))); }

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

function startPlacement(room) {
  room.phase = 'placement';
  room.placed = {};
  room.boards = {};
  room.deadline = now() + T_PLACE;
  clearTimer(room);
  room.timer = setTimeout(() => autoPlaceMissing(room), T_PLACE);
  log(room, `Бой начинается! Расставьте флот: ${FLEET.join(', ')} палуб(ы).`);
  syncAll(room);
}

function autoPlaceMissing(room) {
  if (room.phase !== 'placement') return;
  room.players.forEach(p => { if (!room.placed[p.id]) { room.boards[p.id] = buildBoard(autoPlacement()); room.placed[p.id] = true; } });
  maybeStartBattle(room);
}

function onPlace(room, p, msg) {
  if (room.phase !== 'placement' || room.placed[p.id]) return;
  let ships;
  if (msg.auto) ships = autoPlacement();
  else ships = validatePlacement(msg.cells);
  if (!ships) { send(p, { t: 'err', text: 'Некорректная расстановка кораблей.' }); return; }
  room.boards[p.id] = buildBoard(ships);
  room.placed[p.id] = true;
  log(room, `${p.nick} расставил флот.`);
  if (Object.keys(room.placed).length === room.players.length) maybeStartBattle(room);
  else syncAll(room);
}

function maybeStartBattle(room) {
  if (room.phase !== 'placement') return;
  if (Object.keys(room.placed).length < room.players.length) return;
  clearTimer(room);
  room.phase = 'battle';
  room.turn = room.players[Math.floor(Math.random() * room.players.length)].id;
  room.deadline = now() + T_SHOT;
  room.timer = setTimeout(() => passTurn(room, 'Время вышло — ход переходит сопернику.'), T_SHOT);
  const first = room.players.find(p => p.id === room.turn);
  log(room, `Оба флота на воде! Первым стреляет ${first.nick}.`);
  syncAll(room);
}

function passTurn(room, reason) {
  if (room.phase !== 'battle') return;
  clearTimer(room);
  const opp = other(room, room.turn);
  room.turn = opp ? opp.id : room.turn;
  room.deadline = now() + T_SHOT;
  room.timer = setTimeout(() => passTurn(room, 'Время вышло — ход переходит сопернику.'), T_SHOT);
  if (reason) log(room, reason);
  syncAll(room);
}

function onShoot(room, p, msg) {
  if (room.phase !== 'battle' || room.turn !== p.id) return;
  const idx = msg.idx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= CELLS) return;
  const opp = other(room, p.id);
  if (!opp) return;
  const board = room.boards[opp.id];
  if (board.hits[idx]) return; // уже стреляли сюда
  board.hits[idx] = true;
  const hit = board.shipCells.has(idx);
  if (hit) {
    const ship = board.ships.find(s => s.cells.includes(idx));
    ship.hits.add(idx);
    const sunk = ship.cells.every(c => ship.hits.has(c));
    if (sunk) {
      ship.cells.forEach(c => neighbors8(c).forEach(n => { if (!board.hits[n]) board.hits[n] = true; }));
    }
    log(room, sunk ? `${p.nick} топит корабль соперника! 💥` : `${p.nick} попадание!`);
    const allSunk = board.ships.every(s => s.cells.every(c => s.hits.has(c)));
    if (allSunk) { endGame(room, p.id, `${p.nick} потопил весь флот ${opp.nick} и побеждает!`); return; }
    clearTimer(room);
    room.deadline = now() + T_SHOT;
    room.timer = setTimeout(() => passTurn(room, 'Время вышло — ход переходит сопернику.'), T_SHOT);
    syncAll(room);
  } else {
    log(room, `${p.nick} — мимо.`);
    passTurn(room, null);
  }
}

function endGame(room, winnerId, msg) {
  clearTimer(room);
  room.phase = 'over';
  const winner = room.players.find(q => q.id === winnerId);
  broadcast(room, { t: 'result', winner: winner ? winner.nick : '?', msg });
  log(room, msg);
  syncAll(room);
}

/* ---------------- membership ---------------- */
function onCreate(ws, msg) {
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  const room = makeRoom();
  const p = addPlayer(room, ws, nick);
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id });
  log(room, `${nick} создал комнату ${room.code}. Ждём соперника…`);
  syncAll(room);
}

function onJoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  if (!room) { ws.send(JSON.stringify({ t: 'err', text: 'Комната не найдена.' })); return; }
  if (room.players.length >= 2) { ws.send(JSON.stringify({ t: 'err', text: 'Комната уже заполнена.' })); return; }
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  const p = addPlayer(room, ws, nick);
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id });
  log(room, `${nick} присоединился.`);
  if (room.killTimer) { clearTimeout(room.killTimer); room.killTimer = null; }
  if (room.players.length === 2) startPlacement(room);
  else syncAll(room);
}

function onQuick(ws, msg) {
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  if (queue.length > 0) {
    const waiting = queue.shift();
    if (waiting.ws.readyState !== 1) { onQuick(ws, msg); return; } // отвалился — пробуем следующего
    const room = makeRoom();
    addPlayer(room, waiting.ws, waiting.nick);
    const p2 = addPlayer(room, ws, nick);
    room.players.forEach(p => send(p, { t: 'joined', code: room.code, token: p.token, id: p.id }));
    log(room, `Быстрый матч: ${room.players[0].nick} vs ${room.players[1].nick}!`);
    startPlacement(room);
  } else {
    queue.push({ ws, nick });
    ws._queued = true;
    send({ ws }, { t: 'queued' });
  }
}

function onRejoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  const p = room && room.players.find(q => q.token === msg.token);
  if (!p) { ws.send(JSON.stringify({ t: 'err', text: 'Сессия не найдена.', fatal: true })); return; }
  p.ws = ws; p.online = true;
  ws._room = room; ws._pid = p.id;
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id });
  if (room.killTimer) { clearTimeout(room.killTimer); room.killTimer = null; }
  log(room, `${p.nick} снова в сети.`);
  syncAll(room);
}

function onDisconnect(ws) {
  const qi = queue.findIndex(q => q.ws === ws);
  if (qi >= 0) queue.splice(qi, 1);
  const room = ws._room;
  if (!room) return;
  const p = room.players.find(q => q.id === ws._pid);
  if (!p || p.ws !== ws) return;
  p.online = false;
  log(room, `${p.nick} отключился.`);
  if (!room.players.some(q => q.online)) {
    room.killTimer = setTimeout(() => { clearTimer(room); rooms.delete(room.code); }, ROOM_TTL);
  }
  syncAll(room);
}

/* ---------------- wiring ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    const room = ws._room;
    const p = room && room.players.find(q => q.id === ws._pid);
    switch (msg.t) {
      case 'create': if (!room) onCreate(ws, msg); break;
      case 'join':   if (!room) onJoin(ws, msg); break;
      case 'quick':  if (!room) onQuick(ws, msg); break;
      case 'rejoin': if (!room) onRejoin(ws, msg); break;
      case 'place':  if (p) onPlace(room, p, msg); break;
      case 'shoot':  if (p) onShoot(room, p, msg); break;
    }
  });
  ws.on('close', () => onDisconnect(ws));
});

server.listen(PORT, () => console.log(`Морской бой 98 online: http://localhost:${PORT}`));
