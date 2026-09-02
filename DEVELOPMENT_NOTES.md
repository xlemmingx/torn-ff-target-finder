# Development Notes — Torn FF Target Finder

## Goal

One-click loading of an inactive, actually attackable player within a chosen fair-fight
range — like ffscouter.com's target finder, but as a small button inside the Torn frontend.
Must stay light on API requests (FFScouter and Torn both have limits, and the same key is
used for other tools).

## Data sources

### FFScouter `GET /api/v1/get-targets` (limit 5/min)
Returns candidates within an FF range. Used fields: `player_id`, `name`, `level`,
`fair_fight`, `last_action`, `bs_estimate_human`. Params used: `key`, `minff`, `maxff`,
`inactiveonly=1`, `limit=50`, optional `minlevel`/`maxlevel`.

Key insight: results are sorted by battle stats descending, so a **fixed** range always
returns the same top 50 → wasteful repeated status checks. Mitigation: split the range into
small **FF sub-windows** (`ffWindow`, default 0.3) and walk the full range with a cursor plus
a little jitter. Each fetch hits a different slice → fresh targets. Verified: sub-windows
1.5–1.8, 1.8–2.1, 2.1–2.4 return disjoint player sets.

### Torn `GET /v2/user/{id}?selections=profile` (limit ~100/min)
`get-targets` does not tell us if a player is currently attackable, so each candidate is
verified against Torn. Used fields: `status.state` (`Okay`/`Hospital`/`Traveling`/`Jail`/…),
`status.until` (hospital end), `last_action.timestamp`. Only `state === "Okay"` and still
inactive is considered attackable.

The same key works for both services (the FFScouter key *is* a Torn key).

## Rate-limit strategy

- **Inactivity filtered client-side first** from `get-targets`' `last_action` → only promising
  candidates cost a Torn request.
- **1 Torn check per tick** (`tickMs`, default 3000 ms ≈ 20/min) → lots of headroom for other
  API use. Configurable.
- **get-targets** only every ≥15 s and only when the ready queue is under `desiredReady`.
- **Ready queue** of verified targets is kept warm: entries are re-verified after ~60 s and
  dropped/re-checked after ~120 s, so a click serves a recently confirmed "Okay" target.
- Cooldowns: attacked target 15 min, hospital until `status.until`, other non-Okay 10 min.
- Torn error 5 (too many requests) → candidate put back + brief backoff.

Everything (pool, ready queue, cooldowns, FF cursor, position) is persisted via
`GM_setValue` and survives reloads.

## Attack endpoint

The old `loader.php?sid=attack&user2ID=` is deprecated (`"This endpoint is no longer
available. Please use the new endpoints instead (page.php)."`). Current endpoint:
`https://www.torn.com/page.php?sid=attack&user2ID=<id>`.

## Cross-platform (Tampermonkey + Torn PDA)

- **HTTP**: `GM_xmlhttpRequest` (bypasses CSP, available in both) with a `fetch` fallback.
  Both APIs send `Access-Control-Allow-Origin: *`, and Torn has no restrictive `connect-src`,
  so `fetch` also works if GM is unavailable.
- **Storage**: `GM_getValue`/`GM_setValue`; Torn PDA backs these with **synchronous**
  localStorage, matching the synchronous usage here.
- **API key on Torn PDA**: the `###PDA-APIKEY###` placeholder is replaced by the app with the
  configured key at injection time. If the key field is left empty, that injected key is used;
  in other managers the placeholder is detected and ignored.
- **Dragging** uses pointer events with `touch-action:none` so it works on touch. The whole
  attack button is the drag handle: a press under a 5 px threshold is a click (attack), a
  larger move repositions and saves the position.

## UI decisions

- Deliberately minimal and unobtrusive: small flat buttons (red attack button + grey gear),
  no status text overlay — the number on the button is the only feedback.
- Badge shows the count of currently available (verified, not-in-cooldown) targets; green when
  > 0.

## Feature ideas (later)

- Target list in the panel: next N ready targets with individual attack links.
- Respect/profit sorting of the ready queue instead of FF/level.
- Chain/war mode: more aggressive refilling + auto-skip of targets someone else is attacking.
- Blacklist/whitelist for individual players or factions.
- Notify (sound/badge blink) when a target becomes ready again after an empty queue.
- Attack/hit statistics.
- Multiple toggleable presets ("respect farm" vs. "quick hits").
- In-page integration instead of a new tab: detect the attack result and suggest the next
  target automatically.
- "Reset position" button in settings.
