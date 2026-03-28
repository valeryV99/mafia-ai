# Mafia AI — Progress & Known Issues

_Last updated: 2026-03-23_

---

## Implemented ✓

### Step 1 — Lobby
- Players join room, host starts game ✅
- `+ Add Voice Agent` (Alex) joins as Fishjam audio participant ✅
- `+ Add 3 AI Bots` button **removed** — bots replaced by AI Voice Agents ✅
- `BotAgent.ts` deleted, all bot artifacts cleaned up (BotAgent, botNames, botAgents, useBotTTS, pendingBotSpeech, bot_speech, tts.ts) ✅
- `StartButton` requires min. 4 players (client + server) ✅
- Role count formula: `Math.floor(n/4)` mafia, 1 detective, 1 doctor, rest civilian ✅

### Step 2 — Role Assignment (`role_assignment`)
- Roles assigned randomly, sent privately to each player ✅
- `ROLE_REVEAL_DELAY` (3s dev / 5s prod) before narrator starts ✅
- No timer shown during `role_assignment` ✅
- Narrator silent ✅
- **Auto-mute mic** on `role_assignment` entry, auto-unmute on exit ✅
- Role summary log: `[Game:X][roles] Alice=mafia, Bob=detective, ...` ✅

### Step 3 — Narrator speaks (transition → Night)
- `phase_changed` to `night` → `isNarratorSpeaking = true` → timer FROZEN ✅
- Narrator announces night, describes town falling asleep ✅
- `transcript_clear` (turnComplete) → `isNarratorSpeaking = false` → timer STARTS ✅
- Safety fallback: timer unfreezes after 30s if turnComplete never fires ✅

### Step 4 — Night (`night`)
- Timer starts AFTER narrator finishes (fixed: was firing immediately) ✅
- `NightPanel` UI: mafia/detective/doctor see player list, civilian sees "wait" message ✅
- Players cannot target themselves ✅
- After selecting target: "Action submitted — waiting for dawn..." confirmation ✅
- Night actions via voice (Gemini tool calls: `night_kill`, `investigate`, `doctor_save`, `resolve_night`) ✅
- Night actions via UI (`night_action` WS event → `handleNightAction()`) ✅
- `checkAllNightActionsComplete()` — resolves night early if all roles acted ✅
- Timer fallback: `resolveNight()` fires after 45s/90s if not all roles acted ✅

### Step 5 — Night resolution + Narrator speaks (transition → Day or Game Over)
- `resolveNight()` fully implemented:
  - Mafia kill: majority vote, random on tie ✅
  - Doctor blocks kill if same target ✅
  - Detective gets investigation result (even if target killed this turn) ✅
  - Win condition checked after night ✅
- `startDay()` now has `doctorSaved` param → narrator knows to mention the save ✅
- If mafia wins after night → `endGame()` → narrator announces, goes to `game_over` ✅

### Steps 6–10 (Day, Voting, Game Over)
- Day discussion, voting, game over phases were already working from before ✅
- Post-voting elimination and win condition check working ✅

---

## ⚠️ NOT YET TESTED

All changes from this session are written but **not verified in a real running game**. The following need to be tested:

- Auto-mute/unmute mic on `role_assignment` ↔ other phases
- Night timer starts only AFTER narrator finishes (not immediately)
- NightPanel shows correct UI per role
- Mafia kill → correct player eliminated next day
- Doctor save → narrator mentions the save
- Detective investigation result appears in client UI
- `checkAllNightActionsComplete()` triggers early resolution correctly
- Night fallback timer (45s) fires if nobody acts
- Win condition after night (mafia ≥ civilians → game_over, no day phase)
- No regressions in day / voting / game_over flow

---

## Known issues still open 🐛

- **Safety timer stacking** — `narratorSafetyTimer` in `socket.ts` may stack across phase changes if not cancelled properly. Check whether existing cancellation logic is sufficient.
- **`<ctrl46>` artifacts** — Gemini tool call batches produce silent transcript events during day. Filtered client-side but cosmetically noisy.
- **VoiceAgent night tools** — VoiceAgent (Alex) only has `cast_vote` tool. If Alex is mafia/detective/doctor, he can't call `night_kill`/`investigate`/`doctor_save`. Night tool support for VoiceAgent not yet added.

---

## Remaining game steps to implement 📋

| Step | Phase | Status |
|------|-------|--------|
| 6 | Day (`day`) | ✅ implemented (needs regression test) |
| 7 | Narrator speaks (transition → Voting) | ✅ implemented (needs regression test) |
| 8 | Voting (`voting`) | ✅ implemented (needs regression test) |
| 9 | Elimination resolution + Narrator (→ Night or Game Over) | ✅ implemented (needs regression test) |
| 10 | Game Over (`game_over`) | ✅ implemented (needs regression test) |

### Features still missing (from CONVENTIONS.md Known Limitations)
- Gray tile / visual indicator for eliminated players (`VideoGrid.tsx`)
- Eliminated players cannot vote or act (needs guard in `castVote` / `handleNightAction`)
- 4 players minimum guard on `StartButton` is client-only — server already enforces it
