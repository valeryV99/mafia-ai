# Mafia AI — Progress

_Based on CONVENTIONS.md._

---

## Step 1 — Lobby

- [x] Players join room (WebSocket `join_room`)
- [x] `+ Add Voice Agent` button adds a voice agent to the Fishjam room
- [x] `Start Game` button disabled until 4 players present
- [x] Players can talk to each other in lobby (mic live)
- [x] Timer: not shown
- [x] Narrator: silent

---

## Step 2 — Role Assignment (`role_assignment`)

- [x] Roles assigned: `Math.floor(n/4)` mafia, 1 detective, 1 doctor, rest civilian
- [x] Each player receives their role privately
- [x] Mic auto-muted on entry, auto-unmuted on exit
- [x] Delay ~3s (dev) / ~5s (prod) before narrator begins
- [x] Timer: not shown
- [x] Narrator: silent

---

## Step 3 — Narrator speaks (transition → Night)

- [x] `phase_changed` night → `isNarratorSpeaking = true` → timer FROZEN
- [x] Narrator speaks: announces night, town falls asleep (2–3 sentences)
- [x] `turnComplete` fires → `isNarratorSpeaking = false` → timer starts
- [x] Safety fallback: timer unfreezes after 15s if `turnComplete` never fires
- [x] Players cannot talk (mic muted or blocked)

---

## Step 4 — Night (`night`)

- [x] Timer starts ONLY after narrator finishes (not on `phase_changed`)
- [x] Timer duration: 45s dev / 90s prod
- [x] NightPanel shows correct action per role (mafia: kill, detective: investigate, doctor: save, civilian: wait)
- [x] No player can target themselves
- [x] After selecting target: confirmation shown
- [x] `checkAllNightActionsComplete()` resolves night early if all special roles acted
- [x] Timer fallback: `resolveNight()` after 45s/90s if not all acted

---

## Step 5 — Night resolution + Narrator speaks (→ Day or Game Over)

- [x] `resolveNight()` applies mafia kill (majority vote, random on tie)
- [x] Doctor blocks kill if same target chosen
- [x] Detective gets investigation result (even if target killed same turn)
- [x] Win condition checked: mafia ≥ civilians → Game Over
- [x] Narrator speaks AFTER resolution (knows the result)
- [x] Timer FROZEN while narrator speaks
- [x] If game continues: narrator announces kill or save (2–3 sentences) → Day
- [x] If mafia wins: narrator announces → Game Over

---

## Step 6 — Day (`day`)

- [x] Timer starts ONLY after narrator finishes
- [x] Timer duration: 80s dev / 120s prod
- [x] Players discuss freely (mic live)
- [x] Narrator silent during discussion
- [ ] If silence > 5s: narrator drops a suspicion hint
- [x] Timer expires → voting starts automatically

---

## Step 7 — Narrator speaks (transition → Voting)

- [x] Timer FROZEN while narrator speaks (voting timer deferred via pendingPhaseTransition)
- [x] Narrator announces voting, calls each player by name
- [ ] Players cannot talk (mic muted or blocked)
- [x] `turnComplete` → timer starts

---

## Step 8 — Voting (`voting`)

- [x] Timer starts ONLY after narrator finishes (deferred via pendingPhaseTransition + 30s safety fallback)
- [x] Timer duration: 40s dev / 60s prod
- [x] Players vote by clicking a player tile
- [ ] Players can talk during voting
- [x] All votes cast → `resolveVotes()` immediately
- [x] Timer expires → `resolveVotes()` automatically
- [x] Tie → random among tied players

---

## Step 9 — Elimination resolution + Narrator speaks (→ Night or Game Over)

- [x] `resolveVotes()` eliminates player (or nobody if no votes)
- [x] Win condition checked: mafia ≥ civilians OR all mafia dead
- [x] Narrator speaks AFTER resolution
- [x] Timer FROZEN while narrator speaks
- [x] If game continues: narrator announces elimination + night intro → Night
- [x] If game over: narrator announces → Game Over
- [x] Eliminated player shown with gray tile in VideoGrid

---

## Step 10 — Game Over (`game_over`)

- [x] Narrator announces winner dramatically
- [x] Timer: not shown
- [ ] Narrator responds if players speak to them

---

## Night Rules

- [x] Doctor + Mafia target same person → Doctor blocks the kill
- [x] Detective investigates someone killed same turn → result still delivered
- [x] Multiple mafia members: majority vote wins, random on tie
- [x] No player may target themselves during Night or Voting

---

## AI Agent Communication Rules

- [ ] Agents only speak during Lobby, Day, and Voting phases (silent at Night and Role Assignment)
- [ ] Agent responds only when addressed directly by name
- [ ] Group command (e.g. "Everyone, answer") → each agent responds in turn with 1–2 sentences

---

## Audio / Tech invariants

- [x] GameMaster bridge only forwards audio from human peers (whitelist)
- [x] VoiceAgent bridge only forwards audio from human peers (whitelist)
- [ ] No 1008 Policy Violation during normal gameplay
- [ ] `turnComplete` fires reliably after each narrator speech
- [ ] Narrator never interrupted mid-sentence by a server timeout

---

## Known Bugs

- [x] **Bots do not always vote** — FIXED: added retry at 10s + auto-fallback vote at 20s for bots that don't respond
- **Game Master issues**:
  - [ ] sometimes can stop answering or the audio cuts off at the end (added logging to diagnose)
  - [ ] sometimes dont fire turnComplete, so the safety fallback triggered (added logging to diagnose)
- **Special roles — FIXED**:
  - [x] Mafia cannot kill — FIXED: added bot mafia 15s fallback (was missing, only detective/doctor had fallback) + retry at 8s
  - [x] Detective receives no information — FIXED: bot detectives now receive investigation result via sendSilentContext (was only WebSocket which bots don't have)
  - [x] Doctor probably cannot heal — FIXED: resolveNight() doctor save logic verified working + added bot doctor 15s fallback
- **Diagnostics added**:
  - [x] Comprehensive logging: phase transitions, bot instructions, tool calls, vote tallies, night resolution, Gemini session health, turnComplete tracking