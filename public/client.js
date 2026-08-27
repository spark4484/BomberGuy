'use strict';

const COLS = 13, ROWS = 11, TILE = 48;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const joinOverlay = document.getElementById('joinOverlay');
const lobbyOverlay = document.getElementById('lobbyOverlay');
const overOverlay = document.getElementById('overOverlay');
const roster = document.getElementById('roster');
const startBtn = document.getElementById('startBtn');
const winnerText = document.getElementById('winnerText');

let ws = null;
let myId = null;
let state = null;                 // latest server snapshot
const drawn = new Map();          // id -> {x, y} smoothed render positions

// ------------------------------------------------------------------ network
function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'welcome') myId = msg.id;
    else if (msg.t === 'state') { state = msg; updateOverlays(); updateHud(); }
  };
  ws.onclose = () => {
    winnerText.textContent = 'Disconnected — refresh to rejoin';
    overOverlay.classList.remove('hidden');
    document.getElementById('againBtn').style.display = 'none';
  };
}
const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// ------------------------------------------------------------------ UI
document.getElementById('joinBtn').onclick = doJoin;
document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doJoin();
});
function doJoin() {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  joinOverlay.classList.add('hidden');
  connect(name);
}
startBtn.onclick = () => send({ t: 'start' });
document.getElementById('againBtn').onclick = () => send({ t: 'again' });

function updateOverlays() {
  if (!state) return;
  lobbyOverlay.classList.toggle('hidden', state.phase !== 'lobby');
  overOverlay.classList.toggle('hidden', state.phase !== 'over');
  if (state.phase === 'lobby') {
    const active = state.players.filter(p => !p.spectator);
    roster.innerHTML = state.players.map(p =>
      `<span style="color:${p.color}">●</span> ${esc(p.name)}${p.spectator ? ' (spectator)' : ''}${p.id === myId ? ' (you)' : ''}`
    ).join('<br>');
    startBtn.disabled = active.length < 2;
    startBtn.textContent = active.length < 2
      ? `Waiting for players… (${active.length}/2+)` : 'Start game';
  } else if (state.phase === 'over') {
    winnerText.textContent = state.winner
      ? `🏆 ${state.winner.name} wins!` : '💀 Draw — everyone is out!';
  }
}

function updateHud() {
  if (!state) return;
  hud.innerHTML = state.players.filter(p => !p.spectator).map(p => `
    <div class="hudCard" style="border-left-color:${p.color}">
      <div class="nm" style="color:${p.color}">${esc(p.name)}${p.id === myId ? ' (you)' : ''}</div>
      <div class="stats">${p.lives > 0 ? '❤️'.repeat(p.lives) : '💀'}</div>
      <div class="stats">🔥${p.radius} 💣${p.maxBombs} ⚡${p.speedLevel}${p.kick ? ' 🥾' : ''}</div>
    </div>`).join('');
}

const esc = s => s.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ------------------------------------------------------------------ input
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};
window.addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) send({ t: 'bomb' });
    return;
  }
  const k = KEYMAP[e.key];
  if (!k) return;
  e.preventDefault();
  if (!keys[k]) { keys[k] = true; send({ t: 'input', ...keys }); }
});
window.addEventListener('keyup', e => {
  const k = KEYMAP[e.key];
  if (!k || !keys[k]) return;
  keys[k] = false;
  send({ t: 'input', ...keys });
});
window.addEventListener('blur', () => {
  keys.up = keys.down = keys.left = keys.right = false;
  send({ t: 'input', ...keys });
});

// ------------------------------------------------------------------ rendering
const PU_EMOJI = { radius: '🔥', bombs: '💣', speed: '⚡', kick: '🥾' };

function drawFloor() {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#3f9b4f' : '#45a856';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }
}

function drawSolid(x, y) {
  const px = x * TILE, py = y * TILE;
  ctx.fillStyle = '#6d7482';
  ctx.fillRect(px, py, TILE, TILE);
  ctx.fillStyle = '#8b93a3';
  ctx.fillRect(px + 3, py + 3, TILE - 6, TILE - 10);
  ctx.fillStyle = '#565c68';
  ctx.fillRect(px + 3, py + TILE - 9, TILE - 6, 6);
}

function drawSoft(x, y) {
  const px = x * TILE, py = y * TILE;
  ctx.fillStyle = '#b06a3b';
  ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
  ctx.fillStyle = '#8f5330';
  for (let r = 0; r < 3; r++) {
    ctx.fillRect(px + 2, py + 2 + r * 15 + 12, TILE - 4, 2);
    const off = r % 2 === 0 ? 14 : 28;
    ctx.fillRect(px + off, py + 2 + r * 15, 2, 13);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4);
}

function drawBomb(b, now) {
  const px = b.x * TILE, py = b.y * TILE;
  const pulse = b.fuse < 900 ? 1 + 0.12 * Math.sin(now / 55) : 1 + 0.05 * Math.sin(now / 180);
  const r = TILE * 0.34 * pulse;
  ctx.fillStyle = '#20232c';
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.arc(px - r * 0.3, py - r * 0.35, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  // fuse spark
  ctx.strokeStyle = '#a0763c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px + r * 0.2, py - r * 0.9);
  ctx.quadraticCurveTo(px + r * 0.7, py - r * 1.5, px + r * 0.3, py - r * 1.7);
  ctx.stroke();
  ctx.fillStyle = now % 260 < 130 ? '#ffd24d' : '#ff8c3a';
  ctx.beginPath();
  ctx.arc(px + r * 0.3, py - r * 1.7, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlame(f, now) {
  const px = f.x * TILE, py = f.y * TILE;
  const jitter = 0.85 + 0.15 * Math.sin(now / 45 + f.x * 3 + f.y * 5);
  const grd = ctx.createRadialGradient(
    px + TILE / 2, py + TILE / 2, 4,
    px + TILE / 2, py + TILE / 2, (TILE / 2) * jitter);
  grd.addColorStop(0, '#fff6c0');
  grd.addColorStop(0.45, '#ffd24d');
  grd.addColorStop(1, '#ff5d24');
  ctx.fillStyle = grd;
  const m = 3 * jitter;
  roundRect(px + m, py + m, TILE - 2 * m, TILE - 2 * m, 10);
  ctx.fill();
}

function drawPowerup(pu, now) {
  const px = pu.x * TILE, py = pu.y * TILE;
  const bob = Math.sin(now / 300 + pu.x + pu.y) * 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  roundRect(px + 8, py + 8 + bob, TILE - 16, TILE - 16, 8);
  ctx.fill();
  ctx.strokeStyle = '#ffd24d';
  ctx.lineWidth = 2.5;
  roundRect(px + 8, py + 8 + bob, TILE - 16, TILE - 16, 8);
  ctx.stroke();
  ctx.font = '20px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(PU_EMOJI[pu.type] || '?', px + TILE / 2, py + TILE / 2 + bob + 1);
}

function drawPlayer(p, pos, now) {
  if (p.lives <= 0 || p.spectator) return;
  if (p.invuln && Math.floor(now / 120) % 2 === 0) return; // flicker
  const px = pos.x * TILE, py = pos.y * TILE;
  const r = TILE * 0.36;
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(px, py + r * 0.75, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  // body
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // face offset by direction
  const fo = { up: [0, -4], down: [0, 3], left: [-4, 0], right: [4, 0] }[p.facing] || [0, 3];
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(px - 6 + fo[0], py - 3 + fo[1], 4.5, 0, Math.PI * 2);
  ctx.arc(px + 6 + fo[0], py - 3 + fo[1], 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(px - 6 + fo[0] * 1.4, py - 3 + fo[1] * 1.4, 2, 0, Math.PI * 2);
  ctx.arc(px + 6 + fo[0] * 1.4, py - 3 + fo[1] * 1.4, 2, 0, Math.PI * 2);
  ctx.fill();
  // name tag
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(p.name, px + 1, py - r - 5);
  ctx.fillStyle = p.id === myId ? '#fff' : '#e6e6e6';
  ctx.fillText(p.name, px, py - r - 6);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  drawFloor();
  if (!state) return;

  const grid = state.grid;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = grid[y * COLS + x];
      if (t === '1') drawSolid(x, y);
      else if (t === '2') drawSoft(x, y);
    }
  }
  for (const pu of state.powerups) drawPowerup(pu, now);
  for (const f of state.flames) drawFlame(f, now);
  for (const b of state.bombs) drawBomb(b, now);

  // smooth player positions toward the latest snapshot
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    let d = drawn.get(p.id);
    if (!d) { d = { x: p.x, y: p.y }; drawn.set(p.id, d); }
    const far = Math.hypot(p.x - d.x, p.y - d.y) > 2; // teleport (respawn)
    const k = far ? 1 : Math.min(1, dt * 14);
    d.x += (p.x - d.x) * k;
    d.y += (p.y - d.y) * k;
    drawPlayer(p, d, now);
  }
  for (const id of drawn.keys()) if (!seen.has(id)) drawn.delete(id);
}
requestAnimationFrame(frame);
