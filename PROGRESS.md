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
- [ ] Timer: not shown
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
- [ ] `checkAllNightActionsComplete()` resolves night early if all special roles acted
- [ ] Timer fallback: `resolveNight()` after 45s/90s if not all acted

---

## Step 5 — Night resolution + Narrator speaks (→ Day or Game Over)

- [ ] `resolveNight()` applies mafia kill (majority vote, random on tie)
- [ ] Doctor blocks kill if same target chosen
- [ ] Detective gets investigation result (even if target killed same turn)
- [x] Win condition checked: mafia ≥ civilians → Game Over
- [ ] Narrator speaks AFTER resolution (knows the result)
- [ ] Timer FROZEN while narrator speaks
- [ ] If game continues: narrator announces kill or save (2–3 sentences) → Day
- [ ] If mafia wins: narrator announces → Game Over

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

- [ ] Timer FROZEN while narrator speaks
- [ ] Narrator announces voting, calls each player by name
- [ ] Players cannot talk (mic muted or blocked)
- [x] `turnComplete` → timer starts

---

## Step 8 — Voting (`voting`)

- [ ] Timer starts ONLY after narrator finishes
- [x] Timer duration: 40s dev / 60s prod
- [x] Players vote by clicking a player tile
- [ ] Players can talk during voting
- [ ] All votes cast → `resolveVotes()` immediately
- [ ] Timer expires → `resolveVotes()` automatically
- [x] Tie → random among tied players

---

## Step 9 — Elimination resolution + Narrator speaks (→ Night or Game Over)

- [x] `resolveVotes()` eliminates player (or nobody if no votes)
- [x] Win condition checked: mafia ≥ civilians OR all mafia dead
- [x] Narrator speaks AFTER resolution
- [x] Timer FROZEN while narrator speaks
- [ ] If game continues: narrator announces elimination + night intro → Night
- [ ] If game over: narrator announces → Game Over
- [x] Eliminated player shown with gray tile in VideoGrid

---

## Step 10 — Game Over (`game_over`)

- [ ] Narrator announces winner dramatically
- [ ] Timer: not shown
- [ ] Narrator responds if players speak to them

---

## Night Rules

- [ ] Doctor + Mafia target same person → Doctor blocks the kill
- [ ] Detective investigates someone killed same turn → result still delivered
- [ ] Multiple mafia members: majority vote wins, random on tie
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

- [ ] **Bots do not always vote** — agents often fail to cast a vote during Voting even when prompted (often problems with agent Rex)
- **Game Master issues**:
  - [ ] sometimes can stop answering or the audio cuts off at the end
  - [ ] sometimes dont fire turnComplete, so the safety fallback triggered
- **Special roles is not working**:
  - [ ] Mafia cannot kill
  - [ ] Detective receives no information about person he/she investigates
  - [ ] Doctor probably cannot heal (not tested)