// ==UserScript==
// @name         Torn FF Target Finder
// @namespace    https://github.com/xlemmingx/torn-ff-target-finder
// @version      1.0.0
// @description  Finds inactive, attackable targets in your fair-fight range via the FFScouter API and verifies them against the Torn API in the background. One click = next attackable target. Works in Tampermonkey and Torn PDA.
// @author       xlemmingx [2035104]
// @downloadURL  https://raw.githubusercontent.com/xlemmingx/torn-ff-target-finder/master/torn-ff-target-finder.user.js
// @updateURL    https://raw.githubusercontent.com/xlemmingx/torn-ff-target-finder/master/torn-ff-target-finder.user.js
// @match        *://*.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ffscouter.com
// @connect      api.torn.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------
    const DEFAULT_CONFIG = {
        apiKey: '',           // Torn API key (= FFScouter key). Empty on Torn PDA = use app key.
        minFF: 1.5,           // Fair-fight lower bound
        maxFF: 3.0,           // Fair-fight upper bound
        minLevel: 0,          // 0 = any
        maxLevel: 0,          // 0 = any
        inactiveDays: 7,      // last_action must be at least this many days ago
        desiredReady: 8,      // how many verified-attackable targets to keep ready
        tickMs: 3000,         // delay between Torn status checks (3000 = ~20/min)
        openInNewTab: true,   // open attack loader in a new tab
        backgroundOn: true,   // background worker active
        ffWindow: 0.3,        // width of the rotating FF sub-window per request (internal, not exposed)
        pos: null,            // saved button position {left, top}; null = top right
    };

    const CFG_KEY = 'tfft_config';
    const STATE_KEY = 'tfft_state';

    // Torn PDA replaces this placeholder with the app's configured API key at injection time.
    // In other managers it stays literal, so we detect that and ignore it.
    const PDA_KEY = '###PDA-APIKEY###';

    // Time constants (ms)
    const READY_TTL = 120 * 1000;         // re-verify a ready entry after this age
    const REFRESH_AFTER = 60 * 1000;      // refresh a ready entry after this age
    const FETCH_MIN_INTERVAL = 15 * 1000; // min gap between get-targets calls (limit 5/min)
    const ATTACK_COOLDOWN = 15 * 60 * 1000; // don't re-serve an attacked target for this long
    const NOTOK_COOLDOWN = 10 * 60 * 1000;  // ignore hospital/travel/jail for this long

    function safeJSON(x) { try { return JSON.parse(x); } catch (e) { return null; } }

    function loadConfig() {
        const raw = GM_getValue(CFG_KEY, null);
        return Object.assign({}, DEFAULT_CONFIG, raw ? safeJSON(raw) : {});
    }
    function saveConfig(cfg) { GM_setValue(CFG_KEY, JSON.stringify(cfg)); }

    function loadState() {
        const raw = GM_getValue(STATE_KEY, null);
        const s = raw ? safeJSON(raw) : null;
        return Object.assign({ pool: [], ready: [], cooldown: {}, lastFetch: 0, ffCursor: 0 }, s || {});
    }
    function saveState() { GM_setValue(STATE_KEY, JSON.stringify(state)); }

    let config = loadConfig();
    let state = loadState();
    let selfId = null; // own player id, to avoid attacking ourselves

    // Resolve the API key: explicit config wins, otherwise the PDA-injected key (if present).
    function effectiveKey() {
        if (config.apiKey) return config.apiKey;
        if (PDA_KEY && PDA_KEY.indexOf('#') === -1 && PDA_KEY.length >= 8) return PDA_KEY;
        return '';
    }

    function warn(msg) { try { console.warn('[FF Target Finder] ' + msg); } catch (e) {} }

    // ---------------------------------------------------------------------
    // HTTP: prefer GM_xmlhttpRequest (bypasses CSP, works in TM + PDA),
    // fall back to fetch (both APIs send Access-Control-Allow-Origin: *).
    // ---------------------------------------------------------------------
    function getGMxhr() {
        if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
        return null;
    }

    function httpGet(url) {
        return new Promise((resolve, reject) => {
            const xhr = getGMxhr();
            if (xhr) {
                xhr({
                    method: 'GET',
                    url: url,
                    timeout: 20000,
                    onload: (r) => {
                        const data = safeJSON(r.responseText);
                        if (data === null) return reject(new Error('Invalid JSON (HTTP ' + r.status + ')'));
                        resolve(data);
                    },
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout')),
                });
            } else {
                fetch(url, { credentials: 'omit' })
                    .then(r => r.text())
                    .then(t => {
                        const data = safeJSON(t);
                        if (data === null) return reject(new Error('Invalid JSON'));
                        resolve(data);
                    })
                    .catch(reject);
            }
        });
    }

    // Pick a small FF sub-window so we don't always get the same top targets.
    // FFScouter sorts within the range by battle stats descending -> a fixed range
    // always returns the same 50. We walk the full range with a cursor (plus jitter).
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function round2(v) { return Math.round(v * 100) / 100; }

    function pickFFWindow() {
        const lo = config.minFF, hi = config.maxFF;
        const full = hi - lo;
        const win = Math.min(config.ffWindow, full);
        if (full <= config.ffWindow + 1e-9 || win <= 0) return { minff: round2(lo), maxff: round2(hi) };
        const span = full - win; // room for the starting point
        if (typeof state.ffCursor !== 'number' || state.ffCursor < 0 || state.ffCursor > span) state.ffCursor = 0;
        const jitter = (Math.random() - 0.5) * (win * 0.6);
        const start = clamp(lo + state.ffCursor + jitter, lo, hi - win);
        state.ffCursor += win; // advance for next time -> covers the whole range
        if (state.ffCursor > span + 1e-9) state.ffCursor = 0;
        return { minff: round2(start), maxff: round2(start + win) };
    }

    // FFScouter: fetch candidates
    async function ffGetTargets() {
        const win = pickFFWindow();
        const p = new URLSearchParams({
            key: effectiveKey(),
            minff: String(win.minff),
            maxff: String(win.maxff),
            inactiveonly: '1',
            limit: '50',
        });
        if (config.minLevel > 0) p.set('minlevel', String(config.minLevel));
        if (config.maxLevel > 0) p.set('maxlevel', String(config.maxLevel));
        const data = await httpGet('https://ffscouter.com/api/v1/get-targets?' + p.toString());
        if (data.error) throw new Error('FFScouter: ' + data.error);
        return Array.isArray(data.targets) ? data.targets : [];
    }

    // Torn: status + last_action of a player
    async function tornProfile(id) {
        const url = 'https://api.torn.com/v2/user/' + id + '?selections=profile&key=' + encodeURIComponent(effectiveKey());
        const data = await httpGet(url);
        if (data.error) {
            const err = new Error('Torn: ' + (data.error.error || data.error.code));
            err.tornCode = data.error.code;
            throw err;
        }
        return data.profile || data;
    }

    // Fetch own id once (for self-exclusion)
    async function fetchSelfId() {
        if (selfId || !effectiveKey()) return;
        try {
            const url = 'https://api.torn.com/v2/user?selections=profile&key=' + encodeURIComponent(effectiveKey());
            const d = await httpGet(url);
            selfId = (d.profile && d.profile.id) || d.id || null;
        } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------------
    // Candidate / ready-queue logic
    // ---------------------------------------------------------------------
    function now() { return Date.now(); }

    function inCooldown(id) {
        const until = state.cooldown[id];
        return until && until > now();
    }

    function pruneCooldown() {
        const t = now();
        for (const id of Object.keys(state.cooldown)) {
            if (state.cooldown[id] <= t) delete state.cooldown[id];
        }
    }

    // Is last_action old enough?
    function isInactive(lastActionTs) {
        const ageDays = (now() / 1000 - lastActionTs) / 86400;
        return ageDays >= config.inactiveDays;
    }

    let fetching = false;
    async function maybeFetchPool() {
        if (fetching) return;
        if (now() - state.lastFetch < FETCH_MIN_INTERVAL) return;
        // only refill when too few are available
        const knownIds = new Set([...state.pool.map(p => p.player_id), ...state.ready.map(p => p.player_id)]);
        const needed = config.desiredReady - state.ready.length;
        if (needed <= 0 && state.pool.length > 0) return;

        fetching = true;
        try {
            state.lastFetch = now();
            const targets = await ffGetTargets();
            for (const t of targets) {
                if (knownIds.has(t.player_id)) continue;
                if (selfId && t.player_id === selfId) continue;
                if (inCooldown(t.player_id)) continue;
                if (!isInactive(t.last_action)) continue; // client-side inactivity filter
                state.pool.push({
                    player_id: t.player_id,
                    name: t.name,
                    level: t.level,
                    fair_fight: t.fair_fight,
                    last_action: t.last_action,
                    bs: t.bs_estimate_human,
                });
            }
            saveState();
        } catch (e) {
            warn(e.message);
        } finally {
            fetching = false;
        }
    }

    // One Torn status check per tick (rate-limit friendly)
    let checking = false;
    async function verifyOne() {
        if (checking) return;

        // 1) stale ready entries go back into the pool
        const t = now();
        state.ready = state.ready.filter(r => {
            if (t - r.verifiedAt > READY_TTL) {
                if (!inCooldown(r.player_id)) state.pool.unshift(stripReady(r));
                return false;
            }
            return true;
        });

        // 2) find a refreshable ready entry (oldest beyond REFRESH_AFTER)
        let refreshTarget = null;
        if (state.ready.length > 0) {
            const oldest = state.ready.reduce((a, b) => a.verifiedAt < b.verifiedAt ? a : b);
            if (t - oldest.verifiedAt > REFRESH_AFTER) refreshTarget = oldest;
        }

        // 3) otherwise: verify a new pool candidate while the ready queue isn't full
        let cand = null, fromPool = false;
        if (refreshTarget) {
            cand = refreshTarget;
        } else if (state.ready.length < config.desiredReady) {
            while (state.pool.length > 0) {
                const c = state.pool.shift();
                if (inCooldown(c.player_id)) continue;
                cand = c; fromPool = true; break;
            }
        }
        if (!cand) return;

        checking = true;
        try {
            const prof = await tornProfile(cand.player_id);
            const ststate = prof.status && prof.status.state;
            const lastAct = (prof.last_action && prof.last_action.timestamp) || cand.last_action;

            const okay = ststate === 'Okay';
            const stillInactive = isInactive(lastAct);

            if (okay && stillInactive) {
                // add to / refresh in ready
                const entry = {
                    player_id: cand.player_id,
                    name: prof.name || cand.name,
                    level: prof.level || cand.level,
                    fair_fight: cand.fair_fight,
                    last_action: lastAct,
                    bs: cand.bs,
                    verifiedAt: now(),
                };
                state.ready = state.ready.filter(r => r.player_id !== cand.player_id);
                state.ready.push(entry);
                // best (highest FF, then highest level) first
                state.ready.sort((a, b) => (b.fair_fight - a.fair_fight) || (b.level - a.level));
            } else {
                // not attackable or active again -> drop from ready + cooldown
                state.ready = state.ready.filter(r => r.player_id !== cand.player_id);
                const cd = ststate === 'Hospital' && prof.status.until
                    ? prof.status.until * 1000
                    : now() + NOTOK_COOLDOWN;
                state.cooldown[cand.player_id] = cd;
            }
            saveState();
        } catch (e) {
            if (e.tornCode === 5) {
                // Too many requests -> put candidate back, brief slowdown
                if (fromPool) state.pool.unshift(cand);
                warn('Torn rate limit, backing off');
            } else if (e.tornCode === 2 || e.tornCode === 10 || e.tornCode === 13) {
                warn('Torn key error: ' + e.message);
            }
        } finally {
            checking = false;
            renderBadge();
        }
    }

    function stripReady(r) {
        return { player_id: r.player_id, name: r.name, level: r.level, fair_fight: r.fair_fight, last_action: r.last_action, bs: r.bs };
    }

    // ---------------------------------------------------------------------
    // Attack action
    // ---------------------------------------------------------------------
    function attackNext() {
        pruneCooldown();
        // take the freshest attackable entry (most recently verified)
        const list = state.ready.filter(r => !inCooldown(r.player_id));
        if (list.length === 0) {
            renderBadge();
            return;
        }
        const target = list.sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
        state.ready = state.ready.filter(r => r.player_id !== target.player_id);
        state.cooldown[target.player_id] = now() + ATTACK_COOLDOWN;
        saveState();
        renderBadge();

        // new attack endpoint (old loader.php?sid=attack is deprecated)
        const url = 'https://www.torn.com/page.php?sid=attack&user2ID=' + target.player_id;
        if (config.openInNewTab) {
            window.open(url, '_blank');
        } else {
            window.location.href = url;
        }
    }

    // ---------------------------------------------------------------------
    // Worker loop
    // ---------------------------------------------------------------------
    let workerTimer = null;
    async function tick() {
        if (!config.backgroundOn || !effectiveKey()) return;
        pruneCooldown();
        await fetchSelfId();
        await maybeFetchPool();
        await verifyOne();
    }
    function startWorker() {
        if (workerTimer) clearInterval(workerTimer);
        workerTimer = setInterval(tick, config.tickMs);
    }

    // ---------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------
    let elBtn, elBadge, elPanel;

    function buildUI() {
        const wrap = document.createElement('div');
        wrap.id = 'tfft-wrap';
        wrap.innerHTML = `
            <div id="tfft-bar">
                <button id="tfft-attack" title="Next target — drag to move">⚔ <span id="tfft-badge">0</span></button>
                <button id="tfft-gear" title="Settings">⚙</button>
            </div>`;
        document.body.appendChild(wrap);

        elBtn = wrap.querySelector('#tfft-attack');
        elBadge = wrap.querySelector('#tfft-badge');
        wrap.querySelector('#tfft-gear').addEventListener('click', toggleSettings);
        // the whole attack button doubles as drag handle: click = attack, drag = move
        makeDraggable(wrap, elBtn, attackNext);

        // apply saved position
        if (config.pos && typeof config.pos.left === 'number') {
            wrap.style.left = config.pos.left + 'px';
            wrap.style.top = config.pos.top + 'px';
            wrap.style.right = 'auto';
        }

        const style = document.createElement('style');
        style.textContent = `
            #tfft-wrap{position:fixed;right:12px;top:12px;z-index:99999;font-family:Arial,sans-serif;font-size:12px;}
            #tfft-bar{display:flex;gap:3px;}
            #tfft-wrap button{cursor:pointer;border:1px solid #555;border-radius:3px;background:#333;color:#ccc;font-size:12px;line-height:1;padding:4px 7px;}
            #tfft-wrap button:hover{background:#3d3d3d;}
            #tfft-attack{background:#8b1a1a;border-color:#a33;color:#eee;touch-action:none;cursor:grab;}
            #tfft-attack:hover{background:#9d2020;}
            #tfft-attack:active{cursor:grabbing;}
            #tfft-badge{font-weight:bold;color:#ddd;}
            #tfft-panel{position:fixed;z-index:100000;width:280px;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:6px;padding:14px;box-shadow:0 4px 16px rgba(0,0,0,.6);font-family:Arial;font-size:12px;}
            #tfft-panel h3{margin:0 0 10px;font-size:14px;}
            #tfft-panel label{display:block;margin:8px 0 2px;color:#aaa;}
            #tfft-panel input[type=text],#tfft-panel input[type=number]{width:100%;box-sizing:border-box;padding:5px;background:#2a2a2a;border:1px solid #555;border-radius:3px;color:#fff;}
            #tfft-panel .row{display:flex;gap:8px;}
            #tfft-panel .row>div{flex:1;}
            #tfft-panel .chk{display:flex;align-items:center;gap:6px;margin-top:10px;}
            #tfft-panel .chk input{width:auto;}
            #tfft-panel .actions{display:flex;gap:8px;margin-top:14px;}
            #tfft-panel button{flex:1;padding:7px;border:none;border-radius:4px;color:#fff;cursor:pointer;font-weight:bold;}
            #tfft-save{background:#2e7d32;}
            #tfft-reset{background:#555;}
            #tfft-panel .hint{color:#777;font-size:10px;margin-top:8px;line-height:1.4;}
        `;
        document.head.appendChild(style);
        renderBadge();
    }

    // The handle is both clickable and draggable: a real drag (moved beyond a
    // small threshold) repositions and saves; a plain press fires onClick.
    function makeDraggable(wrap, handle, onClick) {
        let startX, startY, origLeft, origTop, down = false, moved = false;
        handle.addEventListener('pointerdown', (e) => {
            down = true; moved = false;
            handle.setPointerCapture(e.pointerId);
            const rect = wrap.getBoundingClientRect();
            origLeft = rect.left; origTop = rect.top;
            startX = e.clientX; startY = e.clientY;
        });
        handle.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 5) return; // ignore micro-movement
            moved = true;
            wrap.style.right = 'auto';
            wrap.style.left = Math.max(0, Math.min(window.innerWidth - wrap.offsetWidth, origLeft + dx)) + 'px';
            wrap.style.top = Math.max(0, Math.min(window.innerHeight - wrap.offsetHeight, origTop + dy)) + 'px';
        });
        const end = (e) => {
            if (!down) return;
            down = false;
            try { handle.releasePointerCapture(e.pointerId); } catch (x) {}
            if (moved) {
                config.pos = { left: parseInt(wrap.style.left, 10), top: parseInt(wrap.style.top, 10) };
                saveConfig(config);
            } else if (typeof onClick === 'function') {
                onClick();
            }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function renderBadge() {
        if (!elBadge) return;
        const avail = state.ready.filter(r => !inCooldown(r.player_id));
        const n = avail.length;
        elBadge.textContent = n;
        elBadge.style.color = n > 0 ? '#8fe36a' : '#ddd';
        const next = avail.sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
        elBtn.title = next ? ('Next: ' + next.name + ' (Lvl ' + next.level + ', FF ' + next.fair_fight + ') — drag to move')
                           : 'No target ready — drag to move';
    }

    function toggleSettings() {
        if (elPanel) { elPanel.remove(); elPanel = null; return; }
        const usingPdaKey = !config.apiKey && effectiveKey();
        elPanel = document.createElement('div');
        elPanel.id = 'tfft-panel';
        elPanel.innerHTML = `
            <h3>FF Target Finder</h3>
            <label>Torn API Key (= FFScouter key)</label>
            <input type="text" id="p-key" value="${escapeHtml(config.apiKey)}" placeholder="${usingPdaKey ? 'using Torn PDA key' : '16-char key'}">
            <div class="row">
                <div><label>Min FF</label><input type="number" step="0.1" id="p-minff" value="${config.minFF}"></div>
                <div><label>Max FF</label><input type="number" step="0.1" id="p-maxff" value="${config.maxFF}"></div>
            </div>
            <div class="row">
                <div><label>Min level</label><input type="number" id="p-minlvl" value="${config.minLevel}"></div>
                <div><label>Max level</label><input type="number" id="p-maxlvl" value="${config.maxLevel}"></div>
            </div>
            <div class="row">
                <div><label>Inactive ≥ (days)</label><input type="number" id="p-inact" value="${config.inactiveDays}"></div>
                <div><label>Ready buffer</label><input type="number" id="p-ready" value="${config.desiredReady}"></div>
            </div>
            <label>Check interval (ms) — 3000≈20/min</label>
            <input type="number" id="p-tick" value="${config.tickMs}">
            <div class="chk"><input type="checkbox" id="p-newtab" ${config.openInNewTab ? 'checked' : ''}><label style="margin:0;color:#ddd;">Open attack in new tab</label></div>
            <div class="chk"><input type="checkbox" id="p-bg" ${config.backgroundOn ? 'checked' : ''}><label style="margin:0;color:#ddd;">Background worker active</label></div>
            <div class="actions">
                <button id="tfft-save">Save</button>
                <button id="tfft-reset">Clear cache</button>
            </div>
            <div class="hint">Leave the key empty on Torn PDA to use the app key. Clearing the cache drops candidates, ready queue &amp; cooldowns. After changing FF/level, reloading is recommended.</div>`;
        document.body.appendChild(elPanel);

        // position panel under the button (right edges aligned), keep in viewport
        const wrap = document.getElementById('tfft-wrap');
        const r = wrap.getBoundingClientRect();
        const pr = elPanel.getBoundingClientRect();
        let left = Math.max(6, r.right - pr.width);
        let top = r.bottom + 6;
        if (top + pr.height > window.innerHeight - 6) top = Math.max(6, r.top - pr.height - 6);
        elPanel.style.left = left + 'px';
        elPanel.style.top = top + 'px';

        elPanel.querySelector('#tfft-save').addEventListener('click', () => {
            config.apiKey = elPanel.querySelector('#p-key').value.trim();
            config.minFF = parseFloat(elPanel.querySelector('#p-minff').value) || 0;
            config.maxFF = parseFloat(elPanel.querySelector('#p-maxff').value) || 3;
            config.minLevel = parseInt(elPanel.querySelector('#p-minlvl').value) || 0;
            config.maxLevel = parseInt(elPanel.querySelector('#p-maxlvl').value) || 0;
            config.inactiveDays = parseFloat(elPanel.querySelector('#p-inact').value) || 0;
            config.desiredReady = parseInt(elPanel.querySelector('#p-ready').value) || 8;
            config.tickMs = Math.max(1000, parseInt(elPanel.querySelector('#p-tick').value) || 3000);
            config.openInNewTab = elPanel.querySelector('#p-newtab').checked;
            config.backgroundOn = elPanel.querySelector('#p-bg').checked;
            saveConfig(config);
            startWorker();
            elPanel.remove(); elPanel = null;
        });
        elPanel.querySelector('#tfft-reset').addEventListener('click', () => {
            state = { pool: [], ready: [], cooldown: {}, lastFetch: 0, ffCursor: 0 };
            saveState();
            renderBadge();
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------
    function init() {
        buildUI();
        startWorker();
        tick();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
