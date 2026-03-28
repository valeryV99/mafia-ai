# Mafia AI — Game Conventions

## Players

- **Human players** — join via browser, communicate via voice (Fishjam WebRTC)
- **AI Voice Agent (Alex)** — joins Fishjam as a real audio participant, speaks and listens like a human
- **Game Master (Narrator)** — AI agent (Gemini Live via AgentBridge), speaks aloud, manages flow

## Roles

- `civilian` — no special ability
- `mafia` — kills at night
- `detective` — investigates at night
- `doctor` — saves at night

---

## Game Rules

- 4 players is the minimum to start a game, otherwise the "Start game" button must be disabled
- Number of roles per game:
  - Mafia: Math.floor(playerCount / 4)
  - Detective: 1
  - Doctor: 1
  - Civilian: playerCount - mafiaCount - 2

---

## Game Flow

### 1. Lobby

- Players join the room
- Host can add Voice Agent (`+ Add Voice Agent`) — joins as audio participant
- Host clicks `Start Game` when ready
- Players can talk to each other
- **Timer: none**
- **Narrator: silent**

### 2. Role Assignment (`role_assignment`)

- Roles assigned randomly
- Each player receives their role privately
- Short delay (~3s dev / ~5s prod) so players can digest their assigned role before the narrator begins
- Players cannot talk to each other
- **Timer: none**
- **Narrator: silent**

### 3. Narrator speaks (transition → Night)

- Timer set to the duration needed for the **Night** phase
- **Timer: FROZEN** while narrator speaks
- Narrator speaks: announces night, describes town falling asleep (2–3 sentences)
- Players cannot talk to each other

### 4. Night (`night`)

- after narrator finishes → **Timer: STARTS AND RUNNING TO 0**
- Timer duration: 45s (dev) / 90s (prod)
- Mafia — chooses who to kill, Detective — chooses whose role they want to see, Doctor — chooses who to protect (blocking a mafia kill if that person is targeted)
- Mafia, Detective, and Doctor may choose not to act. In that case they must wait for the timer to expire
- after timer expires or all special roles act → night resolves, flow continues to Step 5

### 5. Night resolution + Narrator speaks (transition → Day or Game Over)

- Server resolves night actions, then checks win condition
- **Win condition checked** — if mafia ≥ civilians, mafia wins
- Narrator speaks only after night is already resolved (narrator already knows the result)

- If the game can continue:
  - Players cannot talk to each other
  - Timer set to the duration needed for the **Day** phase
  - **Timer: FROZEN** while narrator speaks
  - Narrator speaks: announces day, summarizes the night: whether anyone was killed or saved by the Doctor (2–3 sentences)

- If Mafia won:
  - Players cannot talk to each other
  - Timer set to 0 (meaning the timer is no longer needed, as the game will end)
  - **Timer: FROZEN** while narrator speaks
  - Narrator speaks: summarizes the night (1–2 sentences) + transitions to the **Game Over** phase

### 6. Day (`day`)

- after narrator finishes → **Timer: STARTS AND RUNNING TO 0**
- Timer duration: 80s (dev) / 120s (prod)
- Players discuss freely (voice)
- Narrator stays silent, but if silence lasts longer than 5 seconds, they encourage conversation by dropping suspicions about someone (or something along those lines)
- when timer expires → voting starts

### 7. Narrator speaks (transition → Voting)

- Timer set to the duration needed for the **Voting** phase
- **Timer: FROZEN** while narrator speaks
- Narrator speaks: announces voting, calls each player by name to vote
- Players cannot talk to each other

### 8. Voting (`voting`)

- after narrator finishes → **Timer: STARTS AND RUNNING TO 0**
- Timer duration: 40s (dev) / 60s (prod)
- Players vote by clicking on the desired player from the player list
- Players can talk to each other
- When all votes cast → `resolveVotes()`
- If timer expires → `resolveVotes()` automatically
- If there is a tie, the eliminated player is chosen randomly among the tied players

### 9. Elimination resolution + Narrator speaks (transition → Night or Game Over)

- Server resolves votes, eliminates player (if any), then checks win condition
- **Win condition checked** — if mafia ≥ civilians or all mafia are dead
- Narrator speaks only after elimination is already resolved (narrator already knows the result)

- If the game can continue:
  - Players cannot talk to each other
  - Timer set to the duration needed for the **Night** phase
  - **Timer: FROZEN** while narrator speaks
  - Narrator speaks: nobody was eliminated or who was eliminated and their role (1–2 sentences) + announces night, describes town falling asleep

- If Mafia won or lost:
  - Players cannot talk to each other
  - Timer set to 0 (meaning the timer is no longer needed, as the game will end)
  - **Timer: FROZEN** while narrator speaks
  - Narrator speaks: nobody was eliminated or who was eliminated and their role (1–2 sentences) + transitions to the **Game Over** phase

### 10. Game Over (`game_over`)

- Narrator announces the winner dramatically if mafia ≥ civilians (mafia wins), OR announces the winner proudly if all mafia are dead (civilians win)
- **Timer: none**
- **Narrator: speaks if someone asks them something**

---

## Narrator Rules

- Narrator speaks as a **separate transition step** before each phase (night, day, voting, game_over) — not at the start of the phase itself
- **Timer is FROZEN** while narrator speaks
- Timer unfreezes when `turnComplete` fires from Gemini
- Safety fallback: timer unfreezes after 15s on client if `turnComplete` never fires
- Phase transitions happen **after narrator finishes** (`turnComplete`), not on a fixed timer
- Server timeout is a fallback only — never interrupts narrator mid-sentence

## Timer Rules

- Timer is **client-side only** — visual indicator, not authoritative
- Timer freezes during narrator speech, resumes after `turnComplete`
- When timer hits 0 on client → server timeout fires server-side (roughly same time)

## Audio Rules

- GameMaster AgentBridge: only forwards audio from **registered human peers** (whitelist)
- VoiceAgent AgentBridge: only forwards audio from **registered human peers** (whitelist)
- No agent listens to another agent's audio — prevents feedback loops
- `mapFishjamPeer()` registers a human peer with all active bridges
- VoiceAgent added before game start → gets human peers registered at join time

## Night Rules

- if the Doctor and Mafia target the same person → the Doctor blocks the kill
- if the Detective investigates someone who is being killed in the same turn → they receive the result of who that person was
- if multiple mafia members choose different players, the vote falls on the player with the most votes, or in case of a tie, one is chosen randomly
- no player, regardless of role, may target themselves during the Night phase or Voting

## Known Limitations

- Night actions UI (mafia kill, detective investigate, doctor save)
- Gray tile / visual indicator for eliminated players
- Preparation phase between lobby and night
- Bot and user transcript bar on UI