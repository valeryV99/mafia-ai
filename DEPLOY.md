# AI Mafia — Deployment Guide

## Overview

Monorepo with 2 deployable services:
- **Server** (Bun + Hono + WebSocket) → Railway
- **Client** (React + Vite) → Vercel

---

## 1. Server Deployment (Railway)

### Prerequisites
- Railway account: https://railway.app
- Railway CLI: `npm i -g @railway/cli`

### Environment Variables (set in Railway Dashboard)

| Variable | Value | Required |
|----------|-------|----------|
| `GEMINI_API_KEY` | Google AI Studio API key | Yes |
| `FISHJAM_URL` | `wss://<id>.fishjam.io` | Yes |
| `FISHJAM_MANAGEMENT_TOKEN` | Fishjam management token | Yes |
| `PORT` | `3001` | Yes |
| `NODE_ENV` | `production` | Yes |

### Deploy Steps

```bash
# 1. Login to Railway
railway login

# 2. Init project (from repo root)
cd mafia-ai
railway init

# 3. Link to service
railway service

# 4. Set env vars
railway variables set GEMINI_API_KEY=<key>
railway variables set FISHJAM_URL=wss://<id>.fishjam.io
railway variables set FISHJAM_MANAGEMENT_TOKEN=<token>
railway variables set PORT=3001
railway variables set NODE_ENV=production

# 5. Deploy
railway up
```

### Alternative: Deploy via GitHub
1. Go to https://railway.app/new
2. Connect GitHub repo
3. Set root directory: `/` (monorepo root)
4. Railway will detect the Dockerfile at `apps/server/Dockerfile`
5. Add environment variables in Dashboard → Variables

### Dockerfile
Already created at `apps/server/Dockerfile`. Uses `oven/bun:1.3` base image.

### Health Check
Server exposes `GET /health` → `{"status":"ok"}`.
Railway config (`apps/server/railway.toml`) is set to use this.

### What the server does
- WebSocket on `/ws` — game events + player connections
- REST API — room creation, bot management, Fishjam peer tokens
- Gemini Live API — AI game master voice (via Fishjam Agent)
- Game state — in-memory, resets on restart

### Important Notes
- Server needs persistent WebSocket connections — ensure Railway doesn't kill idle connections
- In-memory state means restarting loses all active games
- The Fishjam Agent connects server → Fishjam Cloud → Gemini, so server needs outbound WebSocket access

---

## 2. Client Deployment (Vercel)

### Prerequisites
- Vercel account: https://vercel.com
- Vercel CLI: `npm i -g vercel`

### Environment Variables (set in Vercel Dashboard)

| Variable | Value | Required |
|----------|-------|----------|
| `VITE_SERVER_WS_URL` | `wss://<railway-url>/ws` | Yes |
| `VITE_FISHJAM_ID` | Fishjam ID (from fishjam.io dashboard) | Yes |

### Deploy Steps

```bash
# 1. Build client
cd apps/client
VITE_SERVER_WS_URL=wss://<railway-server-url>/ws \
VITE_FISHJAM_ID=<fishjam-id> \
bun run build

# 2. Deploy to Vercel
npx vercel --prod
```

### Alternative: Deploy via GitHub
1. Go to https://vercel.com/new
2. Import GitHub repo
3. Framework Preset: Vite
4. Root Directory: `apps/client`
5. Build Command: `cd ../.. && bun install && cd apps/client && bun run build`
6. Output Directory: `dist`
7. Add environment variables in Settings → Environment Variables

### Important Notes
- Client is a static SPA — no server-side rendering
- WebSocket URL must use `wss://` (not `ws://`) for production
- Fishjam ID is the subdomain from your Fishjam Cloud URL: `https://<ID>.fishjam.io`

---

## 3. Fishjam Cloud Setup

1. Go to https://fishjam.io and create an account
2. Create an app in the dashboard
3. Copy:
   - **Fishjam ID** — the ID shown in the URL (`<id>.fishjam.io`)
   - **Management Token** — from API tokens section
4. Use these values in both server and client env vars

---

## 4. Post-Deploy Checklist

- [ ] Server health check: `curl https://<railway-url>/health` → `{"status":"ok"}`
- [ ] Client loads: `https://<vercel-url>/`
- [ ] WebSocket connects (check browser console for `Connected to server`)
- [ ] Create room and join — player appears in list
- [ ] Video works (Fishjam camera)
- [ ] Start game with bots — Gemini speaks
- [ ] Full game loop: night → day → voting → game over

---

## 5. Troubleshooting

### WebSocket connection fails
- Check `VITE_SERVER_WS_URL` uses `wss://` not `ws://`
- Check Railway service is running and port is exposed
- Check CORS — server uses `cors()` middleware

### Gemini doesn't speak
- Check `GEMINI_API_KEY` is valid
- Check server logs for `[AgentBridge:gemini] Session opened`
- Gemini has rate limits — check Google AI Studio quota

### Video doesn't work
- Check `VITE_FISHJAM_ID` matches the Fishjam dashboard
- Check `FISHJAM_URL` and `FISHJAM_MANAGEMENT_TOKEN` on server
- Check browser allows camera/microphone permissions

### Bots don't respond
- Check `GEMINI_API_KEY` — bot agents use Gemini Text API
- Check server logs for `[Bot:Alexa]` entries

---

## Architecture Summary

```
Users ──→ Vercel (React SPA)
           │
           │ WebSocket (wss://)
           ▼
         Railway (Bun server)
           │
           ├──→ Fishjam Cloud (WebRTC video + Agent audio)
           │      │
           │      └──→ Gemini Live API (voice AI)
           │
           └──→ Gemini Text API (bot agents)
```


 ---                                                        
Title (10-80 chars):                                       
[Real time Multimodal] AI Mafia — Voice-Powered Party Game
with Gemini Live

Subtitle (до 140 chars):                                   
AI Game Master narrates, listens, and judges players in
real-time using Gemini Live API, Fishjam video, MediaPipe  
face analysis, and GPU effects

Project Description:

## What we built

AI Mafia is a real-time multiplayer party game where an AI
Game Master powered by **Gemini Live API** narrates,     
listens to players via voice, and controls the entire game
flow — from role assignment to voting and elimination.

Players join a video room via **Fishjam WebRTC**, see each
other on camera, and interact with the AI narrator using
natural speech. No buttons needed — just talk.

## How it works

1. **Lobby** — Players join a room, see each other's video
   feeds
2. **Night** — The AI Game Master dramatically announces   
   nightfall. Mafia, Detective, and Doctor make their choices
   via voice or tap
3. **Day** — AI facilitates discussion, asks pointed       
   questions, drops suspicion hints based on player behavior  
   and facial expressions
4. **Voting** — GM asks each player who they want to       
   eliminate. Players speak a name, GM confirms and tallies   
   votes
5. **Game Over** — Winner announced with GPU-powered       
   confetti celebration

## Tech Stack — Full Software Mansion + Gemini Integration

| Technology | How we use it |                             
  |---|---|                                                
| **Gemini Live API** | Real-time bidirectional voice — AI 
Game Master hears players, speaks back, calls game tools   
(kill, investigate, vote). Single persistent audio session
with function calling |                                    
| **Fishjam** | WebRTC SFU for multiplayer video/audio   
rooms. Players see and hear each other. GM agent joins as a
Fishjam peer for audio output |
| **MediaPipe** | Real-time face analysis via webcam —     
detects stress, surprise, happiness, gaze direction. Fed to
Gemini narrator who comments on player emotions ("I notice
some nervousness...") |                                   
| **Smelter** | Spectator broadcast mode — server-side   
video compositing with custom WGSL shaders (grayscale for  
dead players, night darkening, stress pulse effects) |
| **TypeGPU** | WebGPU-powered visual effects — victory    
confetti particle system, fullscreen night shader overlay  
with vignette and breathing pulse animation |

## Architecture Highlights

- **Voice Activity Detection** — Server-side VAD identifies
  which player is speaking, sends `[SPEAKER]` tags to Gemini
  so it knows who said what
- **Face-to-AI Pipeline** — MediaPipe → face metrics →   
  server → Gemini narrator. The AI comments on player stress
  in real-time, adding a lie-detection layer to the game
- **Stress Visualization** — Players with high stress get  
  red vignette glow, bouncing panic emoji, enlarged video    
  tile — visible to all players
- **Structured Prompt Engineering** — Noir narrator        
  personality, suspicion scoring guidelines (1-10 scale),    
  phase-specific instructions, face analysis integration
- **Tool Calling** — Gemini uses 7 game tools: night_kill,
  investigate, doctor_save, resolve_night, start_voting,     
  cast_vote, update_suspicion

## What makes it special

- **No typing, no clicking** — Pure voice interaction with
  AI. Say a name to vote, say a name to kill. The AI
  understands and acts instantly
- **AI reads your face** — MediaPipe detects when you're
  nervous. The narrator calls you out. Other players see your
  stress level on their screen
- **GPU-powered atmosphere** — WebGPU night shader darkens
  the screen with a breathing blue vignette. Confetti        
  explodes on victory. All rendered on GPU
- **Spectator mode** — Smelter composites all video feeds  
  with shader effects into a single broadcast stream

## Links

- **GitHub**: https://github.com/valeryV99/mafia-ai
- **Presentation**: [Google Slides link here]

  ---                                                        
Скопируй это в форму. Нужно ещё:
1. Поставить скриншот/thumbnail (560x280) — можешь         
   заскринить игру в ночной фазе
2. Добавить link на GitHub repo
3. Добавить link на Google Slides презентацию

Хочешь чтобы набросал структуру слайдов для презентации    
тоже?

✻ Baked for 44s · 1 shell still running   