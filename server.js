'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ------------------------------------------------------------------ config
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  lives: parseInt(process.env.LIVES, 10) || 3, // configurable: LIVES=4 npm start
  cols: 13,
  rows: 11,
  softChance: process.env.SOFT_CHANCE !== undefined
    ? parseFloat(process.env.SOFT_CHANCE) : 0.7, // chance a free tile spawns a breakable block
  powerupChance: 0.3,       // chance a destroyed soft block drops a power-up
  bombFuseMs: 3000,
  flameMs: 550,
  invulnMs: 2000,           // grace period after respawn
  baseSpeed: 3.4,           // tiles / second
  speedStep: 0.65,          // per speed power-up
  maxSpeedLevel: 3,         // speed cap = base + 3 * step ≈ 5.35 tiles/s
  startRadius: 1,
  maxRadius: 5,
  startBombs: 1,
  maxBombs: 3,
  slideSpeed: 8,            // kicked bomb speed, tiles / second
  playerRadius: 0.35,       // collision circle, in tile units
  tickHz: 60,
  sendHz: 20,
  maxPlayers: 4,
};

const SPAWNS = [
  { x: 0, y: 0 }, { x: 12, y: 10 }, { x: 12, y: 0 }, { x: 0, y: 10 },
];
const COLORS = ['#4da3ff', '#ff5d5d', '#5ddb6e', '#ffd24d'];
const POWERUP_TYPES = ['radius', 'bombs', 'speed', 'kick'];

// ------------------------------------------------------------------ state
// grid cells: 0 = floor, 1 = solid (indestructible), 2 = soft (breakable)
const game = {
  phase: 'lobby',           // lobby | playing | over
  grid: [],
  players: new Map(),       // id -> player
  bombs: [],
  flames: new Map(),        // "x,y" -> { x, y, until, kind }
  powerups: [],             // { x, y, type }
  winner: null,
  nextBombId: 1,
};
let nextPlayerId = 1;

function makeGrid() {
  const g = [];
  for (let y = 0; y < CONFIG.rows; y++) {
    const row = [];
    for (let x = 0; x < CONFIG.cols; x++) {
      if (x % 2 === 1 && y % 2 === 1) row.push(1);       // pillar pattern
      else row.push(Math.random() < CONFIG.softChance ? 2 : 0);
    }
    g.push(row);
  }
  // clear the spawn corners plus their two neighbours so players can move
  for (const s of SPAWNS) {
    const dx = s.x === 0 ? 1 : -1;
    const dy = s.y === 0 ? 1 : -1;
    g[s.y][s.x] = 0;
    g[s.y][s.x + dx] = 0;
    g[s.y + dy][s.x] = 0;
  }
  return g;
}

function tileAt(x, y) {
  if (x < 0 || y < 0 || x >= CONFIG.cols || y >= CONFIG.rows) return 1;
  return game.grid[y][x];
}

function bombAt(tx, ty) {
  return game.bombs.find(b => b.tx === tx && b.ty === ty) || null;
}

function playerOnTile(tx, ty, exceptId) {
  for (const p of game.players.values()) {
    if (p.spectator || p.lives <= 0 || p.id === exceptId) continue;
    if (Math.round(p.x - 0.5) === tx && Math.round(p.y - 0.5) === ty) return p;
  }
  return null;
}

// ------------------------------------------------------------------ players
function resetPlayerForRound(p, idx) {
  const s = SPAWNS[idx % SPAWNS.length];
  p.spawnIdx = idx % SPAWNS.length;
  p.x = s.x + 0.5;
  p.y = s.y + 0.5;
  p.lives = CONFIG.lives;
  p.radius = CONFIG.startRadius;
  p.maxBombs = CONFIG.startBombs;
  p.speedLevel = 0;
  p.kick = false;
  p.activeBombs = 0;
  p.invulnUntil = Date.now() + CONFIG.invulnMs;
  p.ghostBombs = new Set();  // bombs the player may still walk off of
  p.input = { up: false, down: false, left: false, right: false };
  p.facing = 'down';
  p.spectator = false;
}

function startRound() {
  game.grid = makeGrid();
  game.bombs = [];
  game.flames.clear();
  game.powerups = [];
  game.winner = null;
  game.nextBombId = 1;
  let idx = 0;
  for (const p of game.players.values()) resetPlayerForRound(p, idx++);
  game.phase = 'playing';
}

function respawn(p) {
  const s = SPAWNS[p.spawnIdx];
  p.x = s.x + 0.5;
  p.y = s.y + 0.5;
  p.invulnUntil = Date.now() + CONFIG.invulnMs;
  p.ghostBombs = new Set();
}

// ------------------------------------------------------------------ movement
function circleBlocked(p, cx, cy) {
  const r = CONFIG.playerRadius;
  const minTx = Math.floor(cx - r), maxTx = Math.floor(cx + r);
  const minTy = Math.floor(cy - r), maxTy = Math.floor(cy + r);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const t = tileAt(tx, ty);
      let solid = t !== 0;
      if (!solid) {
        const b = bombAt(tx, ty);
        if (b && !p.ghostBombs.has(b.id)) solid = true;
      }
      if (!solid) continue;
      // circle vs tile AABB
      const nx = Math.max(tx, Math.min(cx, tx + 1));
      const ny = Math.max(ty, Math.min(cy, ty + 1));
      if ((cx - nx) ** 2 + (cy - ny) ** 2 < r * r) return { tx, ty };
    }
  }
  return null;
}

function tryKick(p, tx, ty, dx, dy) {
  if (!p.kick) return;
  const b = bombAt(tx, ty);
  if (!b || b.dir) return;
  // require rough alignment with the bomb's row/column
  if (dx !== 0 && Math.abs(p.y - (ty + 0.5)) > 0.35) return;
  if (dy !== 0 && Math.abs(p.x - (tx + 0.5)) > 0.35) return;
  const ntx = tx + dx, nty = ty + dy;
  if (tileAt(ntx, nty) !== 0 || bombAt(ntx, nty) || playerOnTile(ntx, nty)) return;
  b.dir = { x: dx, y: dy };
}

// When a move along one axis is blocked, slide the player toward the center of
// their current lane if the passage ahead is open there (corner assist).
function alignAssist(p, axis, step, maxNudge) {
  if (axis === 'x') {
    const centerY = Math.floor(p.y) + 0.5;
    const off = centerY - p.y;
    if (Math.abs(off) < 0.005 || circleBlocked(p, p.x + step, centerY)) return;
    const nudge = Math.sign(off) * Math.min(Math.abs(off), maxNudge);
    if (!circleBlocked(p, p.x, p.y + nudge)) p.y += nudge;
  } else {
    const centerX = Math.floor(p.x) + 0.5;
    const off = centerX - p.x;
    if (Math.abs(off) < 0.005 || circleBlocked(p, centerX, p.y + step)) return;
    const nudge = Math.sign(off) * Math.min(Math.abs(off), maxNudge);
    if (!circleBlocked(p, p.x + nudge, p.y)) p.x += nudge;
  }
}

function movePlayer(p, dt) {
  const inp = p.input;
  let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
  if (dx !== 0 || dy !== 0) {
    if (dx > 0) p.facing = 'right'; else if (dx < 0) p.facing = 'left';
    if (dy > 0) p.facing = 'down'; else if (dy < 0) p.facing = 'up';
  }
  if (dx === 0 && dy === 0) return;
  const speed = CONFIG.baseSpeed + CONFIG.speedStep * p.speedLevel;
  const inv = (dx !== 0 && dy !== 0) ? Math.SQRT1_2 : 1;
  const stepX = dx * speed * inv * dt;
  const stepY = dy * speed * inv * dt;

  // X axis
  if (stepX !== 0) {
    const hit = circleBlocked(p, p.x + stepX, p.y);
    if (!hit) {
      p.x += stepX;
    } else {
      tryKick(p, hit.tx, hit.ty, Math.sign(stepX), 0);
      if (dy === 0) alignAssist(p, 'x', stepX, speed * dt);
    }
  }
  // Y axis
  if (stepY !== 0) {
    const hit = circleBlocked(p, p.x, p.y + stepY);
    if (!hit) {
      p.y += stepY;
    } else {
      tryKick(p, hit.tx, hit.ty, 0, Math.sign(stepY));
      if (dx === 0) alignAssist(p, 'y', stepY, speed * dt);
    }
  }
  p.x = Math.max(CONFIG.playerRadius, Math.min(CONFIG.cols - CONFIG.playerRadius, p.x));
  p.y = Math.max(CONFIG.playerRadius, Math.min(CONFIG.rows - CONFIG.playerRadius, p.y));

  // drop ghost bombs the player has fully walked off of
  for (const id of p.ghostBombs) {
    const b = game.bombs.find(bb => bb.id === id);
    if (!b) { p.ghostBombs.delete(id); continue; }
    const nx = Math.max(b.tx, Math.min(p.x, b.tx + 1));
    const ny = Math.max(b.ty, Math.min(p.y, b.ty + 1));
    const r = CONFIG.playerRadius + 0.02;
    if ((p.x - nx) ** 2 + (p.y - ny) ** 2 > r * r) p.ghostBombs.delete(id);
  }
}

// ------------------------------------------------------------------ bombs
function placeBomb(p) {
  if (game.phase !== 'playing' || p.spectator || p.lives <= 0) return;
  if (p.activeBombs >= p.maxBombs) return;
  const tx = Math.round(p.x - 0.5), ty = Math.round(p.y - 0.5);
  if (bombAt(tx, ty) || tileAt(tx, ty) !== 0) return;
  const bomb = {
    id: game.nextBombId++,
    tx, ty,
    fx: tx + 0.5, fy: ty + 0.5,
    owner: p.id,
    radius: p.radius,
    explodeAt: Date.now() + CONFIG.bombFuseMs,
    dir: null,
  };
  game.bombs.push(bomb);
  p.activeBombs++;
  // anyone standing on the tile may walk off before it turns solid
  for (const q of game.players.values()) {
    if (q.spectator || q.lives <= 0) continue;
    const nx = Math.max(tx, Math.min(q.x, tx + 1));
    const ny = Math.max(ty, Math.min(q.y, ty + 1));
    if ((q.x - nx) ** 2 + (q.y - ny) ** 2 < CONFIG.playerRadius ** 2) {
      q.ghostBombs.add(bomb.id);
    }
  }
}

function slideBombs(dt) {
  for (const b of game.bombs) {
    if (!b.dir) continue;
    const ntx = b.tx + b.dir.x, nty = b.ty + b.dir.y;
    if (tileAt(ntx, nty) !== 0 || bombAt(ntx, nty) || playerOnTile(ntx, nty)) {
      // settle back on the current tile center
      b.dir = null;
      b.fx = b.tx + 0.5;
      b.fy = b.ty + 0.5;
      continue;
    }
    b.fx += b.dir.x * CONFIG.slideSpeed * dt;
    b.fy += b.dir.y * CONFIG.slideSpeed * dt;
    // crossed into the next tile center? claim it and keep going
    if (b.dir.x !== 0 && (b.fx - (ntx + 0.5)) * b.dir.x >= 0) { b.tx = ntx; b.fx = ntx + 0.5; }
    if (b.dir.y !== 0 && (b.fy - (nty + 0.5)) * b.dir.y >= 0) { b.ty = nty; b.fy = nty + 0.5; }
  }
}

function detonate(bomb, now, exploded) {
  if (exploded.has(bomb.id)) return;
  exploded.add(bomb.id);
  const owner = game.players.get(bomb.owner);
  if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

  const addFlame = (x, y, kind) => {
    game.flames.set(`${x},${y}`, { x, y, until: now + CONFIG.flameMs, kind });
  };
  addFlame(bomb.tx, bomb.ty, 'center');

  const dirs = [
    { x: 1, y: 0, k: 'h' }, { x: -1, y: 0, k: 'h' },
    { x: 0, y: 1, k: 'v' }, { x: 0, y: -1, k: 'v' },
  ];
  for (const d of dirs) {
    for (let i = 1; i <= bomb.radius; i++) {
      const x = bomb.tx + d.x * i, y = bomb.ty + d.y * i;
      const t = tileAt(x, y);
      if (t === 1) break;                          // indestructible wall stops it
      if (t === 2) {                               // breakable block: destroy & stop
        game.grid[y][x] = 0;
        addFlame(x, y, d.k);
        if (Math.random() < CONFIG.powerupChance) {
          const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
          game.powerups.push({ x, y, type });
        }
        break;
      }
      addFlame(x, y, i === bomb.radius ? d.k : d.k);
      // flames burn up power-ups lying in the open
      game.powerups = game.powerups.filter(pu => !(pu.x === x && pu.y === y));
      const other = bombAt(x, y);
      if (other && !exploded.has(other.id)) detonate(other, now, exploded); // chain
    }
  }
}

function updateBombsAndFlames(now) {
  const due = game.bombs.filter(b => b.explodeAt <= now);
  if (due.length) {
    const exploded = new Set();
    for (const b of due) detonate(b, now, exploded);
    game.bombs = game.bombs.filter(b => !exploded.has(b.id));
  }
  for (const [key, f] of game.flames) {
    if (f.until <= now) game.flames.delete(key);
  }
  // a sliding bomb that runs into flames goes off immediately
  for (const b of game.bombs) {
    if (game.flames.has(`${b.tx},${b.ty}`)) b.explodeAt = now;
  }
}

function checkPlayerDamage(now) {
  for (const p of game.players.values()) {
    if (p.spectator || p.lives <= 0 || now < p.invulnUntil) continue;
    const tx = Math.round(p.x - 0.5), ty = Math.round(p.y - 0.5);
    if (!game.flames.has(`${tx},${ty}`)) continue;
    p.lives--;
    if (p.lives > 0) respawn(p);
  }
}

function checkWinner() {
  if (game.phase !== 'playing') return;
  const contenders = [...game.players.values()].filter(p => !p.spectator);
  if (contenders.length < 2) return; // solo practice: never ends by elimination
  const alive = contenders.filter(p => p.lives > 0);
  if (alive.length <= 1) {
    game.phase = 'over';
    game.winner = alive.length === 1 ? { id: alive[0].id, name: alive[0].name } : null;
  }
}

// ------------------------------------------------------------------ power-ups
function collectPowerups() {
  for (const p of game.players.values()) {
    if (p.spectator || p.lives <= 0) continue;
    const tx = Math.round(p.x - 0.5), ty = Math.round(p.y - 0.5);
    const i = game.powerups.findIndex(pu => pu.x === tx && pu.y === ty);
    if (i === -1) continue;
    const pu = game.powerups.splice(i, 1)[0];
    if (pu.type === 'radius') p.radius = Math.min(CONFIG.maxRadius, p.radius + 1);
    else if (pu.type === 'bombs') p.maxBombs = Math.min(CONFIG.maxBombs, p.maxBombs + 1);
    else if (pu.type === 'speed') p.speedLevel = Math.min(CONFIG.maxSpeedLevel, p.speedLevel + 1);
    else if (pu.type === 'kick') p.kick = true;
  }
}

// ------------------------------------------------------------------ game loop
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  if (game.phase !== 'playing') return;
  for (const p of game.players.values()) {
    if (!p.spectator && p.lives > 0) movePlayer(p, dt);
  }
  slideBombs(dt);
  updateBombsAndFlames(now);
  collectPowerups();
  checkPlayerDamage(now);
  checkWinner();
}, 1000 / CONFIG.tickHz);

// ------------------------------------------------------------------ networking
function snapshot() {
  return JSON.stringify({
    t: 'state',
    phase: game.phase,
    grid: game.grid.map(row => row.join('')).join(''),
    players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3),
      facing: p.facing, lives: p.lives,
      radius: p.radius, maxBombs: p.maxBombs,
      speedLevel: p.speedLevel, kick: p.kick,
      invuln: Date.now() < p.invulnUntil,
      spectator: p.spectator,
    })),
    bombs: game.bombs.map(b => ({
      x: +b.fx.toFixed(3), y: +b.fy.toFixed(3),
      fuse: Math.max(0, b.explodeAt - Date.now()),
    })),
    flames: [...game.flames.values()].map(f => ({ x: f.x, y: f.y, kind: f.kind })),
    powerups: game.powerups,
    winner: game.winner,
  });
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join' && !player) {
      const name = String(msg.name || '').slice(0, 12).trim() || `P${nextPlayerId}`;
      const activeCount = [...game.players.values()].filter(p => !p.spectator).length;
      const asSpectator = game.phase === 'playing' || activeCount >= CONFIG.maxPlayers;
      player = {
        id: nextPlayerId++,
        ws, name,
        color: COLORS[game.players.size % COLORS.length],
        spectator: asSpectator,
        lives: 0, x: 0.5, y: 0.5, facing: 'down',
        radius: CONFIG.startRadius, maxBombs: CONFIG.startBombs,
        speedLevel: 0, kick: false, activeBombs: 0,
        invulnUntil: 0, spawnIdx: 0, ghostBombs: new Set(),
        input: { up: false, down: false, left: false, right: false },
      };
      game.players.set(player.id, player);
      ws.send(JSON.stringify({ t: 'welcome', id: player.id, lives: CONFIG.lives }));
      return;
    }
    if (!player) return;

    if (msg.t === 'input') {
      player.input.up = !!msg.up;
      player.input.down = !!msg.down;
      player.input.left = !!msg.left;
      player.input.right = !!msg.right;
    } else if (msg.t === 'bomb') {
      placeBomb(player);
    } else if (msg.t === 'start' && game.phase === 'lobby') {
      const active = [...game.players.values()].filter(p => !p.spectator);
      if (active.length >= 2) startRound();
    } else if (msg.t === 'again' && game.phase === 'over') {
      // everyone (including spectators who waited) rejoins the lobby
      let i = 0;
      for (const p of game.players.values()) {
        p.spectator = i >= CONFIG.maxPlayers;
        i++;
      }
      game.phase = 'lobby';
      game.winner = null;
    }
  });

  ws.on('close', () => {
    if (!player) return;
    game.players.delete(player.id);
    checkWinner();
    if (game.players.size === 0 && game.phase !== 'lobby') {
      game.phase = 'lobby';
      game.winner = null;
    }
  });
});

setInterval(() => {
  const data = snapshot();
  for (const p of game.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}, 1000 / CONFIG.sendHz);

server.listen(CONFIG.port, () => {
  console.log(`BomberGuy running on http://localhost:${CONFIG.port}`);
  console.log(`Lives per player: ${CONFIG.lives} (override with LIVES=n)`);
  console.log('Share online:  cloudflared tunnel --url http://localhost:' + CONFIG.port);
});
