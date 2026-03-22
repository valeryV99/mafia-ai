# Mafia AI — Progress & Known Issues

_Last updated: 2026-03-22_

---

## What works ✓

- Core game loop: lobby → night → (day) → voting → night...
- Role assignment and role reveal to player
- Fishjam WebRTC — player audio/video, speaking border highlight, VAD floor control
- Narrator speaks during night announcement (full scene: mafia/detective/doctor wake-up)
- Narrator transcription in subtitle box (cleared after `turnComplete`)
- Player mic blocked while narrator speaks (server-side audio drop + UI freeze)
- Countdown timer frozen when `isNarratorSpeaking = true`
- Detective investigation result visible in NightPanel UI
- Bot subtitles in transcript bar (`bot_speak`)
- Transcript noise filtering (backtick function calls, `<ctrl46>` filtered client-side)
- `afterNarratorFinishes()` — phase transitions wait for `turnComplete` (with 15s fallback)
- `turnComplete` IS firing — confirmed in logs (just with delay after 15s fallback triggers first)
- Timing logs: `[Phase]`, `[Timer]`, `[Narrator]`, `[STT]`
- AI voice agent (`VoiceAgent`) added to Fishjam room
- `[AgentBridge:raw]` diagnostic logging of Gemini message structure
- Batch `sendToolResponse` (all FCs in one message — correct per Gemini API)

---

## Known bugs 🐛

### CRITICAL: `bridge.start()` called twice in `initGemini()`

**Location:** `apps/server/src/game/GameManager.ts` lines ~369–374

```ts
await this.bridge.start(this.fishjamRoomId, prompt, tools)           // ← 3-arg (silent)
setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY) // ← fires too early
await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false) // ← 5-arg (audible), DUPLICATE!
```

This creates **two Fishjam ghost peers** and **two Gemini sessions**. The second call replaces `geminiSession` and creates a second agent track. This is the root cause of multiple issues (narrator silence, double audio, confusion).

**Fix:** Keep only the 5-arg call. Remove the duplicate 3-arg call and move `setTimeout(startNight)` to after the single `bridge.start()`.

---

### CRITICAL: `turnComplete` fires AFTER 15s fallback — race condition

**Symptoms (confirmed in logs):**
```
[Timer] Safety reset — narrator never fired turnComplete  ← 15s fallback fires
[Phase] → day at T+29s                                   ← phase already changed
[Narrator] DONE (turnComplete) at T+34s                  ← real turnComplete, 5s late
```

The 15s fallback in `afterNarratorFinishes()` triggers `pendingPhaseTransition` before the real `turnComplete` arrives. The real `turnComplete` then fires `onTurnComplete` → sends stray `transcript_clear` at the wrong time.

**Root cause:** `PENDING_PHASE_TIMEOUT_MS = 15_000` is too short for a full night narration (~25–35s). Also: after `sendToolResponse`, Gemini needs extra time to finish speaking.

**Fix options:**
- Increase `PENDING_PHASE_TIMEOUT_MS` to 45–60s
- OR: drive phase transitions purely from timer (not narrator) — narrator speaks over the running timer

---

### BUG: Safety reset timer stacks across phases

**Symptoms (confirmed in logs):**
```
[Phase] → lobby at T+0     → sets 20s timer
[Phase] → night at T+5     → sets another 20s timer (old one still running)
[Timer] Safety reset ← lobby's timer fires at T+20, resetting narrator during night!
```

**Fix:** Store timer ref, cancel previous timer before setting new one.

---

### BUG: Day phase narrator sends only `<ctrl46>` (silent turns)

**Symptoms:** After phase_changed → day, narrator sends multiple transcript events containing only `<ctrl46>`. These are silent Gemini turns from batch tool responses (bot_speak, cast_vote). Client filters them → shows nothing → narrator appears silent during day.

**These are NOT real speech** — just tool call artifact. The actual day announcement arrives later ("A new dawn breaks...").

**Fix options:**
- Don't set `isNarratorSpeaking = true` until non-empty text arrives (already partially done client-side)
- Or: accept it as cosmetic issue since content is correctly filtered

---

### BUG: `initGemini()` has two `bridge.start()` calls (see CRITICAL above)

Also: after the first `bridge.start()` (3-arg), `startNight()` is scheduled with `setTimeout`. This means night starts before the audible bridge (2nd call) is ready. So the narrator can't speak for the first night call.

---

## Desired game flow (rewrite plan) 🎯

```
LOBBY
  → game_started (roles assigned)
  → PREPARATION PHASE (new)
      - narrator announces: "Welcome to Mafia! Here are the roles..."
      - timer FROZEN (no countdown)
      - when narrator finishes (turnComplete) → start night
NIGHT (timer runs, e.g. 30s)
  - civilians: see panel "Wait for night to end"
  - mafia/detective/doctor: see action panel, make choice
  - when timer expires → freeze timer → narrator announces night results
      - if someone killed: show their tile with gray overlay ("X was killed")
      - narrator speaks (timer frozen)
      - when turnComplete → start VOTING
VOTING (timer runs, e.g. 30s)
  - all players vote (voice or click)
  - when all vote OR timer expires → freeze timer → narrator announces result
      - show eliminated player with gray tile
      - narrator announces next night
      - when turnComplete → start next NIGHT
...repeat until game over
```

**Key simplifications vs current:**
- Remove `day` phase (discussion) — go directly night → voting
- Add `preparation` phase
- No day discussion timer — narrator drives timing directly

---

## Todo 📋

| # | Priority | Description | File(s) |
|---|----------|-------------|---------|
| 1 | ✅ DONE | Fix double `bridge.start()` — remove 3-arg call, keep only 5-arg | `GameManager.ts` |
| 2 | ✅ DONE | Increase `PENDING_PHASE_TIMEOUT_MS` to 60s (fix race with 15s fallback) | `AgentBridge.ts` |
| 0 | ✅ DONE | Fix audio loop: AgentBridge forwarded VoiceAgent audio back to Gemini → 1008 Policy Violation. Fix: whitelist only human peer IDs in `allowedPeerIds` | `AgentBridge.ts`, `GameManager.ts` |
| 3 | 🟠 HIGH | Add `preparation` phase to Phase type + implement `startPreparation()` | `types/index.ts`, `GameManager.ts` |
| 4 | 🟠 HIGH | Remove `day` discussion phase — wire night → voting directly (via narrator) | `GameManager.ts` |
| 5 | 🟠 HIGH | Show killed player with gray tile overlay on `player_eliminated` event | `VideoGrid.tsx` |
| 6 | 🟡 IMPORTANT | Fix safety timer stacking — store ref, cancel previous on phase_changed | `socket.ts` |
| 7 | 🟡 IMPORTANT | Only set `isNarratorSpeaking(true)` for phases with narrator (not lobby) | `socket.ts` |
| 8 | 🟢 FEATURE | Bots: show 3–4 word suspicion text in transcript bar (`suspicion_update` event) | `socket.ts`, `VideoGrid.tsx` |

---

## What to implement FIRST

Start with todos #1 and #2 — these unblock everything else:
1. Fix double bridge.start → narrator will work reliably
2. Increase timeout → turnComplete will drive real transitions instead of 15s fallback

Then #3 + #4 (new game flow), then #5 (gray tile), then #6–8.
