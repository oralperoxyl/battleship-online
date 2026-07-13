'use strict';
const SIZE = 10;
const CELLS = SIZE * SIZE;
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]; // классический русский флот, 20 клеток
const TOTAL_SHIP_CELLS = FLEET.reduce((a, b) => a + b, 0);

function neighbors8(idx) {
  const x = idx % SIZE, y = Math.floor(idx / SIZE), out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) out.push(ny * SIZE + nx);
  }
  return out;
}

// Валидация присланной расстановки: ровно верный набор кораблей, без соприкосновений (даже по диагонали)
function validatePlacement(cells) {
  if (!Array.isArray(cells)) return null;
  const set = new Set(cells.filter(n => Number.isInteger(n) && n >= 0 && n < CELLS));
  if (set.size !== TOTAL_SHIP_CELLS) return null;

  const visited = new Set();
  const ships = [];
  for (const start of set) {
    if (visited.has(start)) continue;
    const stack = [start], comp = [];
    visited.add(start);
    while (stack.length) {
      const c = stack.pop(); comp.push(c);
      const x = c % SIZE, y = Math.floor(c / SIZE);
      const orth = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of orth) {
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        const ni = ny * SIZE + nx;
        if (set.has(ni) && !visited.has(ni)) { visited.add(ni); stack.push(ni); }
      }
    }
    ships.push(comp);
  }
  for (const comp of ships) {
    const xs = comp.map(c => c % SIZE), ys = comp.map(c => Math.floor(c / SIZE));
    const sameRow = ys.every(y => y === ys[0]);
    const sameCol = xs.every(x => x === xs[0]);
    if (!sameRow && !sameCol) return null;
  }
  const sizes = ships.map(s => s.length).sort((a, b) => b - a);
  const expect = [...FLEET].sort((a, b) => b - a);
  if (sizes.length !== expect.length || sizes.some((s, i) => s !== expect[i])) return null;
  for (const c of set) for (const n of neighbors8(c)) if (set.has(n)) {
    const c1 = ships.findIndex(s => s.includes(c));
    const c2 = ships.findIndex(s => s.includes(n));
    if (c1 !== c2) return null;
  }
  return ships;
}

function autoPlacement() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const occupied = new Set();
    const ships = [];
    let ok = true;
    for (const len of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const horiz = Math.random() < 0.5;
        const x = Math.floor(Math.random() * (horiz ? SIZE - len + 1 : SIZE));
        const y = Math.floor(Math.random() * (horiz ? SIZE : SIZE - len + 1));
        const cells = [];
        for (let i = 0; i < len; i++) cells.push(horiz ? y * SIZE + x + i : (y + i) * SIZE + x);
        const clash = cells.some(c => occupied.has(c) || neighbors8(c).some(n => occupied.has(n)));
        if (clash) continue;
        cells.forEach(c => occupied.add(c));
        ships.push(cells);
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  return null; // крайне маловероятно
}

function emptyBoard() { return { ships: [], hits: new Array(CELLS).fill(false), shipCells: new Set() }; }
function buildBoard(ships) {
  const b = emptyBoard();
  b.ships = ships.map(cells => ({ cells, hits: new Set() }));
  ships.forEach(cells => cells.forEach(c => b.shipCells.add(c)));
  return b;
}

module.exports = { SIZE, CELLS, FLEET, TOTAL_SHIP_CELLS, neighbors8, validatePlacement, autoPlacement, buildBoard };
