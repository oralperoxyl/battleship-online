'use strict';
/* Автотест: быстрый матч, оба авто-расставляются, бот стреляет случайно по своим полям до победы.
 * Запуск: node test/e2e.js (сервер на :3200) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3200/ws';

let code = null;
const clients = [];
let finished = false;

function mk(nick) {
  const c = { nick, ws: new WebSocket(URL), id: null, st: null, shotSet: new Set() };
  c.send = o => c.ws.send(JSON.stringify(o));
  c.ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'joined') { c.id = m.id; code = m.code; }
    if (m.t === 'state') { c.st = m; act(c); }
    if (m.t === 'result') { console.log('RESULT:', m.winner, '|', m.msg); }
  });
  clients.push(c);
  return c;
}

function act(c) {
  if (finished) return;
  const st = c.st;
  if (st.phase === 'placement') {
    c.send({ t: 'place', auto: true });
  }
  if (st.phase === 'battle' && st.yourTurn) {
    let idx;
    do { idx = Math.floor(Math.random() * 100); } while (c.shotSet.has(idx));
    c.shotSet.add(idx);
    c.send({ t: 'shoot', idx });
  }
  if (st.phase === 'over' && !finished) {
    finished = true;
    console.log('PASS: game reached "over" phase, a winner was determined');
    process.exit(0);
  }
}

setTimeout(() => { console.log('FAIL: timeout — game did not finish'); process.exit(1); }, 30000);

const a = mk('Alice');
const b = mk('Bob');
a.ws.on('open', () => a.send({ t: 'quick', nick: 'Alice' }));
b.ws.on('open', () => setTimeout(() => b.send({ t: 'quick', nick: 'Bob' }), 300));
