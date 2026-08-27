# BomberGuy 💣

A multiplayer Bomberman clone (2–4 players) you can play with friends online via
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

### Play online with a friend

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Send the `https://….trycloudflare.com` URL it prints to your friend — the tunnel
handles WebSockets, so it just works.

## How to play

| Action | Keys |
|---|---|
| Move | Arrow keys or WASD |
| Drop bomb | Spacebar |

- **13×11 grid** — alternating indestructible pillars, breakable soft blocks
  (70% spawn chance), open spawn corners.
- **Bombs** have a 3-second fuse. Explosions propagate in 4 directions and are
  stopped by pillars and soft blocks (destroying the latter). Blasts chain other bombs.
- **Lives:** each player has **3 lives** by default (respawn with 2s of
  invulnerability). Configurable: `LIVES=4 npm start`.
- Destroyed soft blocks have a **30% chance** to drop a permanent power-up:
  - 🔥 **Blast radius** +1 (max 5)
  - 💣 **Extra bomb** — place more bombs at once (max 3)
  - ⚡ **Speed up** (max 3 boosts, ~5.4 tiles/s cap)
  - 🥾 **Kick** — walk into a bomb to send it sliding down the path

Last player with lives remaining wins the round.

## Config

Environment variables:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `LIVES` | `3` | Lives per player |
| `SOFT_CHANCE` | `0.7` | Soft-block spawn probability |
