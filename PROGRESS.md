# Mafia AI — Progress & Known Issues

## What works ✓
- Core game flow (lobby → night → day → voting → night...)
- Role assignment and sending role to player
- Fishjam WebRTC — player audio, video, speaking border highlight
- Narrator speaks during the first night announcement
- Narrator transcription in subtitle box (cleared after each utterance)
- Player mic blocked while narrator speaks (UI + server-side audio drop)
- Countdown timer frozen when `isNarratorSpeaking = true`
- Detective investigation result visible in UI
- Bot subtitles shown under their video tile (bot_speak)
- Transcript noise filtering (`ctrl46`, backtick function calls)
- `afterNarratorFinishes()` — phase transitions wait for `turnComplete` (or 15s fallback)
- Timing logs: `[Phase]`, `[Timer]`, `[Narrator]`, `[STT]`

---

## Known bugs 🐛

### CRITICAL: Narrator stops speaking after the first announcement
**Symptoms (from logs):** After the night opening ("The town falls asleep...") the narrator produces no STT during day/voting. Only short vote summaries appear ("Alexa votes for max.") — no dramatic announcements.
**Diagnosis:** `transcript_clear` never reaches the client (`turnComplete` never fires on the server). Every phase ends with `[Timer] Safety reset — narrator never fired turnComplete`. All phase transitions are driven by the 15s fallback, not real `turnComplete`. Likely cause: after `resolve_night` tool call, Gemini does not emit `turnComplete`, or the message field has a different structure than `msg.serverContent?.turnComplete`. **Server-side logs needed.**

### BUG: Safety reset timer fires from the wrong (previous) phase
**Symptoms (from logs):**
```
[Phase] → lobby at T+0
[Timer] FROZEN → lobby
...5s later...
[Phase] → night at T+5
[Timer] FROZEN → night
[Timer] Safety reset ← fires from lobby timer (T+0+20s = T+15s into night!)
[Narrator] SPEAKING start  ← narrator is still speaking!
```
**Cause:** The `setTimeout(20s)` from the previous `phase_changed` is not cancelled when a new one arrives. The lobby timer fires during the night phase and resets `isNarratorSpeaking` while the narrator is still talking.
**Fix:** Store the timer ID in a ref and cancel it before setting a new one.

### BUG: Timer FROZEN set for lobby/role_assignment (unnecessary)
`setNarratorSpeaking(true)` fires on every `phase_changed`, including `lobby` where there is no narrator. This causes stale timers and misleading logs.
**Fix:** Only set `isNarratorSpeaking(true)` for phases that have narrator announcements: `night`, `day`, `voting`, `game_over`.

### FEATURE: Bots don't show text in transcript bar during discussion
**Description:** During day phase bots don't speak (audio not working), but they should display a short text (~3-4 words) in their transcript bar with the name of a suspect and the reason. E.g. "Bruno - acting suspicious".
**Plan:** When a `suspicion_update` event arrives for a bot player, display the `reason` (trimmed to ~4 words) in their video tile for ~4s — same mechanism as normal player transcript. No server changes required.

---

## Todo 📋

| # | Priority | Description | File |
|---|----------|-------------|------|
| 1 | 🔴 CRITICAL | Investigate why `turnComplete` never fires — add server logs to `handleGeminiMessage` to inspect the raw Gemini message structure after a turn ends | `AgentBridge.ts` |
| 2 | 🔴 CRITICAL | Narrator stops speaking after first announcement — diagnose and fix | `AgentBridge.ts`, `GameManager.ts` |
| 3 | 🟡 IMPORTANT | Fix: cancel previous safety timer on new `phase_changed` (use ref) | `socket.ts` |
| 4 | 🟡 IMPORTANT | Fix: only set `isNarratorSpeaking(true)` for phases with narrator (not lobby, role_assignment) | `socket.ts` |
| 5 | 🟢 FEATURE | Bots: show 3-4 word suspicion text in transcript bar based on `suspicion_update` event | `socket.ts`, `VideoGrid.tsx` |
| 6 | 🟢 FEATURE | Timer freeze based on narrator actually finishing speaking (turnComplete), not last text fragment — *already planned, blocked by bug #2* | — |

---

## Reference logs
- `C:\Users\maks2\Desktop\localhost-1774111804906.log` — first logs (ctrl46, function call syntax)
- `C:\Users\maks2\Desktop\localhost-1774112485035.log` — after noise filtering (backtick format identified)
- `C:\Users\maks2\Desktop\localhost-1774133072605.log` — after timer freeze + turnComplete flow implemented (turnComplete never fires)
