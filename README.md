# Torn FF Target Finder (Tampermonkey / Torn PDA)

Finds inactive, attackable targets within a chosen fair-fight range — similar to the target
finder on ffscouter.com, but right inside the Torn frontend as a button.

## How it works

1. **FFScouter `get-targets`** (limit 5/min) returns candidates in your FF range including
   `fair_fight`, `level` and `last_action`. Inactivity is filtered client-side first → saves
   Torn requests.
   FFScouter sorts within the range by battle stats descending, so a fixed range would always
   return the same top 50. To avoid that, the worker splits the range into small **FF
   sub-windows** and walks the whole range with a cursor plus a little jitter → every request
   brings fresh targets instead of duplicates.
2. **Torn `user/{id}?selections=profile`** (limit 100/min) verifies the real status in the
   background (`Okay`/`Hospital`/`Traveling`/`Jail`/…). Only `Okay` + still inactive goes into
   the **ready queue**.
3. Clicking **⚔ Attack** opens the attack page of the freshest verified target. The worker
   refills in parallel so you can attack in quick succession.

Everything (candidates, ready queue, cooldowns) is persisted via `GM_setValue` and survives
reloads. A single key is used for both FFScouter **and** Torn.

## Installation

### Tampermonkey (desktop)

1. Install Tampermonkey.
2. Add `torn-ff-target-finder.user.js` as a new script.
3. On torn.com open the ⚙ (bottom/top corner), enter your **API key**, set the FF range.

### Torn PDA (mobile)

Torn PDA ships a built-in GM compatibility layer, so the same script runs there.

1. Torn PDA → Settings → **Userscripts** → add script (paste or via URL).
2. **API key:** you can leave the key field empty — Torn PDA injects the app's configured
   API key automatically (via the `###PDA-APIKEY###` placeholder). Or enter a key explicitly.
3. Note: the button is draggable via the ⠿ grip (touch works).

## Settings

| Option | Meaning |
|---|---|
| API Key | Torn API key (same key registered with FFScouter). Empty on Torn PDA = app key. |
| Min/Max FF | Fair-fight range of candidates |
| Min/Max level | optional level bounds (0 = any) |
| Inactive ≥ (days) | `last_action` must be at least this old |
| Ready buffer | how many verified targets to keep ready (raise it for more than 8) |
| Check interval | delay between Torn status checks (3000 ms ≈ 20/min, gentle) |
| Open attack in new tab | open attack page in a new tab instead of the current one |
| Background worker | verification on/off |

## Rate-limit behaviour

- get-targets only every ≥15 s and only when the ready queue is below target.
- 1 Torn check per tick (default every 3 s ≈ 20/min) → plenty of headroom for other API use.
- Torn error 5 (too many requests) → candidate put back + brief backoff.
- Attacked targets: 15 min cooldown, hospital until `status.until`, other non-Okay 10 min.

## Cross-platform notes

- HTTP uses `GM_xmlhttpRequest` (bypasses CSP, works in Tampermonkey and Torn PDA) with a
  `fetch` fallback — both APIs send `Access-Control-Allow-Origin: *`.
- Storage uses `GM_getValue`/`GM_setValue`, which Torn PDA backs with synchronous localStorage.
- Attack link uses the current `page.php?sid=attack` endpoint (old `loader.php?sid=attack` is
  deprecated).

See [DEVELOPMENT_NOTES.md](DEVELOPMENT_NOTES.md) for design details and planned features.
