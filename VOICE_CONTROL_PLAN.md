# Voice-Control Migration Plan

_Goal: Players control all game actions (night kills, investigate, heal, voting) entirely by voice.
AI agents (Marcus, Sophie, Rex) only speak when a human player directly addresses them by name._

---

## 1. Current State vs Target State

| Action | Current | Target |
|---|---|---|
| Mafia kill | Click button in NightPanel | Speak target name → GM calls `night_kill` |
| Detective investigate | Click button in NightPanel | Speak target name → GM calls `investigate` |
| Doctor save | Click button in NightPanel | Speak target name → GM calls `doctor_save` |
| Vote | Click player tile in VotePanel | Speak target name → GM calls `cast_vote` |
| AI agent speech | Round-robin chain (auto fires) | Only when addressed by exact name |

---

## 2. Architecture Overview (What Changes, What Stays)

**Does NOT change:**
- WebSocket events (`night_action`, `cast_vote`, `investigation_result`) — server logic is unchanged
- `handleGeminiCommand()` routing on the server — GM tool calls flow through unchanged
- `AgentBridge`, `VoiceAgent`, Fishjam/Gemini plumbing
- Night resolution, voting resolution, win conditions
- The NightPanel and VotePanel components — demoted to **read-only visual feedback** (show what was submitted, but no clickable buttons)

**Does change:**
1. **GM system prompt** (`prompts.ts`) — must actively solicit night actions from human special-role players; must call `address_agent` when an agent is addressed
2. **GM `[SYSTEM]` messages** in `GameManager.ts` (`startNight`, `startVoting`) — must tell GM which players are human so it knows who to solicit
3. **VoiceAgent prompt** (`VoiceAgent.ts`) — remove "react to the discussion" auto-speak; add "silent unless addressed by your exact name"
4. **Agent chain system** (`GameManager.ts`) — replace round-robin auto-chain with name-triggered unmute via new `address_agent` tool
5. **New tool: `address_agent`** — GM declares which agent to unmute; server unmutes that agent's input+output for one response

---

## 3. Night Phase — Voice Action Flow

### Problem: Night Privacy
During night, mics are currently muted to all players. If we unmute a player to receive their voice command, other players could hear them say "I kill Marcus", breaking the secrecy.

**Three options — pick one before implementing:**

**Option A — Trust Model (simplest, no code changes to audio routing)**
- Human special-role players are asked to act via a silent context message (not spoken aloud by GM)
- Client shows a text prompt: *"Your mic is live. Speak your target name quietly."*
- Player's mic is unmuted only to the GM bridge (Fishjam SFU still routes their audio to the agent track), but the **client UI mutes playback from other participants** during this window so the room is silent
- Other players can theoretically hear, but this is accepted as a game trust rule (same as closing eyes in physical Mafia)
- **Easiest to implement** — requires only prompt + mic control changes on client

**Option B — Per-Role Mic Window (medium complexity)**
- During night, each special-role player gets a brief "action window":
  1. Client receives a `night_action_prompt` WS event (`{ playerId, role }`) telling them it's their turn
  2. Client unmutes their mic for 15 seconds (Fishjam sends their audio; others receive it but clients suppress playback of others during night anyway)
  3. GM hears the name, calls the tool, server sends `night_action_received` to close the window
- Other players' clients already don't play night audio (enforced client-side), so privacy is maintained by client suppression

**Option C — Server-Side Audio Route (most private, most complex)**
- Add a separate WebSocket audio channel: client streams mic audio to server during their action window
- Server sends this audio to a dedicated Gemini session for intent extraction
- No Fishjam routing needed for the action; completely private
- Overkill for a prototype — not recommended

**Recommendation: Option B.** It reuses existing mic infrastructure and gives a clear UX signal to the player. The "others hear night audio" problem is already solved by the existing client-side night audio suppression.

### New Night Flow (after choosing Option B)

```
startNight() system message to GM:
  "[SYSTEM] Night begins. Human special-role players will act in sequence.
   Human mafia: [names]. Human detective: [name or NONE]. Human doctor: [name or NONE].
   Bot roles are handled automatically — do NOT address them.
   For each human special-role player: wait for server to send you
   [SYSTEM] <name> is ready to act. Then call the appropriate tool as soon as you hear a target name.
   Do NOT ask them verbally. Stay silent and listen only."

Server sends [SYSTEM] <name> is ready to act → via sendSilentContext after client confirms window open.
GM listens, hears name spoken, calls night_kill / investigate / doctor_save.
```

**Changes needed:**
- `GameManager.ts` → `startNight()`: update system message to list human vs bot roles
- `GameManager.ts` → after `doStartGame()` night entry: add logic to open per-player action windows sequentially
- New WS event `night_action_prompt` → client (tells player to speak)
- New WS event `night_action_received` → client (closes mic window)
- Client `RoomPage.tsx`: handle `night_action_prompt`, briefly unmute mic, show UI hint
- `prompts.ts`: rewrite Night Phase section (see Section 6)

---

## 4. Voting Phase — Voice Vote Flow

### Current Behavior
GM asks each player by name (it's in the prompt), waits for spoken answer, calls `cast_vote`.
This is **already mostly right** but the prompt doesn't enforce "call cast_vote IMMEDIATELY on hearing a name" strictly enough, and the transcript fallback only handles bot votes.

### New Voting Flow
```
GM: "Alex — who do you vote to eliminate? Say the name."
[waits, hears "Marcus"]
GM: calls cast_vote({ voter: "Alex", target: "Marcus" })

GM: "Jordan — your vote. Who should go?"
[waits, hears "Marcus"]
GM: calls cast_vote({ voter: "Jordan", target: "Marcus" })
... continues for all alive players
```

**Changes needed:**
- `prompts.ts`: strengthen voting section — GM must go through each alive human player one by one; call `cast_vote` immediately; don't move to next player until current vote is recorded
- `GameManager.ts` → `startVoting()` system message: provide ordered list of alive HUMAN players (bots handled automatically by server) explicitly
- `handleGeminiCommand()` → `cast_vote`: already works; no change needed
- **Transcript fallback** (`handleGeminiTranscript`): extend the voting fallback to also cover human players, not just bots (currently line 887: `for (const bot of ...)` — remove the bot-only filter)
- VotePanel: remove click handler, keep only as visual "vote status" display

---

## 5. AI Agent Turn-Taking — New Model

### Current (Broken for Voice-Only)
`advanceAgentChain()` auto-advances through Marcus → Sophie → Rex → Marcus on a round-robin whenever an agent's `onTurnComplete` fires. Each agent is told `"It's your turn to speak. React to the ongoing discussion."` This means agents speak constantly, interrupting human discussion.

### New Model: Name-Triggered Response

**Invariant:** All agents are muted (input + output) at the start of Day and Voting. They only unmute when the GM calls `address_agent`.

**Flow:**
```
Human player: "Marcus, what do you think about Jordan?"
GM hears this → detects "Marcus" was addressed → calls address_agent({ name: "Marcus" })

Server receives address_agent:
  → mutes all other agents
  → unmutes Marcus (input + output)
  → sends Marcus: "[GAME] You were addressed. Respond in 1-2 sentences. Then stop."

Marcus speaks (1-2 sentences)
Marcus's onTurnComplete fires → server mutes Marcus again → GM takes back the floor
```

**Group command case** (e.g., "Everyone, what do you think?"):
```
GM calls address_agent({ name: "Marcus" })
Marcus speaks, goes silent
GM calls address_agent({ name: "Sophie" })
Sophie speaks, goes silent
GM calls address_agent({ name: "Rex" })
Rex speaks, goes silent
```

### Changes needed:

**New tool definition** (add to GM's tool list in `GameManager.ts` line ~359):
```typescript
{
  name: 'address_agent',
  description: 'Unmute a specific AI agent so they can respond. Use when a player addresses an agent by name.',
  parameters: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'The agent name to unmute (Marcus, Sophie, or Rex)' }
    },
    required: ['name']
  }
}
```

**New handler** in `handleGeminiCommand()` (new case):
```typescript
case 'address_agent': {
  const agentName = cmd.name as string
  const agent = this.voiceAgents.get(agentName)
  if (!agent) break
  // Mute all agents first
  this.voiceAgents.forEach(a => { a.setMuteInput(true); a.setMuteOutput(true) })
  // Unmute targeted agent
  agent.setMuteInput(false)
  agent.setMuteOutput(false)
  agent.sendContext('[GAME] You were addressed. Respond in 1-2 sentences then stop.')
  this.log('voiceAgent', `address_agent: ${agentName} unmuted`)
  break
}
```

**Remove** `startAgentOutputChain()` auto-trigger from Day/Voting phase entry points — agents start muted and only respond to `address_agent`.

**`advanceAgentChain()`**: replace with simple mute-on-complete:
```typescript
private onAgentTurnComplete(name: string) {
  // Mute agent that just finished
  const agent = this.voiceAgents.get(name)
  if (agent) { agent.setMuteInput(true); agent.setMuteOutput(true) }
  this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
  // Notify GM the agent has finished
  this.bridge?.sendSilentContext(`[SYSTEM] ${name} has finished speaking.`)
}
```

**`VoiceAgent.ts` prompt change** (see Section 6).

---

## 6. Prompt Changes

### 6a. Game Master System Prompt (`prompts.ts`)

**Night Phase section — replace current with:**
```
## NIGHT PHASE

NEVER say anyone's role out loud.

1. Announce night dramatically (2-3 atmospheric sentences). Do NOT address any player by name or role.
2. Go completely silent. The server will notify you when each human role is ready to act.
3. When you receive [SYSTEM] <name> is ready to act — listen silently for them to speak a target name.
   The moment you hear any valid player name, IMMEDIATELY call the correct function:
   - If they are Mafia: call night_kill({ target: "<name>", voter: "<their name>" })
   - If they are Detective: call investigate({ target: "<name>", voter: "<their name>" })
   - If they are Doctor: call doctor_save({ target: "<name>", voter: "<their name>" })
   Then narrate one brief atmospheric line (e.g. "A shadow passes in silence..."). No names, no roles.
4. Bot actions are handled by the server — you will receive [SYSTEM] notifications. Narrate atmosphere only.
5. When [SYSTEM] says all roles have acted: call resolve_night immediately.

RULES:
- Never say who was targeted, who acted, or reveal any role.
- If a player says a name not in the player list, ask them once to repeat clearly.
- Never call resolve_night unless all human roles have acted OR server explicitly says to.
```

**Day Phase section — add:**
```
## DAY PHASE

1. Announce what happened (death or save) dramatically. Keep it 2-3 sentences.
2. Then open discussion. Address each player by name, ask their opinion, STOP and WAIT for their response.
3. Call update_suspicion after each player speaks.
4. When a player says another agent's name (Marcus, Sophie, Rex), call address_agent({ name: "<agent name>" }).
   Wait for the agent to finish before continuing.
5. Only call start_voting after at least 30 seconds of discussion have passed.
```

**Voting Phase section — replace current with:**
```
## VOTING PHASE

Go through each alive HUMAN player in order. For each one:
1. Say: "[Name] — who do you vote to eliminate? Say the name."
2. STOP TALKING completely and wait for them to speak a name.
3. The moment you hear a valid player name, call cast_vote({ voter: "[Name]", target: "<heard name>" }).
4. Say briefly "Noted." and move to the next player.
Bot players' votes are handled automatically by the server.
Do NOT move to the next player until the current player's vote is recorded (or they stay silent for 10 seconds).
```

**New section — `address_agent` usage:**
```
## AI AGENT INTERACTION

When you detect that a human player has addressed one of the AI agents by exact name (Marcus, Sophie, Rex):
- Call address_agent({ name: "<agent name>" }) IMMEDIATELY.
- Do not speak while the agent is responding.
- When you receive [SYSTEM] <name> has finished speaking, resume hosting.
- For group commands ("everyone" / "all of you"), call address_agent for each agent in sequence,
  waiting for [SYSTEM] finished between each one.
```

### 6b. VoiceAgent System Prompt (`VoiceAgent.ts`)

**Replace the current TOOLS USAGE + speaking behavior with:**
```
SPEAKING RULES:
- You are SILENT by default. Never speak unless you have been explicitly activated.
- You will be activated when a human player says your exact name (${this.name}).
- When activated, respond in 1-2 short sentences that fit your personality. Then stop talking.
- Do NOT continue speaking after your response. Do NOT ask follow-up questions.
- If you are not activated, do not react to anything you hear — stay completely silent.

TOOLS USAGE:
- Call tools ONLY when a [GAME] message explicitly instructs you to. Never call tools proactively.
- 'night_kill': only when [GAME] tells you to (Mafia only).
- 'investigate': only when [GAME] tells you to (Detective only).
- 'doctor_save': only when [GAME] tells you to (Doctor only).
- 'cast_vote': only when [GAME] tells you to vote.
```

---

## 7. Client Changes

### NightPanel (`features/night-action/ui/NightPanel.tsx`)
- Remove all click handlers
- Show the selected target (received from server via `night_action_received` or `game_state`) as read-only confirmation
- Show a mic indicator when player's action window is open (`night_action_prompt` event received)
- Text: *"Speak the name of your target..."*

### VotePanel (`features/vote/ui/VotePanel.tsx`)
- Remove click handlers
- Keep as visual vote tracker: show who has voted (the `vote_cast` broadcast event already provides this)
- Optionally show a mic indicator during voting if it's the current player's turn

### New WS events to handle on client:
```typescript
// Server → Client
{ type: 'night_action_prompt', role: 'mafia' | 'detective' | 'doctor' }
// Tells this player it's their turn to speak their night action. Client unmutes mic briefly.

{ type: 'night_action_received' }
// Server confirmed the action was recorded. Client mutes mic again, shows confirmation.
```

---

## 8. Server Changes Summary

### `GameManager.ts`

| Location | Change |
|---|---|
| Tool definitions (~line 199 area, GM tools) | Add `address_agent` tool |
| `handleGeminiCommand()` | Add `case 'address_agent'` handler |
| `startNight()` system message | List human vs bot roles explicitly; describe per-player action window flow |
| `startVoting()` system message | List alive human players explicitly in order; instruct GM to go through them one by one |
| `advanceAgentChain()` | Replace with `onAgentTurnComplete()` that just mutes the agent and notifies GM |
| `startAgentOutputChain()` call sites in Day/Voting | Remove or guard behind a "never auto-start" flag |
| New method | `openNightActionWindow(playerId)` — sends `night_action_prompt` to client, sends `[SYSTEM] <name> is ready to act` to GM |
| New method | `closeNightActionWindow(playerId)` — sends `night_action_received` to client |

### `GameManager.ts` — `handleNightAction()` callback from tool
When `night_kill`/`investigate`/`doctor_save` is processed:
- Call `closeNightActionWindow(player.id)` for the acting player
- Proceed to next human special role if any (call `openNightActionWindow` for them)

### `prompts.ts`
- Rewrite Night, Day, Voting, and add `address_agent` sections as described in Section 6a

### `VoiceAgent.ts`
- Replace speaking/tools prompt section as described in Section 6b

---

## 9. New WebSocket Event Types (`packages/types/src/index.ts`)

```typescript
// Server → specific client
{ type: 'night_action_prompt'; role: 'mafia' | 'detective' | 'doctor' }
{ type: 'night_action_received' }
```

---

## 10. What Stays as Keyboard Fallback

The existing keyboard/click flow should remain as a **fallback**, not removed:
- `night_action` WebSocket event handler on server stays
- `cast_vote` WebSocket event handler on server stays
- NightPanel and VotePanel can optionally keep clickable buttons behind a dev-mode flag

This lets us test and recover if the voice flow misfires.

---

## 11. Implementation Order

1. **Prompt changes only** — no code changes. Re-test GM behavior in night and voting.
   - Update `prompts.ts` (Night, Day, Voting, address_agent sections)
   - Update `VoiceAgent.ts` prompt
   - Goal: verify GM already mostly handles voice actions with better prompting alone

2. **`address_agent` tool** — server + GM prompt.
   - Add tool definition in `GameManager.ts`
   - Add `case 'address_agent'` in `handleGeminiCommand()`
   - Replace `advanceAgentChain()` with mute-on-complete
   - Remove auto-chain start from Day/Voting
   - Goal: agents only speak when addressed

3. **Night action window** — per-player mic window.
   - New WS events `night_action_prompt` / `night_action_received`
   - `openNightActionWindow` / `closeNightActionWindow` on server
   - Client handles events: unmutes mic, shows hint
   - Update `startNight()` system message

4. **Demote UI panels to read-only**
   - Remove click handlers from NightPanel and VotePanel
   - Add mic-active indicator on NightPanel

5. **Extend transcript fallback** for human vote detection
   - Remove bot-only filter in voting transcript fallback

---

## 12. Open Questions Before Starting

1. **Night privacy (Option A vs B vs C):** Option B is recommended. Confirm before implementing Step 3.
2. **Agent activation confirmation UX:** When GM calls `address_agent("Marcus")`, should the client show a visual indicator that Marcus is "live"? Probably yes — reuse the existing `speaker_changed` event.
3. **Voting order:** Should GM go through players in lobby join order, or does the server dictate order? Server should send the ordered list in the `startVoting()` system message to make it deterministic.
4. **Silence timeout during voting:** If a player doesn't vote within 10 seconds, GM should skip them and server records no vote (existing timeout already handles this at the global level — but per-player timeout is new).
