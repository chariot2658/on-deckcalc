/* UI of the event deck calculator. Plain browser script: Engine (engine.js), Data (data.js) and Recognize
 * (recognize.js) are globals. */
(function () {
  "use strict";

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const pct = (bp) => (bp / 100).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";

  const TYPE_KEYS = { 1: "Red", 2: "Blue", 3: "Green", 4: "Yellow", 5: "Purple" };
  const DIFF_NAMES = { easy: "EASY", normal: "NORMAL", hard: "HARD", expert: "EXPERT" };
  const RANK_LABEL = { 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS" };

  // ---------------------------------------------------------------------------------------------------------------
  // State

  const DEFAULT_SETTINGS = {
    region: "hk-tw-mo",
    eventId: null,
    mode: "normal",
    boosts: 3,
    cp: 200,
    maxLevel: 27,
    difficulties: ["easy", "normal", "hard", "expert"],
    objective: "points",
    topK: 5,
    perfectRate: 100, // %, of judged notes
    comboBreaks: 0, // Miss + Bad per live
    importMaxLevel: false,
    songSort: "live",
    songPick: "live",
    songOverhead: 40,
    multi: false,
    multiPlayers: 5,
    multiOthersAvg: 5000000,
    multiGekisouRank: 3, // assumed rank in every Gekisou range
    multiJustRate: 50, // %, of the Just-count ranges' notes
    // A public room draws its song: "saved" (a deck saved per Gekisou range type, switched to after the draw) or "random"
    // (one deck for every song); "pick": a private room choosing its song.
    multiSong: "saved",
    scoreSong: 0, // objective "score": the song to play (live music id), 0 = every song (challenge: every challenge song)
  };

  // Profiles (設定檔) each keep their own settings (region included), roster and backup reminder, under
  // deckcalc:p:{id}:{settings|roster|unsaved}. deckcalc:profiles = {active, list: [{id, name}]}.
  const pkey = (id, k) => "deckcalc:p:" + id + ":" + k;
  const profiles = loadProfiles();
  const activeProfile = () => profiles.list.find((p) => p.id === profiles.active);
  const saveProfiles = () => Data.safeSet("deckcalc:profiles", JSON.stringify(profiles));
  const loadSettings = () => {
    const s = { ...DEFAULT_SETTINGS, ...loadJson(pkey(profiles.active, "settings"), {}) };
    // The score-mode branch had a third mode; it is now the score objective of a normal live.
    if (s.mode === "score") Object.assign(s, { mode: "normal", objective: "score" });
    return s;
  };

  // Before profiles, settings were global and the roster was kept per region: each region with a roster (and the
  // region last used) becomes a profile named after it. The old keys are left in place.
  function loadProfiles() {
    const reg = loadJson("deckcalc:profiles", null);
    if (reg && Array.isArray(reg.list) && reg.list.length) {
      if (!reg.list.some((p) => p.id === reg.active)) reg.active = reg.list[0].id;
      return reg;
    }
    const old = loadJson("deckcalc:settings", {});
    const current = Data.REGIONS[old.region] ? old.region : DEFAULT_SETTINGS.region;
    const list = [];
    for (const region of Object.keys(Data.REGIONS)) {
      const roster = Data.safeGet("deckcalc:roster:" + region);
      if (!roster && region !== current) continue;
      list.push({ id: region, name: Data.REGIONS[region].label });
      Data.safeSet(pkey(region, "settings"), JSON.stringify({ ...old, region, eventId: region === current ? old.eventId || null : null }));
      if (roster) Data.safeSet(pkey(region, "roster"), roster);
      const unsaved = Data.safeGet("deckcalc:unsaved:" + region);
      if (unsaved) Data.safeSet(pkey(region, "unsaved"), unsaved);
    }
    const out = { active: current, list };
    Data.safeSet("deckcalc:profiles", JSON.stringify(out));
    return out;
  }

  const state = {
    settings: loadSettings(),
    roster: null, // {members: {id: {level, awake, rank, skillLevel, gekisouSkillLevel, guess}}, snaps: {id: {level, rank, guess}}, player}
    master: null,
    version: null,
    perPower: null,
    lengths: null,
    skillWeights: null,
    battle: null, // Engine.battleFromMusicData: multiplayer lives with Gekisou
    replay: null, // {musicDataUrl, pointer}: the replay simulation named by music-data.json
    simCache: new Map(), // deck request JSON -> order scores
    worker: null,
    workerReady: null,
    lastResults: null,
    filters: { m: { band: "", rarity: "", owned: false, bonus: false, q: "" }, s: { band: "", rarity: "", owned: false, bonus: false, q: "" } },
  };

  function loadJson(key, fallback) {
    try {
      const v = Data.safeGet(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  const saveSettings = () => Data.safeSet(pkey(profiles.active, "settings"), JSON.stringify(state.settings));
  const rosterKey = () => pkey(profiles.active, "roster");
  function loadRoster() {
    const r = loadJson(rosterKey(), null);
    state.roster = r && r.members ? r : { members: {}, snaps: {}, player: { vipRank: 1, characterRanks: {}, eventParameters: false } };
    state.roster.player = { vipRank: 1, characterRanks: {}, eventParameters: false, ...(state.roster.player || {}) };
  }
  // The roster lives only in this browser, so changes not yet exported are tracked (ISO time of the first one, per
  // profile) to remind the user to back up.
  const unsavedKey = () => pkey(profiles.active, "unsaved");
  const BACKUP_REMIND_MS = 24 * 3600 * 1000;
  function saveRoster() {
    Data.safeSet(rosterKey(), JSON.stringify(state.roster));
    if (!Data.safeGet(unsavedKey())) Data.safeSet(unsavedKey(), new Date().toISOString());
    askPersist();
    renderBackupHint();
  }
  function markBackedUp() {
    Data.safeRemove(unsavedKey());
    renderBackupHint();
  }
  const rosterEmpty = () => !Object.keys(state.roster.members).length && !Object.keys(state.roster.snaps).length;

  // Asks the browser not to evict the site's storage. Chrome and Edge decide silently, Firefox asks the user, Safari
  // may still drop it after 7 days without a visit. Only asked once there is a roster to keep.
  let persistAsked = false;
  function askPersist() {
    if (persistAsked || rosterEmpty() || !(navigator.storage && navigator.storage.persist)) return;
    persistAsked = true;
    navigator.storage.persist().then(renderBackupHint, () => {});
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Master helpers

  const T = (id) => state.master.text(id);
  const cardName = (c) => T(c._nameTextID);
  const memberTitle = (c) => T(c._subtitleTextID);
  const snapTitle = (s) => T(s._descriptionTextID);
  const bandName = (id) => (state.master.bands.get(id) ? T(state.master.bands.get(id)._nameTextID) : "");
  const charName = (id) => (state.master.characters.get(id) ? T(state.master.characters.get(id)._nameTextID) : "");
  const typeName = (t) => T("CardType_" + TYPE_KEYS[t] + "_Name") || TYPE_KEYS[t];
  const tagName = (id) => (state.master.tags.get(id) ? T(state.master.tags.get(id)._nameTextID) : "#" + id);
  const musicTitle = (id) => (state.master.musics.get(id) ? T(state.master.musics.get(id)._titleTextID) : "#" + id);
  const RARITY_NAMES = { 2: "R", 3: "SR", 4: "SSR", 10: "特殊" };
  const rarityName = (r) => RARITY_NAMES[r] || "★" + r;
  const liveSkillName = (c) => {
    const g = state.master.liveSkills.get(c._liveSkillID);
    return g ? "演出技能：" + T(g._nameTextID) : "";
  };
  const gekisouSkillName = (c) => {
    const g = state.master.gekisouSkills.get(c._gekisouSkillID);
    return g ? "激奏技能：" + T(g._nameTextID) : "";
  };
  const typeDot = (t) => `<span class="type-dot t${t}" title="${esc(typeName(t))}"></span>`;

  function events() {
    return state.master.t.MasterEvent.slice().sort((a, b) => Engine.parseTime(b._startAt) - Engine.parseTime(a._startAt));
  }

  function currentEvent() {
    const id = state.settings.eventId;
    return (id && state.master.events.get(id)) || Engine.currentEvent(state.master, new Date());
  }

  function eventName(e) {
    return T(e._nameTextId) || "活動 #" + e._id;
  }

  // Event bonus of a catalogue card at the owned (or first) rank.
  function cardBonus(kind, id) {
    const e = currentEvent();
    if (!e) return { point: 0, item: 0, param: 0 };
    const own = kind === "member" ? state.roster.members[id] : state.roster.snaps[id];
    const rank = own ? own.rank || 1 : 1;
    let view;
    if (kind === "member") {
      const c = state.master.memberCards.get(id);
      view = Engine.memberView(state.master, { id, level: 1, awake: 1, rank }, {});
      if (!view && c) return { point: 0, item: 0, param: 0 };
    } else {
      view = Engine.snapView(state.master, { id, level: 1, rank });
    }
    return Engine.cardEventBonus(Engine.eventEffects(state.master, e._id), view);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loading

  function setLoading(text) {
    const el = $("#loading");
    if (text === null) el.classList.add("hidden");
    else {
      el.classList.remove("hidden");
      $("#loading-text").textContent = text;
    }
  }

  async function loadAll(force) {
    const region = state.settings.region;
    renderProfileSelect();
    setLoading("讀取 masterdata 版本…");
    try {
      if (force) await Data.clearAll();
      const [mst, md] = await Promise.all([
        Data.loadMaster(region, Engine.TABLES, (d, n) => setLoading(`下載 masterdata… ${d}/${n}`)),
        Data.loadMusicData(force).catch((e) => {
          console.warn(e);
          return null;
        }),
      ]);
      setLoading("整理資料…");
      const lang = (Data.REGIONS[region] || Data.REGIONS["hk-tw-mo"]).text;
      state.master = Engine.buildMaster(mst.raw, lang);
      state.version = mst;
      state.perPower = md ? Engine.perPowerFromMusicData(md) : new Map();
      state.lengths = md ? Engine.chartLengthsFromMusicData(md) : new Map();
      state.skillWeights = md ? Engine.skillWeightsFromMusicData(md) : null;
      state.battle = md ? Engine.battleFromMusicData(md) : null;
      state.replay = md && md.replay ? { musicDataUrl: Data.MUSIC_DATA_URL, pointer: md.replay } : null;
      state.simCache.clear();
      $("#data-status").textContent =
        `資料版本 ${String(mst.version).slice(0, 8)} · 更新於 ${new Date(mst.verifiedAt).toLocaleString()}` +
        (md ? "" : " · 譜面資料載入失敗");
      startWorker(mst.raw, lang);
      loadRoster();
      askPersist();
      imp.found.clear(); // card ids are per region
      imp.shots = [];
      renderAll();
    } catch (e) {
      console.error(e);
      $("#tab-calc").innerHTML = `<div class="panel"><h2>資料載入失敗</h2><p>${esc(e.message)}</p><p class="note">請確認網路連線，或按「更新資料」重試。</p></div>`;
    } finally {
      setLoading(null);
    }
  }

  // Requests to the worker by id: search and simulate replies may interleave.
  const pending = new Map();
  let workerSeq = 0;
  function workerCall(msg, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      pending.set(id, { resolve, reject, onProgress });
      state.worker.postMessage({ ...msg, id });
    });
  }

  function startWorker(raw, lang) {
    if (state.worker) state.worker.terminate();
    for (const p of pending.values()) p.reject(new Error("worker restarted"));
    pending.clear();
    const slim = {};
    for (const k of Object.keys(raw)) if (k !== "MasterText") slim[k] = raw[k];
    const sw = state.skillWeights;
    try {
      state.worker = new Worker("worker.js");
      state.workerReady = new Promise((resolve, reject) => {
        state.worker.onmessage = (e) => {
          const d = e.data;
          if (d.type === "ready") return resolve();
          const p = pending.get(d.id);
          if (!p) return;
          if (d.type === "progress") {
            if (p.onProgress) p.onProgress(d.done, d.total, d.stage);
            return;
          }
          pending.delete(d.id);
          if (d.type === "error") p.reject(new Error(d.message));
          else p.resolve(d);
        };
        state.worker.onerror = (e) => reject(e);
      });
      state.worker.postMessage({
        type: "init", raw: slim, lang, perPower: [...state.perPower], lengths: [...state.lengths], replay: state.replay, battle: state.battle,
        skillWeights: sw ? { kinds: sw.kinds, byScore: [...sw.byScore].map(([k, w]) => [k, Array.from(w)]) } : null,
      });
    } catch (e) {
      console.warn("worker unavailable, searching on the main thread", e);
      state.worker = null;
      state.workerReady = Promise.resolve();
    }
  }

  async function runSearch(input, eventId, onProgress) {
    const now = Date.now();
    if (!state.worker) {
      const out = Engine.search({ ...input, master: state.master, event: state.master.events.get(eventId), perPowerByScore: state.perPower, skillWeights: state.skillWeights, battle: state.battle, lengthByScore: state.lengths, now: new Date(now) });
      const slim = (d) => ({ ...d, members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })), snaps: d.snaps.map((s) => (s ? { id: s.id, level: s.level, rank: s.rank } : null)) });
      return { error: out.error, stats: out.stats, rate: out.rate, gekisou: out.gekisou, random: !!out.random, results: out.results.map(slim), songs: (out.songs || []).map(slim) };
    }
    await state.workerReady;
    return workerCall({ type: "search", eventId, input, now }, onProgress);
  }

  // Saved decks for a public room (worker only: they are ranked by the simulation).
  async function runSaved(input, eventId, onProgress) {
    if (!state.worker) throw new Error("預存隊伍要在背景執行緒（Web Worker）計算，這個瀏覽器無法使用");
    await state.workerReady;
    return workerCall({ type: "saved", eventId, input, now: Date.now() }, onProgress);
  }

  // The simulated order scores of decks (worker only), cached per deck and chart. `gekisou` ({rank, justRate}, from a
  // multiplayer search) plays with Gekisou on.
  async function simulateDecks(decks, gekisou) {
    if (!state.worker || !state.replay) return decks.map(() => null);
    await state.workerReady;
    const reqs = decks.map((d) => ({
      scoreId: d.chart.scoreId,
      power: d.displayPower,
      members: d.members.map((v) => ({ id: v.id, skillLevel: v.skillLevel || 1, gekisouSkillLevel: v.gekisouSkillLevel || 1 })),
      snaps: d.snaps.map((x) => (x ? { id: x.id, rank: x.rank || 1 } : null)),
      gekisou: gekisou || null,
    }));
    const keys = reqs.map((r) => JSON.stringify(r));
    const todo = reqs.filter((_, i) => !state.simCache.has(keys[i]));
    if (todo.length) {
      const res = await workerCall({ type: "simulate", decks: todo });
      todo.forEach((r, i) => state.simCache.set(JSON.stringify(r), res.out[i]));
    }
    return keys.map((k) => state.simCache.get(k));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Rendering

  function renderAll() {
    renderProfileSelect();
    renderCalc();
    renderMembers();
    renderSnaps();
    renderImport();
    renderSettings();
  }

  const regionLabel = (r) => (Data.REGIONS[r] || { label: r }).label;
  // A profile's name, with its region when the name does not already say it.
  function profileLabel(p) {
    const region = p.id === profiles.active ? state.settings.region : (loadJson(pkey(p.id, "settings"), {}).region || DEFAULT_SETTINGS.region);
    return p.name === regionLabel(region) ? p.name : `${p.name}（${regionLabel(region)}）`;
  }

  function renderProfileSelect() {
    const sel = $("#profile");
    sel.innerHTML = profiles.list
      .map((p) => `<option value="${esc(p.id)}" ${p.id === profiles.active ? "selected" : ""}>${esc(profileLabel(p))}</option>`)
      .join("");
  }

  function switchProfile(id) {
    if (!profiles.list.some((p) => p.id === id)) return;
    profiles.active = id;
    saveProfiles();
    state.settings = loadSettings();
    state.lastResults = null;
    loadAll(false);
  }

  // A new profile, empty or a copy of the current one (settings and roster), made active.
  function addProfile(name, region, copy) {
    const id = "p" + Date.now().toString(36);
    const settings = copy ? { ...state.settings, region } : { ...DEFAULT_SETTINGS, region };
    if (region !== state.settings.region) settings.eventId = null;
    Data.safeSet(pkey(id, "settings"), JSON.stringify(settings));
    if (copy) Data.safeSet(pkey(id, "roster"), JSON.stringify(state.roster));
    profiles.list.push({ id, name });
    switchProfile(id);
  }

  function deleteProfile() {
    const id = profiles.active;
    for (const k of ["settings", "roster", "unsaved"]) Data.safeRemove(pkey(id, k));
    profiles.list = profiles.list.filter((p) => p.id !== id);
    switchProfile(profiles.list[0].id);
  }

  // --- event rules ---

  function effectCondition(e) {
    const m = state.master;
    const parts = [];
    if (e._memberCardId > 0) {
      const c = m.memberCards.get(e._memberCardId);
      if (c) parts.push(`${rarityName(c._rarity)} ${cardName(c)}「${memberTitle(c)}」`);
    }
    if (e._supportCardId > 0) {
      const s = m.snaps.get(e._supportCardId);
      if (s) parts.push(`${rarityName(s._rarity)} ${cardName(s)}「${snapTitle(s)}」`);
    }
    if (e._characterId > 0) parts.push(charName(e._characterId));
    if (e._bandId > 0) parts.push(bandName(e._bandId));
    if (e._cardType > 0) parts.push(typeDot(e._cardType) + " " + esc(typeName(e._cardType)));
    if (e._tagId > 0) parts.push("標籤 " + tagName(e._tagId));
    return parts.length ? parts.map((p) => (p.startsWith("<") ? p : esc(p))).join("、") : "全部";
  }

  function renderRules(ev) {
    const effects = Engine.eventEffects(state.master, ev._id);
    const rows = new Map();
    for (const e of effects) {
      const key = [e._resourceTypeConstraint, e._memberCardId, e._supportCardId, e._characterId, e._bandId, e._cardType, e._tagId].join(":");
      if (!rows.has(key)) rows.set(key, { e, vals: {} });
      rows.get(key).vals[e._eventBonusType] = [1, 2, 3, 4, 5].map((r) => e["_rank" + r + "EffectValue"]);
    }
    const range = (v) => (v ? `${pct(v[0])} → ${pct(v[4])}` : "—");
    const body = [...rows.values()]
      .map(({ e, vals }) => `<tr>
        <td>${e._resourceTypeConstraint === 2 ? "成員卡" : "快照"}</td>
        <td>${effectCondition(e)}</td>
        <td class="num tag-point">${range(vals[0])}</td>
        <td class="num tag-item">${range(vals[1])}</td>
        <td class="num tag-param">${range(vals[2])}</td></tr>`)
      .join("");
    return `<table class="rules"><thead><tr><th>對象</th><th>條件</th><th>活動點數</th><th>活動道具</th><th>數值</th></tr></thead><tbody>${body}</tbody></table>
      <p class="note">數值是覺醒／開放上限 1 → 5 的加成，同一張卡符合多個條件時會疊加。成員卡的加成決定活動點數，快照的加成決定活動道具（已用遊戲結算畫面驗證）。「數值」加成只在挑戰 Live 反映在遊戲顯示的綜合力與分數上（已驗證），一般 Live 預設不計入。</p>`;
  }

  // --- calc tab ---

  function renderCalc() {
    const s = state.settings;
    const ev = currentEvent();
    const el = $("#tab-calc");
    if (!ev) {
      el.innerHTML = `<div class="panel">目前的資料裡沒有活動。</div>`;
      return;
    }
    const ownedM = Object.keys(state.roster.members).length;
    const ownedS = Object.keys(state.roster.snaps).length;
    const evOpts = events()
      .map((e) => `<option value="${e._id}" ${e._id === ev._id ? "selected" : ""}>${esc(eventName(e))}（${esc(e._startAt)}）</option>`)
      .join("");
    const challengeSongs = state.master.t.MasterChallengeMusic.filter((r) => r._eventId === ev._id).map((r) => musicTitle(r._liveMusicId));
    const randomSong = randomSongOf(s);
    const saved = savedOf(s);
    const score = s.objective === "score";
    const diffChips = Object.keys(DIFF_NAMES)
      .map((d) => `<label><input type="checkbox" name="diff" value="${d}" ${s.difficulties.includes(d) ? "checked" : ""}>${DIFF_NAMES[d]}</label>`)
      .join("");
    el.innerHTML = `
      <div class="panel">
        <h2>活動</h2>
        <div class="row">
          <label class="field"><span>活動</span><select id="event">${evOpts}</select></label>
          <div class="field"><span>期間</span><div>${esc(ev._startAt)} ～ ${esc(ev._endAt)}</div></div>
          <div class="field"><span>活動曲</span><div>${esc(musicTitle(ev._musicId))}</div></div>
          <div class="field"><span>挑戰 Live 曲目</span><div>${esc(challengeSongs.join("、") || "—")}</div></div>
        </div>
        <h3>活動加成</h3>
        ${renderRules(ev)}
      </div>
      <div class="panel">
        <h2>計算條件</h2>
        <div class="row">
          <div class="field"><span>模式</span>
            <div class="chips">
              <label><input type="radio" name="mode" value="normal" ${s.mode === "normal" ? "checked" : ""}>一般 Live</label>
              <label><input type="radio" name="mode" value="challenge" ${s.mode === "challenge" ? "checked" : ""}>挑戰 Live</label>
            </div>
          </div>
          <div class="field"><span>優先</span>
            <div class="chips">
              <label><input type="radio" name="objective" value="points" ${s.objective === "points" ? "checked" : ""}>活動點數</label>
              <label><input type="radio" name="objective" value="items" ${s.objective === "items" ? "checked" : ""}>活動道具</label>
              <label title="不看活動點數和道具，只找分數最高的隊伍（衝分數、排行榜用）"><input type="radio" name="objective" value="score" ${score ? "checked" : ""}>最高分數</label>
            </div>
          </div>
          <label class="field" ${score && !saved ? "" : "hidden"} title="${s.mode === "challenge" ? "挑戰 Live 每首挑戰曲各有分數排行榜（記錄各難度中最高的一次）" : "不選就從全部歌曲裡找分數最高的"}"><span>歌曲</span>
            <select id="scoreSong">${scoreSongOptions(s, ev)}</select></label>
          <label class="field" ${s.mode === "normal" && !score ? "" : "hidden"}><span>加成道具（LB）用量</span>
            <input type="number" id="boosts" min="0" max="10" value="${s.boosts}"></label>
          <div class="field" ${s.mode === "normal" ? "" : "hidden"}><span>遊玩方式</span>
            <div class="chips">
              <label><input type="radio" name="multi" value="solo" ${s.multi ? "" : "checked"}>單人</label>
              <label><input type="radio" name="multi" value="multi" ${s.multi ? "checked" : ""}>多人（激奏）</label>
            </div>
          </div>
          <label class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"}><span>房間人數</span>
            <input type="number" id="multiPlayers" min="2" max="5" value="${s.multiPlayers}" style="width:70px"></label>
          <label class="field" ${s.mode === "normal" && s.multi && !score ? "" : "hidden"}><span>其他玩家平均分數</span>
            <input type="number" id="multiOthersAvg" min="0" step="100000" value="${s.multiOthersAvg}" style="width:120px"></label>
          <label class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"} title="激奏的三段任務（連擊／幸運／JUST）各自在房間裡排名，名次越前，該段分數的加成越高（依歌曲，第 1 名 +250%～+370%，第 4、5 名 +100%～+170%）"><span>激奏每段的名次</span>
            <select id="multiGekisouRank">${range(1, 5).map((r) => `<option value="${r}" ${r === s.multiGekisouRank ? "selected" : ""}>第 ${r} 名</option>`).join("")}</select></label>
          <label class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"} title="JUST 激奏區間裡打出 JUST 的比例（其餘當 PERFECT）。JUST 一個音符算 230%，PERFECT 算 100%"><span>JUST 區間的 JUST 率（%）</span>
            <input type="number" id="multiJustRate" min="0" max="100" step="5" value="${s.multiJustRate}" style="width:80px"></label>
          <div class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"} title="公開自由對戰的歌是抽出來的（自己選的歌也只是加入抽選），但抽完歌後約 10 秒內還能換成存好的編組：預存隊伍依激奏區間的種類各找一隊。一隊打全部＝不換隊，依所有歌的平均排名。私人房可以指定歌曲，就和單人一樣選最好的歌"><span>激奏的歌</span>
            <div class="chips">
              <label><input type="radio" name="multiSong" value="saved" ${saved ? "checked" : ""}>預存隊伍（公開房）</label>
              ${score ? "" : `<label><input type="radio" name="multiSong" value="random" ${randomSong ? "checked" : ""}>一隊打全部（公開房）</label>`}
              <label><input type="radio" name="multiSong" value="pick" ${s.multiSong === "pick" ? "checked" : ""}>自己選（私人房）</label>
            </div>
          </div>
          <label class="field" ${s.mode === "challenge" && !score ? "" : "hidden"}><span>消耗挑戰點數</span>
            <select id="cp">${[200, 400, 800, 1600].map((v) => `<option ${v === s.cp ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="field"><span>可穩定打的最高等級</span><input type="number" id="maxLevel" min="1" max="40" value="${s.maxLevel}"></label>
          <label class="field" title="結算畫面的 PERFECT ÷ 全部判定"><span>平常的 Perfect 率（%）</span>
            <input type="number" id="perfectRate" min="50" max="100" step="0.1" value="${s.perfectRate}" style="width:80px"></label>
          <label class="field" title="斷 combo 的只有 MISS 和 BAD（GOOD 不會斷）。斷在曲子中段最傷，可能少 6~7% 分數"><span>每場斷 combo 次數（MISS＋BAD）</span>
            <input type="number" id="comboBreaks" min="0" max="20" step="0.5" value="${s.comboBreaks}" style="width:80px"></label>
          <div class="field"><span>難度</span><div class="chips">${diffChips}</div></div>
          <div class="field" ${randomSong || saved || score ? "hidden" : ""}><span>選歌</span>
            <div class="chips">
              <label><input type="radio" name="songPick" value="live" ${s.songPick !== "minute" ? "checked" : ""}>每場收益最高</label>
              <label><input type="radio" name="songPick" value="minute" ${s.songPick === "minute" ? "checked" : ""}>每分鐘收益最高</label>
            </div>
          </div>
          <label class="field" ${s.songPick === "minute" && !randomSong && !saved && !score ? "" : "hidden"}><span>每場額外時間（載入＋結算，秒）</span>
            <input type="number" id="pickOverhead" min="0" max="300" value="${s.songOverhead}" style="width:80px"></label>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="run" ${ownedM < 5 ? "disabled" : ""}>${saved ? "計算預存隊伍" : "計算最佳配隊"}</button>
          <span class="muted small">已登錄 成員卡 ${ownedM} 張 · 快照 ${ownedS} 張${ownedM < 5 ? " — 請先到「成員卡」分頁登錄至少 5 位角色" : ""}</span>
        </div>
      </div>
      <div id="results"></div>`;
    $("#event").onchange = (e) => {
      s.eventId = Number(e.target.value);
      saveSettings();
      renderAll();
    };
    el.querySelectorAll("input[name=mode]").forEach((r) => (r.onchange = () => {
      s.mode = r.value;
      saveSettings();
      renderCalc();
    }));
    el.querySelectorAll("input[name=objective]").forEach((r) => (r.onchange = () => {
      s.objective = r.value;
      saveSettings();
      renderCalc();
    }));
    $("#scoreSong").onchange = (e) => {
      s.scoreSong = Number(e.target.value) || 0;
      saveSettings();
    };
    el.querySelectorAll("input[name=diff]").forEach((c) => (c.onchange = () => {
      s.difficulties = [...el.querySelectorAll("input[name=diff]:checked")].map((x) => x.value);
      saveSettings();
    }));
    el.querySelectorAll("input[name=songPick]").forEach((r) => (r.onchange = () => {
      s.songPick = r.value;
      s.songSort = r.value;
      saveSettings();
      renderCalc();
    }));
    $("#pickOverhead").onchange = (e) => {
      s.songOverhead = clamp(Number(e.target.value), 0, 300);
      saveSettings();
    };
    el.querySelectorAll("input[name=multi]").forEach((r) => (r.onchange = () => {
      s.multi = r.value === "multi";
      saveSettings();
      renderCalc();
    }));
    el.querySelectorAll("input[name=multiSong]").forEach((r) => (r.onchange = () => {
      s.multiSong = r.value;
      saveSettings();
      renderCalc();
    }));
    $("#multiPlayers").onchange = (e) => {
      s.multiPlayers = clamp(Math.round(Number(e.target.value)), 2, 5);
      saveSettings();
    };
    $("#multiOthersAvg").onchange = (e) => {
      s.multiOthersAvg = clamp(Number(e.target.value), 0, 1e9);
      saveSettings();
    };
    $("#multiGekisouRank").onchange = (e) => {
      s.multiGekisouRank = clamp(Math.round(Number(e.target.value)), 1, 5);
      saveSettings();
    };
    $("#multiJustRate").onchange = (e) => {
      s.multiJustRate = clamp(Number(e.target.value), 0, 100);
      saveSettings();
    };
    $("#boosts").onchange = (e) => {
      s.boosts = clamp(Number(e.target.value), 0, 10);
      saveSettings();
    };
    $("#cp").onchange = (e) => {
      s.cp = Number(e.target.value);
      saveSettings();
    };
    $("#maxLevel").onchange = (e) => {
      s.maxLevel = clamp(Number(e.target.value), 1, 40);
      saveSettings();
    };
    $("#perfectRate").onchange = (e) => {
      s.perfectRate = clamp(Number(e.target.value), 50, 100);
      saveSettings();
    };
    $("#comboBreaks").onchange = (e) => {
      s.comboBreaks = clamp(Number(e.target.value), 0, 20);
      saveSettings();
    };
    $("#run").onclick = calculate;
    if (state.lastResults && state.lastResults.eventId === ev._id) renderResults(state.lastResults);
  }

  // A multiplayer live's song: a public room draws it ("saved": a saved deck per Gekisou range type, see the worker's
  // savedDecks; "random": one deck for every song, Engine.search multi without pickSong), a private room picks it. The
  // score objective has no one-deck mode. null for other lives.
  const multiSongOf = (s) => {
    if (s.mode !== "normal" || !s.multi) return null;
    if (s.multiSong === "pick") return "pick";
    return s.multiSong === "random" && s.objective !== "score" ? "random" : "saved";
  };
  const randomSongOf = (s) => multiSongOf(s) === "random";
  const savedOf = (s) => multiSongOf(s) === "saved";

  // The score objective's song list: a challenge live's songs (each has its own score ranking), or every song released.
  function scoreSongOptions(s, ev) {
    const now = new Date();
    const ids = s.mode === "challenge"
      ? state.master.t.MasterChallengeMusic.filter((r) => r._eventId === ev._id).map((r) => r._liveMusicId)
      : state.master.t.MasterLiveMusic.filter((mu) => !mu._startAt || Engine.parseTime(mu._startAt) <= now)
        .sort((a, b) => b._id - a._id).map((mu) => mu._id);
    const all = s.mode === "challenge" ? `全部挑戰曲（${ids.length} 首）` : "全部歌曲（自動挑選）";
    return `<option value="0">${esc(all)}</option>` +
      ids.map((id) => `<option value="${id}" ${id === s.scoreSong ? "selected" : ""}>${esc(musicTitle(id))}</option>`).join("");
  }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, isFinite(x) ? x : a));

  async function calculate() {
    const s = state.settings;
    const ev = currentEvent();
    const btn = $("#run");
    btn.disabled = true;
    btn.textContent = "計算中…";
    const score = s.objective === "score";
    const saved = savedOf(s);
    const challengeSongs = state.master.t.MasterChallengeMusic.filter((r) => r._eventId === ev._id).map((r) => r._liveMusicId);
    const scoreSong = score && !saved && s.scoreSong && (s.mode !== "challenge" || challengeSongs.includes(s.scoreSong)) ? s.scoreSong : 0;
    const input = {
      mode: s.mode,
      members: Object.entries(state.roster.members).map(([id, o]) => ({
        id: Number(id), level: o.level, awake: o.awake || 1, rank: o.rank || 1, skillLevel: o.skillLevel || 1, gekisouSkillLevel: o.gekisouSkillLevel || 1,
      })),
      snaps: Object.entries(state.roster.snaps).map(([id, o]) => ({ id: Number(id), level: o.level, rank: o.rank || 1 })),
      player: state.roster.player,
      maxLevel: s.maxLevel,
      difficulties: s.difficulties,
      accuracy: { perfectRate: s.perfectRate / 100, breaks: s.comboBreaks },
      boosts: score ? 0 : s.mode === "challenge" ? s.cp : s.boosts,
      objective: s.objective,
      topK: s.topK,
      compareSongs: true,
      musicIds: scoreSong ? [scoreSong] : null,
      multi: s.mode === "normal" && s.multi
        ? {
          players: s.multiPlayers, othersScore: score ? 0 : s.multiOthersAvg * (s.multiPlayers - 1), gekisouRank: s.multiGekisouRank,
          justRate: s.multiJustRate / 100, pickSong: multiSongOf(s) === "pick",
        }
        : null,
      perMinute: s.songPick === "minute" && !randomSongOf(s) && !saved && !score ? { overhead: s.songOverhead } : null,
    };
    // The worker measures on the replay first (progress messages by stage): COMBO count-up shares and, for the score
    // objective, snap skills; saved decks then search and simulate.
    const STAGES = { combo: "量 COMBO 激奏數加成", rates: "模擬快照技能", search: "搜尋預存隊伍", simulate: "模擬預存隊伍" };
    const progress = (done, total, stage) => {
      if (btn.isConnected) btn.textContent = `${STAGES[stage] || STAGES.rates}… ${Math.floor((done / Math.max(1, total)) * 100)}%`;
    };
    try {
      // Normal lives also earn CP (by rank only). Value it at what the best challenge deck turns it into, so the
      // ranking weighs rank (CP) and point bonus together.
      let cpPlan = null;
      if (s.mode === "normal" && s.objective === "points") {
        const ch = await runSearch({ ...input, mode: "challenge", boosts: 200, topK: 1, compareSongs: false, perMinute: null }, ev._id);
        const best = ch.results && ch.results[0];
        if (best) {
          cpPlan = { value: best.points / 200, rankName: best.rankName, chart: best.chart, pointBonus: best.pointBonus };
          input.cpValue = cpPlan.value;
        }
      }
      const out = saved ? { ...(await runSaved(input, ev._id, progress)), saved: true } : await runSearch(input, ev._id, progress);
      songView.selected = null;
      savedView.selected = null;
      state.lastResults = { ...out, eventId: ev._id, mode: s.mode, input, cpPlan };
      renderResults(state.lastResults);
    } catch (e) {
      console.error(e);
      $("#results").innerHTML = `<div class="panel warn">計算失敗：${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = saved ? "計算預存隊伍" : "計算最佳配隊";
    }
  }

  // One deck's slots: each member (the leader in slot 2) and its snap, with their event bonuses outside the score
  // objective.
  function slotsHtml(d, scoreMode) {
    const s = state.settings;
    const m = state.master;
    return d.members
      .map((v, k) => {
        const c = m.memberCards.get(v.id);
        const sn = d.snaps[k];
        const sc = sn ? m.snaps.get(sn.id) : null;
        const b = cardBonus("member", v.id);
        const sb = sn ? cardBonus("snap", sn.id) : null;
        return `<div class="slot">
          ${k === 2 ? '<span class="leader">隊長</span>' : ""}
          <img class="m-img" loading="lazy" src="${Data.memberThumb(s.region, c._assetID)}" alt="">
          <div class="nm">${typeDot(c._cardType)} ${esc(cardName(c))}<br><span class="muted">${esc(memberTitle(c))} · Lv${v.level}</span>
          ${b.point && !scoreMode ? `<br><span class="tag-point">點數 +${pct(b.point)}</span>` : ""}</div>
          ${sc ? `<img class="s-img" loading="lazy" src="${Data.snapThumb(s.region, sc._assetID)}" alt="">
            <div class="nm">${typeDot(sc._cardType)} ${esc(cardName(sc))}<br><span class="muted">${esc(snapTitle(sc))} · Lv${sn.level}</span>
            ${sb && sb.item && !scoreMode ? `<br><span class="tag-item">道具 +${pct(sb.item)}</span>` : ""}</div>` : `<div class="nm muted">（無快照）</div>`}
        </div>`;
      })
      .join("");
  }

  // One deck: rank, payoff, song and the five slots. `label` heads the summary line; `key` finds the deck again for
  // the simulation line.
  function deckCard(d, label, key, unit, out) {
    const multi = out.input.multi;
    const scoreMode = out.input.objective === "score";
    const slots = slotsHtml(d, scoreMode);
    // A multiplayer score search ranks by the simulated score (d.sim): the search only estimates the Gekisou part.
    const shown = d.sim ? Math.round(d.sim.mean * d.accuracy) : d.estScore;
    const head = scoreMode
      ? `<div class="rank-badge" title="${multi ? "激奏分數不看評級" : "這個分數在該曲的評級"}">${multi ? "—" : esc(d.rankName)}</div>
        <div><div class="big">預估${out.gekisou ? "激奏" : ""}分數 <span class="points">${fmt(shown)}</span></div>
          <div class="small">${skillParts(d, true)}${d.sim && shown !== d.estScore ? `，模擬的激奏部分 ${shown > d.estScore ? "+" : ""}${fmt(shown - d.estScore)}` : ""}</div>
          <div class="muted small">${esc(label)} · 依你的準度的期望值（出場順序隨機）${out.input.mode === "challenge" ? " · 含活動數值加成" : ""}</div></div>`
      : null;
    return `<div class="result">
      <div class="result-head">
        ${head || `<div class="rank-badge" title="${d.random ? "多數歌曲的房間評級" : multi ? "預估房間評級" : "預估評級"}">${esc(d.rankName)}</div>
        <div><div class="big"><span class="points">${fmt(d.points)} pt</span>${
          d.cp ? ` · <span class="cp">${fmt(d.cp)} CP</span>` : ""
        } · <span class="items">${fmt(d.items)} 道具</span></div>
          ${rankDistLine(d)}
          ${
            out.cpPlan && d.cp
              ? `<div class="small">CP 換算約 ${fmt(Math.round(d.cpPoints))} pt，合計約 <b class="points">${fmt(Math.round(d.points + d.cpPoints))} pt</b></div>`
              : ""
          }
          ${
            d.minutes
              ? `<div class="small">每分鐘約 <b>${fmt(Math.round((out.input.objective === "items" ? d.items : d.points + (d.cpPoints || 0)) / d.minutes))} ${
                  out.input.objective === "items" ? "道具" : "pt"
                }</b>（一場約 ${mmss(d.minutes * 60)}，含載入＋結算 ${fmt(out.input.perMinute.overhead)} 秒）</div>`
              : ""
          }
          <div class="muted small">${esc(label)} · ${unit} · 點數加成 +${pct(d.pointBonus)} · 道具加成 +${pct(d.itemBonus)}</div></div>`}
        <div style="margin-left:auto;text-align:right">${d.random ? randomSide(d, out) : scoreMode ? scoreSide(d, key, out) : chartSide(d, key, out)}</div>
      </div>
      <div class="slots">${slots}</div>
    </div>`;
  }

  // The song side of a deck card: the chart, the power against the rank's need and the simulation line.
  function chartSide(d, key, out) {
    const multi = out.input.multi;
    const margin = d.needDisplayPower > 0 ? d.displayPower / d.needDisplayPower - 1 : null;
    return `<div><b>${esc(musicTitle(d.chart.musicId))}</b> ${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</div>
      <div class="small">預估綜合力 <b>${fmt(d.displayPower)}</b>（${
        margin === null
          ? `${esc(d.rankName)} 靠其他玩家的分數就夠`
          : `${esc(d.rankName)} 需要 ${fmt(d.needDisplayPower)}，餘裕 <span class="${margin < 0.03 ? "warn" : ""}">${(margin * 100).toFixed(1)}%</span>`
      }）</div>
      ${d.nextRankName ? `<div class="small muted">${esc(d.nextRankName)} 需要 ${fmt(d.nextNeedDisplayPower)}</div>` : ""}
      <div class="small muted">預估${out.gekisou ? "激奏" : ""}分數約 ${fmt(d.estScore)}${skillParts(d)}${
        multi ? `，房間總分約 ${fmt(d.estScore + multi.othersScore)}（${multi.players} 人）` : ""
      }</div>
      ${state.worker && state.replay ? `<div class="small sim" data-sim="${key}">模擬中…</div>` : ""}`;
  }

  // The song side of a deck card for the score objective: the chart, the power and the simulation line.
  function scoreSide(d, key, out) {
    return `<div><b>${esc(musicTitle(d.chart.musicId))}</b> ${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</div>
      <div class="small">預估綜合力 <b>${fmt(d.displayPower)}</b>${out.input.multi ? "（含歌曲加成；激奏編成畫面不含）" : ""}</div>
      ${state.worker && state.replay ? `<div class="small sim" data-sim="${key}">模擬中…</div>` : ""}`;
  }

  // A multiplayer deck ranked over random songs: no chart, the formation screen's power (no song bonus).
  function randomSide(d, out) {
    return `<div><b>隨機選歌</b>（${fmt(d.songCount)} 首平均）</div>
      <div class="small">綜合力 <b>${fmt(d.displayPower)}</b>（激奏編成畫面，不含歌曲加成）</div>
      <div class="small muted">平均預估${out.gekisou ? "激奏" : ""}分數約 ${fmt(d.estScore)}${skillParts(d)}</div>
      <div class="small muted">各首歌的評級、模擬分數在下方「歌曲比較」</div>`;
  }

  // What the skills add to the estimated score: live skills, snap skills (measured in the score objective, a rough
  // estimate of the live skill extension in points), and with Gekisou the members' Gekisou skills and the snaps'
  // Gekisou support skills. `bare`: without the parentheses, after the no-skill score.
  function skillParts(d, bare) {
    const gk = d.gekisouScore || 0;
    const gkSnap = d.gekisouSupportScore || 0;
    const snap = d.snapScore || 0;
    const live = d.baseScore ? d.estScore - d.baseScore - gk - gkSnap - snap : 0;
    const parts = [];
    if (live > 0) parts.push(`演出技能 +${fmt(live)}`);
    if (snap > 0) parts.push(`快照技能${d.snapRough ? "（粗估）" : ""} +${fmt(snap)}`);
    if (gk > 0) parts.push(`激奏技能 +${fmt(gk)}`);
    if (gkSnap > 0) parts.push(`快照激奏技能 +${fmt(gkSnap)}`);
    if (bare) return [`無技能 ${fmt(d.baseScore)}`].concat(parts).join("，");
    return parts.length ? `（${parts.join("，")}）` : "";
  }

  // With combo breaks the search ranks by the expected payoff: the chance of each rank it may reach.
  function rankDistLine(d) {
    if (d.random) {
      const parts = d.rankDist.map((x) => `${esc(x.rankName)} ${Math.round(x.p * 100)}%`).join("、");
      return `<div class="small">各首歌的房間評級：${parts}；點數、道具和 CP 是所有歌的平均</div>`;
    }
    if (!d.rankDist || d.rankDist.length < 2) return "";
    const parts = d.rankDist.map((x) => `${esc(x.rankName)} ${Math.round(x.p * 100)}%`).join("、");
    return `<div class="small">依你的準度（斷 combo 的位置不同）：${parts}，數字是期望值</div>`;
  }

  const resultUnit = (out) =>
    out.input.objective === "score" ? "每場" : out.mode === "challenge" ? `每次（${state.settings.cp} CP）` : `每場（${out.input.boosts} 個加成道具，倍率 ×${out.rate}）`;

  function renderResults(out) {
    const el = $("#results");
    if (!el) return;
    if (out.saved && !out.error) return renderSaved(out);
    if (out.error === "no-charts") {
      el.innerHTML = `<div class="panel warn">沒有符合條件的譜面（或譜面缺少計分資料）。請放寬等級或難度。</div>`;
      return;
    }
    if (out.error === "not-enough-characters") {
      el.innerHTML = `<div class="panel warn">持有的成員卡不足 5 位不同角色。</div>`;
      return;
    }
    const s = state.settings;
    const unit = resultUnit(out);
    const decks = new Map();
    const cards = out.results
      .map((d, i) => {
        decks.set("r" + i, d);
        return deckCard(d, `#${i + 1}`, "r" + i, unit, out);
      })
      .join("");
    const hasSongs = out.songs && out.songs.length > 0;
    const note = out.input.objective === "score" ? scoreNote(out, hasSongs) : null;
    el.innerHTML = `<div class="panel">
        <h2>結果</h2>
        ${note || `<p class="note">預估分數＝全 Perfect 的計分資料加上演出技能和快照技能的期望加分（發動順序每場隨機），再依準度（Perfect 率 ${s.perfectRate}%、每場斷 combo ${s.comboBreaks} 次）打折。
        這裡的快照技能是粗估：快照延長演出技能的秒數 ÷ 5 秒 × 那位成員的演出技能加分，和整場模擬差約 ±15%（換成總分在 1% 以內）。
        有斷 combo 時分數會隨斷的位置變動（斷在中段最傷），排名改用各評級機率加權的期望收益，餘裕太小、可能掉級的隊伍會排在後面。
        「模擬分數」用 ournotes-deck 的整場模擬算出 120 種發動順序的分數（快照技能逐格計算），評級機率同時考慮發動順序和斷 combo 的位置。
        餘裕小於 3% 的隊伍，實際可能差一級。${
          out.input.multi
            ? `<br>多人（激奏）：活動點數、道具和 CP 看的是<b>房間評級</b>（結算畫面右上角的大徽章），不是自己分數的評級。房間評級＝全房總分對照該曲的多人門檻（依人數調整）；這裡用「自己的預估分數＋其他 ${out.input.multi.players - 1} 人 × ${fmt(state.settings.multiOthersAvg)}」估算。其他玩家的分數通常佔大部分，所以加成高的隊伍比綜合力高的隊伍划算。${
                out.random
                  ? `公開房的歌是抽出來的（直接開始隨機，自己選歌也要和其他人選的歌一起抽），所以隊伍依<b>所有 ${fmt((out.stats && out.stats.songs) || 0)} 首歌的平均收益</b>排名，每首歌都打允許的難度裡收益最好的譜面；綜合力是激奏編成畫面顯示的（還沒選歌，不含歌曲加成）。第 1 名的隊伍在各首歌的評級在下方「歌曲比較」。抽完歌後約 10 秒內還能換成存好的編組，「激奏的歌」選「預存隊伍」可以依激奏區間的種類各算一隊；私人房可以指定歌曲，請改成「自己選」。`
                  : `這裡假設是<b>私人房，自己指定歌曲</b>，所以和單人一樣挑最划算的歌；公開房的歌是抽出來的，請把「激奏的歌」改成「預存隊伍」或「一隊打全部」。`
              }${
                out.gekisou
                  ? `<br>自己的分數用<b>開激奏</b>的分數：JUST 區間打出 JUST（JUST 率 ${Math.round(out.gekisou.justRate * 100)}%）、每段激奏結束時依名次加成（三段都假設第 ${out.gekisou.rank} 名），再加上成員卡的激奏技能和快照的激奏技能。結算畫面大字的 SCORE 是不含激奏的分數（存成最高分），比這裡低很多。激奏技能在搜尋裡是估計值：各技能分開量再相加，未滿級的依模擬換算，JUST 區間「每個 JUST 累積加分」的快照依 JUST 率和上限換算；成員的 LUCK 量條技能讓 RUSH 變多、快照的 RUSH 加分跟著變多（用平均比例，單首歌可能差幾 %），COMBO 激奏數 UP 讓快照的 COMBO 累積加分疊得更快（逐首模擬量）。「模擬分數」逐格模擬，包含成員的激奏技能和快照的激奏技能。`
                  : ""
              }`
            : ""
        }${
          out.cpPlan
            ? `<br>一般 Live 拿到的 CP 只看評級（不吃加成），排名時已換算成 pt 一起比較：用目前最佳的挑戰隊（${esc(out.cpPlan.rankName)}、點數加成 +${pct(out.cpPlan.pointBonus)}、${esc(musicTitle(out.cpPlan.chart.musicId))} ${DIFF_NAMES[out.cpPlan.chart.difficulty]}）清 CP，1 CP ≈ ${out.cpPlan.value.toFixed(1)} pt。挑戰隊請切到「挑戰 Live」模式查看。`
            : ""
        }${
          out.input.perMinute
            ? `<br>選歌依「每分鐘收益」：每支隊伍都改選每分鐘（歌曲長度＋每場額外 ${fmt(out.input.perMinute.overhead)} 秒）賺最多的歌和評級，所以可能故意選短歌、拿低一級的評級。LB 有限、會用完的話，請改回「每場收益最高」。`
            : ""
        }${hasSongs ? "各首歌的比較在下方「歌曲比較」。" : ""}搜尋了 ${fmt(out.stats ? out.stats.sets : 0)} 種成員組合，耗時 ${out.stats ? out.stats.ms : "?"} ms。</p>`}
      </div>${cards || '<div class="panel">沒有結果。</div>'}${hasSongs ? `<div class="panel" id="songs"></div><div id="song-deck"></div>` : ""}`;
    fillSims(el, decks, out);
    if (hasSongs) renderSongs(out);
  }

  // The explanation above the score objective's results.
  function scoreNote(out, hasSongs) {
    const s = state.settings;
    const challenge = out.input.mode === "challenge";
    const multi = out.input.multi;
    const parts = [
      `只看分數：不計活動點數和道具，找預估分數最高的隊伍${out.input.musicIds ? "" : "和歌曲"}（限「可穩定打的最高等級」和勾選的難度內）。${
        challenge
          ? "挑戰 Live 的綜合力和分數含活動的「數值」加成（已用結算畫面驗證），歌曲屬性用挑戰曲指定的屬性。每首挑戰曲各有分數排行榜，記錄各難度中最高的一次。"
          : "一般 Live 的分數不含活動加成。"
      }`,
      `預估分數＝全 Perfect 的無技能分數＋演出技能＋快照技能的期望加分，再依準度（Perfect 率 ${s.perfectRate}%、每場斷 combo ${s.comboBreaks} 次）打折。出場順序每場隨機，所以技能加分取 120 種順序的平均。`,
      out.snapSkills
        ? `快照技能（演出技能延長等）會影響分數好幾 %：搜尋前先用 ournotes-deck 的整場模擬量過每種「成員×快照」組合在這首歌的加分（同一資料版本只量一次），配快照時一起算。這套算法和 ournotes-deck 的精確搜尋比對過，最佳隊伍相同。`
        : `<span class="warn">這次沒能模擬快照技能${out.snapError ? `（${esc(out.snapError)}）` : ""}，排名沒算快照技能，可能不是最高分的隊伍。</span>`,
      `「模擬分數」逐格模擬整場，列出 120 種出場順序的平均和最高分（全 Perfect），以及依你的準度的平均。排行榜記錄的是你打過最高的一次，要靠全 Perfect 加上好的出場順序。`,
    ];
    if (multi) {
      parts.push(`多人（激奏）：用<b>開激奏</b>的分數（JUST 率 ${Math.round((out.gekisou ? out.gekisou.justRate : multi.justRate) * 100)}%、三段都第 ${out.gekisou ? out.gekisou.rank : multi.gekisouRank} 名），也就是房間合計用的分數。
        成員的激奏技能會觸發搭配快照的激奏技能，而且各成員之間會互相影響、不能逐對相加，所以先估計出 15 支候選隊伍，再逐一完整模擬、依模擬分數排名（候選外的隊伍沒有模擬，少數情況可能漏掉更好的）。
        結算畫面大字的 SCORE（存成最高分）不含激奏，和單人一樣，請用「單人」計算。`);
    }
    if (out.measuredSongs && out.songs.some((d) => d.approx)) {
      parts.push(`從全部歌曲找：先不含快照技能估每首歌，只精算最好的 ${out.measuredSongs.length} 首；「歌曲比較」裡標「粗估」的歌沒算快照技能（約少 5%），想精算請在上方「歌曲」選那首歌。`);
    }
    if (hasSongs) parts.push(challenge ? "各首挑戰曲的最佳隊伍在下方「歌曲比較」。" : "各首歌的最高分在下方「歌曲比較」。");
    parts.push(`搜尋了 ${fmt(out.stats ? out.stats.sets : 0)} 種成員組合，耗時 ${out.stats ? out.stats.ms : "?"} ms。`);
    return `<p class="note">${parts.join("<br>")}</p>`;
  }

  // Own score each rank needs: solo thresholds, or what the room's other players leave (as the search).
  function ownThresholds(d, out) {
    const multi = out.input.multi;
    if (!multi) return d.chart.thresholds;
    return d.chart.battle.map(([r, base]) => [Math.max(r, 2), Math.max(0, Engine.battleRequiredScore(base, multi.players) - (multi.othersScore || 0))]);
  }

  // The simulated scores with the play accuracy, and the chance of each rank over performance orders and breaks.
  function simLine(d, out, sim) {
    if (!sim) return '<span class="muted">這首歌沒有模擬資料。</span>';
    const acc = out.input.accuracy || { perfectRate: 1, breaks: 0 };
    const shares = Engine.playShares(state.master, d.chart.scoreId, acc);
    const meanShare = shares.reduce((a, [x, w]) => a + x * w, 0);
    const lo = Math.min(...shares.map(([x]) => x));
    const hi = Math.max(...shares.map(([x]) => x));
    const sc = sim.scores;
    const need = new Map();
    for (const [r, req] of ownThresholds(d, out)) if (!need.has(r) || req < need.get(r)) need.set(r, req);
    // P(order score x share >= req): per order, the weight of the shares of at least req / score.
    const sorted = shares.slice().sort((a, b) => a[0] - b[0]);
    const tail = new Float64Array(sorted.length + 1);
    for (let i = sorted.length - 1; i >= 0; i--) tail[i] = tail[i + 1] + sorted[i][1];
    const atLeast = (x) => {
      let a = 0;
      let b = sorted.length;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (sorted[mid][0] < x) a = mid + 1;
        else b = mid;
      }
      return tail[a];
    };
    const chance = [...need]
      .map(([r, req]) => [r, Math.min(1, sc.reduce((a, x) => a + atLeast(req / x), 0) / sc.length)])
      .map(([r, p]) => [r, p > 0.9995 ? 1 : p < 0.0005 ? 0 : p])
      .sort((a, b) => b[0] - a[0]);
    const name = (r) => Engine.RANK_NAMES[r] || String(r);
    const top = chance.find(([, p]) => p > 0);
    const sure = chance.find(([, p]) => p === 1);
    const likely = chance.find(([, p]) => p >= 0.5);
    let text = "";
    if (top && sure && top[0] === sure[0]) text = `一定是 <b>${name(sure[0])}</b>`;
    else if (top) text = `<b>${name(top[0])}</b> 機率 ${Math.round(top[1] * 100)}%` + (sure ? `，否則 ${name(sure[0])}` : "");
    const differs = likely && likely[0] !== d.rank;
    const what = sim.gekisou && out.gekisou
      ? `開激奏模擬分數（每段第 ${out.gekisou.rank} 名、JUST 率 ${Math.round(out.gekisou.justRate * 100)}%，含快照與激奏技能）`
      : "模擬分數（含快照技能）";
    return `${what}全 Perfect 平均 ${fmt(Math.round(sim.mean))}；依你的準度平均 <b>${fmt(Math.round(sim.mean * meanShare))}</b>，` +
      `範圍 ${fmt(Math.round(sc[0] * lo))}–${fmt(Math.round(sc[sc.length - 1] * hi))}：${text}` +
      (differs ? `<span class="${likely[0] > d.rank ? "good" : "warn"}">（與上方預估的 ${esc(d.rankName)} 不同）</span>` : "");
  }

  // Score objective: the simulated score over the 120 performance orders, all Perfect and with the play accuracy.
  function scoreSimLine(d, out, sim) {
    if (!sim) return '<span class="muted">這首歌沒有模擬資料。</span>';
    const share = Engine.accuracyFactor(state.master, d.chart.scoreId, out.input.accuracy || null);
    const sc = sim.scores;
    const what = sim.gekisou && out.gekisou ? "開激奏模擬（含快照與激奏技能）" : "模擬（含快照技能）";
    return `${what}：全 Perfect 平均 <b>${fmt(Math.round(sim.mean))}</b>，最好的出場順序 ${fmt(sc[sc.length - 1])}，` +
      `一成的順序 ≥ ${fmt(sc[Math.floor(sc.length * 0.9)])}；依你的準度平均 ${fmt(Math.round(sim.mean * share))}`;
  }

  // Fills the simulation line of each rendered deck card once the worker answers.
  async function fillSims(el, decks, out) {
    if (!state.worker || !state.replay) return;
    const entries = [...decks].filter(([, d]) => d.chart).map(([key, d]) => ({ d, box: el.querySelector(`.sim[data-sim="${key}"]`) }));
    try {
      // A multiplayer score search comes with its decks simulated.
      const sims = entries.every((e) => e.d.sim) ? entries.map((e) => e.d.sim) : await simulateDecks(entries.map((e) => e.d), out.gekisou);
      entries.forEach((e, i) => {
        e.d.sim = sims[i];
        const line = out.input.objective === "score" ? scoreSimLine : simLine;
        if (e.box && e.box.isConnected) e.box.innerHTML = line(e.d, out, sims[i]);
      });
    } catch (err) {
      console.warn(err);
      for (const e of entries) if (e.box && e.box.isConnected) e.box.innerHTML = `<span class="muted">無法模擬：${esc(err.message)}</span>`;
    }
  }

  // --- song comparison ---

  const songView = { showAll: false, selected: null };
  const savedView = { q: "", sort: "type", selected: null };

  // --- saved decks (public rooms) ---

  // Gekisou range types (Engine.gekisouSongType) and missions.
  const GEKISOU_TYPES = { 1: { name: "全 COMBO", badge: "C" }, 2: { name: "全 LUCK", badge: "L" }, 3: { name: "全 JUST", badge: "J" }, 0: { name: "混合", badge: "混" } };
  const MISSION_SHORT = { 1: "COMBO", 2: "LUCK", 3: "JUST" };
  const missionsOf = (d) => {
    const b = d && d.chart && state.battle && state.battle.byScore.get(d.chart.scoreId);
    return b && b.missions ? b.missions.map((x) => MISSION_SHORT[x] || "?").join("・") : "—";
  };

  // A simulated payoff (the worker's simPay) as the number compared: the score (with the play accuracy), or points
  // (CP converted at the challenge deck's rate) or items.
  function savedValue(v, out) {
    if (!v) return null;
    if (out.input.objective === "score") return v.value;
    if (out.input.objective === "items") return v.items;
    return v.points + (v.cp || 0) * (out.input.cpValue || 0);
  }
  const savedUnit = (out) => (out.input.objective === "score" ? "" : out.input.objective === "items" ? " 道具" : " pt");
  // The compared number's name in a header: points include the CP at the challenge deck's rate.
  const savedWhat = (out) =>
    out.input.objective === "score" ? "" : out.input.objective === "items" ? "道具" : out.input.cpValue ? "pt，含 CP 換算" : "pt";
  const gapPct = (a, b) => (a > 0 ? `${b >= a ? "+" : ""}${((b / a - 1) * 100).toFixed(1)}%` : "—");

  function renderSaved(out) {
    const el = $("#results");
    const s = state.settings;
    const score = out.input.objective === "score";
    const u = savedUnit(out);
    const groups = out.groups || [];
    const songs = out.songs || [];
    const mean = (f) => {
      const xs = songs.map(f).filter((x) => x !== null && x !== undefined);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };
    const vSaved = mean((x) => savedValue(x.saved.simPay, out));
    const vBest = mean((x) => savedValue(x.best ? x.best.simPay : x.saved.simPay, out));
    const vAll = mean((x) => savedValue(x.all, out));
    const big = songs.filter((x) => x.best && savedValue(x.best.simPay, out) > 1.03 * savedValue(x.saved.simPay, out)).length;
    const gk = out.gekisou;
    const notes = [
      `公開房的歌是抽出來的，但抽完歌後大約有 10 秒可以換隊：來得及換成存好的編組，來不及重排卡片。遊戲可以存 50 組編組，同一張卡可以放在好幾組，所以這裡依<b>激奏三段的種類</b>把歌分成 ${groups.length} 組（全 COMBO、全 LUCK、全 JUST、混合），每組各找一隊。抽到歌時看三段激奏的種類，換成那組的隊伍。`,
      `每組先用搜尋找出該組歌曲平均最好的幾隊（估計值在第 1 名 5% 以內，最多 8 隊），再逐首用 ournotes-deck 的整場模擬比較，取平均最高的：每首歌模擬 ${out.runs ? out.runs.rank : 5} 局，每局換出場順序（5 局剛好每人每個位置各一次）；有 LUCK 區間的歌每局換抽選的種子，所有隊伍用同一批種子，所以兩隊的差距只差約 0.3%（單一隊伍每局差約 10%）。顯示的分數在 LUCK 歌用 ${out.runs ? out.runs.show : 10} 局（單首約 ±3%）。`,
      `激奏${score ? "分數" : ""}的條件：每段第 ${gk ? gk.rank : s.multiGekisouRank} 名、JUST 率 ${Math.round((gk ? gk.justRate : s.multiJustRate / 100) * 100)}%${score ? `，依你的準度（Perfect 率 ${s.perfectRate}%、斷 combo ${s.comboBreaks} 次）打折` : `；收益看房間評級（自己的模擬分數＋其他 ${out.input.multi.players - 1} 人 × ${fmt(s.multiOthersAvg)}），依你的準度算各評級的機率`}。`,
      `搜尋的估計已包含兩種成員激奏技能和快照激奏技能的交互作用：成員的 LUCK 量條技能讓 RUSH 變多，快照的 LUCKY RUSH 分數 UP 跟著多（全 LUCK 歌約 +17%、混合歌約 +32%）；成員的 COMBO 激奏數 UP 讓快照的激奏 COMBO 分數 UP 更快疊滿（依譜面逐首模擬量，可達 +30%～+190%）。`,
    ];
    if (score && !out.snapSkills) notes.push(`<span class="warn">這次沒能模擬快照技能${out.snapError ? `（${esc(out.snapError)}）` : ""}，搜尋的估計沒算快照技能。</span>`);
    if (!out.simulated) notes.push(`<span class="warn">沒有模擬資料，以下是搜尋的估計值，沒有用模擬比較候選。</span>`);
    const summary = songs.length
      ? `<p><b>全部 ${songs.length} 首歌的平均${out.simulated ? "（模擬" : "（估計"}${savedWhat(out) ? "，" + savedWhat(out) : ""}）</b>：一隊打全部 ${fmt(Math.round(vAll))}${u}
        → <b>${groups.length} 組預存 ${fmt(Math.round(vSaved))}${u}（${gapPct(vAll, vSaved)}）</b>
        → 每首都換成該歌的最佳隊 ${fmt(Math.round(vBest))}${u}（${gapPct(vAll, vBest)}）。
        ${big ? `有 ${big} 首歌換成該歌的最佳隊能多 3% 以上（下表標橘色），常抽到的話可以多存一隊。` : "每首歌用預存隊和用該歌最佳隊都差不到 3%，4 隊就夠了。"}</p>`
      : "";
    el.innerHTML = `<div class="panel">
        <h2>預存隊伍（公開房）</h2>
        <p class="note">${notes.join("<br>")}</p>
        ${summary}
        <p class="note muted">耗時 ${out.stats ? Math.round(out.stats.ms / 1000) : "?"} 秒（模擬 ${fmt((out.stats && out.stats.runs) || 0)} 局）。量過的資料會保留到重新整理頁面，改設定再算會快很多。</p>
      </div>
      ${groups.map((g) => savedCard(g, out)).join("")}
      <div class="panel" id="saved-songs"></div><div id="saved-deck"></div>`;
    renderSavedSongs(out);
  }

  // The deck saved for one Gekisou range type.
  function savedCard(g, out) {
    const t = GEKISOU_TYPES[g.type] || { name: String(g.type), badge: "?" };
    const titles = g.musicIds.map(musicTitle).sort((a, b) => a.localeCompare(b));
    if (!g.deck) return `<div class="panel warn">「${esc(t.name)}」的歌（${g.musicIds.length} 首）：找不到隊伍。</div>`;
    const d = g.deck;
    const v = d.simPay || {};
    const score = out.input.objective === "score";
    const what = out.simulated ? "模擬" : "估計";
    const value = score
      ? `平均${what}激奏分數 <span class="points">${fmt(Math.round(v.value))}</span>`
      : `<span class="points">${fmt(Math.round(v.points))} pt</span>${v.cp ? ` · <span class="cp">${fmt(Math.round(v.cp * 10) / 10)} CP</span>` : ""} · <span class="items">${fmt(Math.round(v.items))} 道具</span>`;
    const est = score ? `搜尋估計 ${fmt(Math.round(d.estScore))}` : `搜尋估計 ${fmt(d.points)} pt · ${fmt(d.items)} 道具`;
    return `<div class="result">
      <div class="result-head">
        <div class="rank-badge" title="${esc(t.name)}">${esc(t.badge)}</div>
        <div><div class="big">「${esc(t.name)}」的歌（${g.musicIds.length} 首）用這隊</div>
          <div class="small">${value}${score ? "（依你的準度）" : "（每場平均，" + what + "）"}；${est}</div>
          ${!score && out.input.objective !== "items" && v.cp && out.input.cpValue ? `<div class="small">CP 換算後合計約 <b class="points">${fmt(Math.round(v.points + v.cp * out.input.cpValue))} pt</b></div>` : ""}
          <div class="muted small">綜合力 ${fmt(d.displayPower)}（激奏編成畫面，不含歌曲加成）${score ? "" : ` · 點數加成 +${pct(d.pointBonus)} · 道具加成 +${pct(d.itemBonus)}`} · 比較了 ${g.pool.length} 支候選</div></div>
      </div>
      <div class="slots">${slotsHtml(d, score)}</div>
      <details class="small"><summary>這組的歌</summary><p>${titles.map(esc).join("、")}</p></details>
    </div>`;
  }

  // Song lookup: the saved deck a drawn song takes, and what the song's own best deck would add.
  function renderSavedSongs(out) {
    const el = $("#saved-songs");
    if (!el) return;
    const order = [1, 2, 3, 0];
    const q = savedView.q.trim().toLowerCase();
    const rows = (out.songs || [])
      .map((x) => {
        const sv = savedValue(x.saved.simPay, out);
        const bv = x.best ? savedValue(x.best.simPay, out) : sv;
        return { x, title: musicTitle(x.musicId), sv, bv, gap: sv > 0 ? bv / sv - 1 : 0 };
      })
      .filter((r) => !q || r.title.toLowerCase().includes(q));
    if (savedView.sort === "gap") rows.sort((a, b) => b.gap - a.gap);
    else rows.sort((a, b) => order.indexOf(a.x.type) - order.indexOf(b.x.type) || a.title.localeCompare(b.title));
    const body = rows
      .map((r) => {
        const d = r.x.saved;
        const t = GEKISOU_TYPES[r.x.type] || { name: "?" };
        const rank = !(out.input.objective === "score") && d.simPay && d.simPay.rankDist
          ? d.simPay.rankDist.filter(([, p]) => p >= 0.005).map(([rk, p]) => `${RANK_LABEL[rk] || rk}${p < 0.995 ? ` ${Math.round(p * 100)}%` : ""}`).join("、")
          : "";
        return `<tr class="song-row ${r.x.musicId === savedView.selected ? "sel" : ""}" data-id="${r.x.musicId}">
          <td><b>${esc(r.title)}</b> <span class="muted small">${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</span></td>
          <td class="small">${esc(missionsOf(d))}</td>
          <td>${esc(t.name)}</td>
          <td class="num"><b>${fmt(Math.round(r.sv))}</b>${rank ? `<br><span class="muted small">${esc(rank)}</span>` : ""}</td>
          <td class="num">${fmt(Math.round(r.bv))}</td>
          <td class="num ${r.gap > 0.03 ? "warn" : r.gap <= 0.001 ? "muted" : ""}">${r.gap > 0.001 ? "+" + (r.gap * 100).toFixed(1) + "%" : "已是最佳"}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<h2>抽到的歌 → 用哪一隊</h2>
      <p class="note">每首歌用哪一組的預存隊，以及${out.simulated ? "模擬" : "估計"}的${out.input.objective === "score" ? "激奏分數（依你的準度）" : "每場收益"}。「該歌最佳隊」是只打這首歌時搜尋出來最好的隊伍；差距大的歌可以多存一隊。點一列可看兩支隊伍打這首歌的細節。</p>
      <div class="row" style="margin-bottom:8px">
        <label class="field"><span>搜尋歌名</span><input type="text" id="savedQ" value="${esc(savedView.q)}" placeholder="歌名" style="width:180px"></label>
        <div class="field"><span>排序</span><div class="chips">
          <label><input type="radio" name="savedSort" value="type" ${savedView.sort !== "gap" ? "checked" : ""}>依組別</label>
          <label><input type="radio" name="savedSort" value="gap" ${savedView.sort === "gap" ? "checked" : ""}>依差距</label>
        </div></div>
      </div>
      <div class="table-scroll"><table class="rules songs">
        <thead><tr><th>歌曲</th><th>激奏三段</th><th>用哪一隊</th><th class="num">預存隊${savedWhat(out) ? `（${savedWhat(out)}）` : ""}</th><th class="num">該歌最佳隊</th><th class="num">差距</th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
    const qEl = $("#savedQ");
    qEl.oninput = (e) => {
      savedView.q = e.target.value;
      renderSavedSongs(out);
      const again = $("#savedQ");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    };
    el.querySelectorAll("input[name=savedSort]").forEach((r) => (r.onchange = () => ((savedView.sort = r.value), renderSavedSongs(out))));
    el.querySelectorAll(".song-row").forEach((tr) => (tr.onclick = () => {
      const id = Number(tr.dataset.id);
      savedView.selected = savedView.selected === id ? null : id;
      renderSavedSongs(out);
    }));
    renderSavedDeck(out);
  }

  function renderSavedDeck(out) {
    const el = $("#saved-deck");
    if (!el) return;
    const x = (out.songs || []).find((r) => r.musicId === savedView.selected);
    if (!x) {
      el.innerHTML = "";
      return;
    }
    const title = musicTitle(x.musicId);
    const t = GEKISOU_TYPES[x.type] || { name: "?" };
    const decks = new Map([["sv", x.saved]]);
    let html = deckCard(x.saved, `「${t.name}」組的預存隊打 ${title}`, "sv", resultUnit(out), out);
    if (x.best) {
      decks.set("sb", x.best);
      html += deckCard(x.best, `${title} 的最佳隊`, "sb", resultUnit(out), out);
    }
    el.innerHTML = html;
    fillSims(el, decks, out);
  }
  const mmss = (sec) => {
    const t = Math.round(sec);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  const SONG_LIMIT = 15;

  function renderSongs(out) {
    if (out.input.objective === "score") return renderScoreSongs(out);
    const el = $("#songs");
    const s = state.settings;
    const items = out.input.objective === "items";
    const value = (d) => (items ? d.items : d.points + (d.cpPoints || 0));
    const perMin = (d) => (d.chart.lengthSec ? (value(d) * 60) / (d.chart.lengthSec + s.songOverhead) : null);
    const rows = out.songs.map((d, k) => ({ d, k, v: value(d), pm: perMin(d) }));
    const byLive = rows.slice().sort((a, b) => b.v - a.v || (b.pm || 0) - (a.pm || 0));
    const byMin = rows.slice().sort((a, b) => (b.pm || 0) - (a.pm || 0) || b.v - a.v);
    const list = s.songSort === "minute" ? byMin : byLive;
    const bestLive = byLive[0].v;
    const bestMin = byMin[0].pm;
    const shown = songView.showAll ? list : list.slice(0, SONG_LIMIT);
    if (songView.selected !== null && !shown.some((r) => r.k === songView.selected)) {
      const sel = list.find((r) => r.k === songView.selected);
      if (sel) shown.push(sel);
    }
    const u = items ? "道具" : "pt";
    const body = shown
      .map((r) => {
        const d = r.d;
        const margin = d.needDisplayPower > 0 ? d.displayPower / d.needDisplayPower - 1 : null;
        const len = d.chart.lengthSec;
        const parts = !items && d.cp ? `<br><span class="muted small">${fmt(d.points)} pt + ${fmt(d.cp)} CP</span>` : "";
        const tags = out.random ? "" :
          (r.v === bestLive ? '<span class="song-best">每場最佳</span>' : "") +
          (r.pm !== null && r.pm === bestMin ? '<span class="song-best">每分鐘最佳</span>' : "");
        return `<tr class="song-row ${r.k === songView.selected ? "sel" : ""}" data-k="${r.k}">
          <td class="num">${list.indexOf(r) + 1}</td>
          <td><b>${esc(musicTitle(d.chart.musicId))}</b> <span class="muted small">${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</span>${tags}</td>
          <td>${esc(d.rankName)}${d.rankChance !== null && d.rankChance !== undefined && d.rankChance < 0.995 ? ` <span class="muted small">${Math.round(d.rankChance * 100)}%</span>` : ""}</td>
          <td class="num"><b>${fmt(Math.round(r.v))}</b>${parts}</td>
          <td class="num">${len ? mmss(len) : "—"}</td>
          <td class="num">${r.pm !== null ? fmt(Math.round(r.pm)) : "—"}</td>
          <td class="num">${margin === null ? "—" : `<span class="${margin < 0.03 ? "warn" : ""}">${(margin * 100).toFixed(1)}%</span>`}</td>
          <td class="num muted">${d.nextRankName ? `${esc(d.nextRankName)}：${fmt(d.nextNeedDisplayPower)}` : "—"}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<h2>歌曲比較</h2>
      <p class="note">${
        out.random
          ? `推薦第 1 名的隊伍打每一首歌的房間評級和收益（${esc(resultUnit(out))}）。同一支隊伍，歌曲的屬性和標籤加成不同，綜合力也不同。激奏的歌是抽出來的，選不了歌；這張表只是讓你知道抽到哪些歌拿得到哪個評級。點一列可看這支隊伍打那首歌的模擬分數。`
          : `每首歌各自配出最佳隊伍後的收益（${esc(resultUnit(out))}）。活動點數只看評級和加成、不看分數多寡，所以「每場」最高的通常是評級門檻相對低、最容易衝上高一級的歌。
      LB 會用完的話看「每場」；時間有限、LB 用不完的話看「每分鐘」＝每場 ÷（歌曲長度＋每場額外時間）。點一列可看那首歌的隊伍。`
      }</p>
      <div class="row" style="margin-bottom:8px">
        <div class="field"><span>排序</span><div class="chips">
          <label><input type="radio" name="songSort" value="live" ${s.songSort !== "minute" ? "checked" : ""}>每場</label>
          <label><input type="radio" name="songSort" value="minute" ${s.songSort === "minute" ? "checked" : ""}>每分鐘</label>
        </div></div>
        <label class="field"><span>每場額外時間（載入＋結算，秒）</span>
          <input type="number" id="songOverhead" min="0" max="300" value="${s.songOverhead}" style="width:80px">${out.input.perMinute ? '<span class="muted small">（上方推薦隊伍要重新計算才會套用）</span>' : ""}</label>
      </div>
      <div class="table-scroll"><table class="rules songs">
        <thead><tr><th>#</th><th>歌曲</th><th>評級</th><th class="num">每場（${u}）</th><th class="num">長度</th><th class="num">每分鐘（${u}）</th><th class="num">餘裕</th><th class="num">下一級需要</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${list.length > SONG_LIMIT ? `<p><button class="ghost small" id="songMore">${songView.showAll ? `只顯示前 ${SONG_LIMIT} 首` : `顯示全部 ${list.length} 首`}</button></p>` : ""}`;
    el.querySelectorAll("input[name=songSort]").forEach((r) => (r.onchange = () => {
      s.songSort = r.value;
      saveSettings();
      renderSongs(out);
    }));
    $("#songOverhead").onchange = (e) => {
      s.songOverhead = clamp(Number(e.target.value), 0, 300);
      saveSettings();
      renderSongs(out);
    };
    const more = $("#songMore");
    if (more) more.onclick = () => ((songView.showAll = !songView.showAll), renderSongs(out));
    el.querySelectorAll(".song-row").forEach((tr) => (tr.onclick = () => {
      const k = Number(tr.dataset.k);
      songView.selected = songView.selected === k ? null : k;
      renderSongs(out);
    }));
    renderSongDeck(out);
  }

  // Score objective: each song's highest expected score.
  function renderScoreSongs(out) {
    const el = $("#songs");
    const list = out.songs.map((d, k) => ({ d, k })).sort((a, b) => b.d.score - a.d.score);
    const shown = songView.showAll ? list : list.slice(0, SONG_LIMIT);
    if (songView.selected !== null && !shown.some((r) => r.k === songView.selected)) {
      const sel = list.find((r) => r.k === songView.selected);
      if (sel) shown.push(sel);
    }
    const body = shown
      .map((r) => {
        const d = r.d;
        return `<tr class="song-row ${r.k === songView.selected ? "sel" : ""}" data-k="${r.k}">
          <td class="num">${list.indexOf(r) + 1}</td>
          <td><b>${esc(musicTitle(d.chart.musicId))}</b> <span class="muted small">${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</span>${
            d.approx ? '<span class="song-best muted" title="沒算快照技能，實際約高 5%">粗估</span>' : ""
          }</td>
          <td class="num"><b>${fmt(d.estScore)}</b></td>
          <td class="num small">${skillParts(d, true)}</td>
          <td class="num">${fmt(d.displayPower)}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<h2>歌曲比較</h2>
      <p class="note">每首歌各自配出分數最高的隊伍後的預估分數（同一首歌只列分數最高的難度；依你的準度的期望值）。點一列可看那首歌的隊伍和模擬分數。</p>
      <div class="table-scroll"><table class="rules songs">
        <thead><tr><th>#</th><th>歌曲</th><th class="num">預估分數</th><th class="num">組成</th><th class="num">綜合力</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${list.length > SONG_LIMIT ? `<p><button class="ghost small" id="songMore">${songView.showAll ? `只顯示前 ${SONG_LIMIT} 首` : `顯示全部 ${list.length} 首`}</button></p>` : ""}`;
    const more = $("#songMore");
    if (more) more.onclick = () => ((songView.showAll = !songView.showAll), renderSongs(out));
    el.querySelectorAll(".song-row").forEach((tr) => (tr.onclick = () => {
      const k = Number(tr.dataset.k);
      songView.selected = songView.selected === k ? null : k;
      renderSongs(out);
    }));
    renderSongDeck(out);
  }

  function renderSongDeck(out) {
    const el = $("#song-deck");
    const d = songView.selected !== null ? out.songs[songView.selected] : null;
    if (!d) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = deckCard(d, out.random ? `推薦 #1 打 ${musicTitle(d.chart.musicId)}` : `${musicTitle(d.chart.musicId)} 的最佳隊伍`, "s", resultUnit(out), out);
    fillSims(el, new Map([["s", d]]), out);
  }

  // --- card pickers ---

  function pickerToolbar(kind) {
    const f = state.filters[kind];
    const bands = state.master.t.MasterBand.map((b) => `<option value="${b._id}" ${String(b._id) === f.band ? "selected" : ""}>${esc(T(b._nameTextID))}</option>`).join("");
    const rar = kind === "m" ? [2, 3, 4] : [2, 3, 4, 10];
    return `<div class="toolbar">
      <select class="f-band"><option value="">全部樂團</option>${bands}</select>
      <select class="f-rarity"><option value="">全部稀有度</option>${rar.map((r) => `<option value="${r}" ${String(r) === f.rarity ? "selected" : ""}>${rarityName(r)}</option>`).join("")}</select>
      <label><input type="checkbox" class="f-owned" ${f.owned ? "checked" : ""}> 只顯示已持有</label>
      <label><input type="checkbox" class="f-bonus" ${f.bonus ? "checked" : ""}> 只顯示有活動加成</label>
      <input type="text" class="f-q" placeholder="搜尋名稱" value="${esc(f.q)}">
      <span class="muted small">點圖片切換「持有」。有 ？ 的是從截圖推測的，請確認。</span>
    </div>`;
  }

  function bindToolbar(el, kind, rerender) {
    const f = state.filters[kind];
    $(".f-band", el).onchange = (e) => ((f.band = e.target.value), rerender());
    $(".f-rarity", el).onchange = (e) => ((f.rarity = e.target.value), rerender());
    $(".f-owned", el).onchange = (e) => ((f.owned = e.target.checked), rerender());
    $(".f-bonus", el).onchange = (e) => ((f.bonus = e.target.checked), rerender());
    $(".f-q", el).oninput = debounce((e) => ((f.q = e.target.value), rerender(true)), 250);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function renderMembers(keepFocus) {
    const el = $("#tab-members");
    const m = state.master;
    const f = state.filters.m;
    const bandOf = (c) => (m.characters.get(c._characterID) || {})._bandID || 0;
    const list = m.t.MasterMemberCard.slice().sort((a, b) => bandOf(a) - bandOf(b) || b._rarity - a._rarity || a._characterID - b._characterID || a._id - b._id);
    const tiles = [];
    for (const c of list) {
      const own = state.roster.members[c._id];
      const b = cardBonus("member", c._id);
      if (f.band && String(bandOf(c)) !== f.band) continue;
      if (f.rarity && String(c._rarity) !== f.rarity) continue;
      if (f.owned && !own) continue;
      if (f.bonus && !b.point && !b.item) continue;
      if (f.q && !(cardName(c) + memberTitle(c)).includes(f.q)) continue;
      const lim = Engine.memberLimits(m, c);
      const awake = own ? own.awake || 1 : 1;
      tiles.push(`<div class="tile m ${own ? "owned" : ""} ${own && own.guess ? "guess" : ""}" data-id="${c._id}">
        <div class="pic"><img loading="lazy" src="${Data.memberThumb(state.settings.region, c._assetID)}" alt="">
          <span class="check">${own ? "✓" : ""}</span>
          <div class="badges">${b.point ? `<span class="badge point">♪ +${pct(b.point)}</span>` : ""}${b.item ? `<span class="badge item">道具 +${pct(b.item)}</span>` : ""}</div></div>
        <div class="info"><div class="nm">${typeDot(c._cardType)} ${esc(cardName(c))}</div><div class="st">${rarityName(c._rarity)} ${esc(memberTitle(c))}</div></div>
        ${own ? `<div class="ctl">
          <span>等級</span><div class="lv"><input type="number" class="c-level" min="1" max="${lim.limit(awake)}" value="${own.level}">
            <button class="small ghost c-max" title="等級拉到目前特訓上限">Max</button></div>
          <span>特訓</span><select class="c-awake">${range(1, lim.maxAwake).map((a) => `<option ${a === awake ? "selected" : ""}>${a}</option>`).join("")}</select>
          <span>覺醒</span><select class="c-rank">${range(1, 5).map((r) => `<option value="${r}" ${r === (own.rank || 1) ? "selected" : ""}>${r}</option>`).join("")}</select>
          <span title="${esc(liveSkillName(c))}">演出技能</span><select class="c-skill" title="${esc(liveSkillName(c))}">${range(1, m.liveSkillMaxLevel.get(c._liveSkillID) || 1).map((l) => `<option ${l === (own.skillLevel || 1) ? "selected" : ""}>${l}</option>`).join("")}</select>
          <span title="${esc(gekisouSkillName(c))}">激奏技能</span><select class="c-gskill" title="${esc(gekisouSkillName(c))}">${range(1, m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1).map((l) => `<option ${l === (own.gekisouSkillLevel || 1) ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>` : ""}
      </div>`);
    }
    el.innerHTML = `<div class="panel">${pickerToolbar("m")}<div class="grid">${tiles.join("") || '<p class="muted">沒有符合的卡片。</p>'}</div></div>`;
    bindToolbar(el, "m", (typing) => {
      renderMembers(typing);
    });
    if (keepFocus) {
      const q = $(".f-q", el);
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
    el.querySelectorAll(".tile").forEach((tile) => {
      const id = Number(tile.dataset.id);
      const c = m.memberCards.get(id);
      const lim = Engine.memberLimits(m, c);
      $(".pic", tile).onclick = () => {
        if (state.roster.members[id]) delete state.roster.members[id];
        else state.roster.members[id] = { level: 1, awake: 1, rank: 1 };
        saveRoster();
        renderMembers();
        renderCalc();
      };
      const own = state.roster.members[id];
      if (!own) return;
      const upd = () => {
        own.awake = Number($(".c-awake", tile).value);
        own.rank = Number($(".c-rank", tile).value);
        own.level = clamp(Number($(".c-level", tile).value), 1, lim.limit(own.awake));
        const sl = Number($(".c-skill", tile).value) || 1;
        if (sl > 1) own.skillLevel = sl;
        else delete own.skillLevel;
        const gl = Number($(".c-gskill", tile).value) || 1;
        if (gl > 1) own.gekisouSkillLevel = gl;
        else delete own.gekisouSkillLevel;
        delete own.guess;
        saveRoster();
      };
      $(".c-skill", tile).onchange = upd;
      $(".c-gskill", tile).onchange = upd;
      $(".c-level", tile).onchange = upd;
      $(".c-awake", tile).onchange = () => (upd(), renderMembers());
      $(".c-rank", tile).onchange = () => (upd(), renderMembers());
      $(".c-max", tile).onclick = () => {
        own.level = lim.limit(own.awake || 1);
        delete own.guess;
        saveRoster();
        renderMembers();
      };
    });
  }

  function renderSnaps(keepFocus) {
    const el = $("#tab-snaps");
    const m = state.master;
    const f = state.filters.s;
    const list = m.t.MasterSupportCard.slice().sort((a, b) => b._rarity - a._rarity || a._id - b._id);
    const tiles = [];
    for (const sc of list) {
      const own = state.roster.snaps[sc._id];
      const b = cardBonus("snap", sc._id);
      const bands = (sc._characterIDs || []).map((cid) => (m.characters.get(cid) || {})._bandID);
      if (f.band && !bands.map(String).includes(f.band)) continue;
      if (f.rarity && String(sc._rarity) !== f.rarity) continue;
      if (f.owned && !own) continue;
      if (f.bonus && !b.point && !b.item) continue;
      if (f.q && !(cardName(sc) + snapTitle(sc)).includes(f.q)) continue;
      const rank = own ? own.rank || 1 : 1;
      tiles.push(`<div class="tile s ${own ? "owned" : ""} ${own && own.guess ? "guess" : ""}" data-id="${sc._id}">
        <div class="pic"><img loading="lazy" src="${Data.snapThumb(state.settings.region, sc._assetID)}" alt="">
          <span class="check">${own ? "✓" : ""}</span>
          <div class="badges">${b.item ? `<span class="badge item">道具 +${pct(b.item)}</span>` : ""}${b.point ? `<span class="badge point">♪ +${pct(b.point)}</span>` : ""}</div></div>
        <div class="info"><div class="nm">${typeDot(sc._cardType)} ${esc(cardName(sc))}</div><div class="st">${rarityName(sc._rarity)} ${esc(snapTitle(sc))}</div></div>
        ${own ? `<div class="ctl">
          <span>等級</span><div class="lv"><input type="number" class="c-level" min="1" max="${Engine.snapLimit(m, sc, rank)}" value="${own.level}">
            <button class="small ghost c-max" title="等級拉到目前開放上限">Max</button></div>
          <span>開放上限</span><select class="c-rank">${range(1, 5).map((r) => `<option value="${r}" ${r === rank ? "selected" : ""}>${r}</option>`).join("")}</select>
        </div>` : ""}
      </div>`);
    }
    el.innerHTML = `<div class="panel">${pickerToolbar("s")}<div class="grid snaps">${tiles.join("") || '<p class="muted">沒有符合的快照。</p>'}</div></div>`;
    bindToolbar(el, "s", (typing) => renderSnaps(typing));
    if (keepFocus) {
      const q = $(".f-q", el);
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
    el.querySelectorAll(".tile").forEach((tile) => {
      const id = Number(tile.dataset.id);
      const sc = m.snaps.get(id);
      $(".pic", tile).onclick = () => {
        if (state.roster.snaps[id]) delete state.roster.snaps[id];
        else state.roster.snaps[id] = { level: 1, rank: 1 };
        saveRoster();
        renderSnaps();
        renderCalc();
      };
      const own = state.roster.snaps[id];
      if (!own) return;
      const upd = () => {
        own.rank = Number($(".c-rank", tile).value);
        own.level = clamp(Number($(".c-level", tile).value), 1, Engine.snapLimit(m, sc, own.rank));
        delete own.guess;
        saveRoster();
      };
      $(".c-level", tile).onchange = upd;
      $(".c-rank", tile).onchange = () => (upd(), renderSnaps());
      $(".c-max", tile).onclick = () => {
        own.level = Engine.snapLimit(m, sc, own.rank || 1);
        delete own.guess;
        saveRoster();
        renderSnaps();
      };
    });
  }

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  // --- screenshot import ---

  // Cards read from screenshots, waiting for review ("member:12" -> entry), and thumbnail features per kind.
  const imp = { found: new Map(), shots: [], refs: {}, refsKey: null, busy: false, removeMissing: false, msg: "" };
  const KIND_LABEL = { member: "成員卡", snap: "快照" };

  /**
   * Downloads and decodes a thumbnail. Resolves to null when the server has no such file (a card not released in
   * this region); throws after a few tries when the download itself fails.
   */
  async function loadThumb(src) {
    for (let attempt = 0; ; attempt++) {
      try {
        // assets.bdon.moe sends Access-Control-Allow-Origin only to requests with an Origin header and without
        // "Vary: Origin", so a copy cached by a plain <img> elsewhere in the page fails CORS. Bypass the cache.
        const res = await fetch(src, { cache: "reload" });
        if (res.status === 403 || res.status === 404) return null;
        if (!res.ok) throw new Error(res.status + " " + src);
        return await createImageBitmap(await res.blob());
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  function pixels(source, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /**
   * Features of every official thumbnail of one kind, downloaded once per masterdata version. Returns {refs, failed}:
   * a list with failed downloads is not kept, so the next screenshot tries those thumbnails again.
   */
  async function thumbRefs(kind, onProgress) {
    const key = state.settings.region + ":" + state.version.version;
    if (imp.refsKey !== key) {
      imp.refs = {};
      imp.refsKey = key;
    }
    if (imp.refs[kind]) return { refs: imp.refs[kind], failed: 0 };
    const m = state.master;
    const region = state.settings.region;
    const list =
      kind === "member"
        ? m.t.MasterMemberCard.map((c) => ({ id: c._id, url: Data.memberThumb(region, c._assetID) }))
        : m.t.MasterSupportCard.map((s) => ({ id: s._id, url: Data.snapThumb(region, s._assetID) }));
    const refs = [];
    let next = 0, done = 0, failed = 0;
    const fetchNext = async () => {
      while (next < list.length) {
        const it = list[next++];
        try {
          const img = await loadThumb(it.url);
          if (img) {
            refs.push({ id: it.id, feat: Recognize.thumbFeature(pixels(img, img.width, img.height), kind) });
            if (img.close) img.close();
          }
        } catch (e) {
          console.warn("thumbnail", e);
          failed++;
        }
        onProgress(++done, list.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, fetchNext));
    if (!failed) imp.refs[kind] = refs;
    return { refs, failed };
  }

  /** A small picture of the card as it appears in the screenshot. */
  function cropPreview(bmp, cell) {
    const w = 96, h = Math.round((w * cell.h) / cell.w);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(bmp, cell.x, cell.y, cell.w, cell.h, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.8);
  }

  function levelRange(kind, id) {
    const m = state.master;
    if (kind === "member") {
      const lim = Engine.memberLimits(m, m.memberCards.get(id));
      return lim.limit(lim.maxAwake);
    }
    return Engine.snapLimit(m, m.snaps.get(id), 5);
  }

  function addFound(kind, card, bmp) {
    const level = card.level ? card.level.level : null;
    const entry = {
      kind,
      id: card.id,
      candidates: [card.id, ...card.alternatives],
      sure: card.sure,
      dist: card.dist,
      level,
      levelSure: !!(card.level && card.level.sure && level >= 1 && level <= levelRange(kind, card.id)),
      preview: cropPreview(bmp, card.cell),
    };
    entry.include = entry.sure;
    const key = kind + ":" + card.id;
    const old = imp.found.get(key);
    if (!old) return void imp.found.set(key, entry);
    // Seen in more than one screenshot: keep the more certain reading.
    const score = (e) => (e.sure ? 4 : 0) + (e.levelSure ? 2 : 0) - e.dist;
    const keep = score(entry) > score(old) ? entry : old;
    if (old.levelSure && entry.levelSure && old.level !== entry.level) {
      keep.level = Math.max(old.level, entry.level);
      keep.levelSure = false;
    }
    keep.include = old.include || entry.include;
    imp.found.set(key, keep);
  }

  function setImportStatus(text) {
    const el = $("#imp-status");
    if (el) el.textContent = text;
  }

  /** Reads one decoded screenshot into imp.found; returns its summary line ({kind, count} or {error}). */
  async function readShot(bmp, of) {
    const data = pixels(bmp, bmp.width, bmp.height);
    const grid = Recognize.detectGrid(data);
    if (!grid) return { error: "找不到卡片格子" };
    const { refs, failed } = await thumbRefs(grid.kind, (d, n) => setImportStatus(`下載${KIND_LABEL[grid.kind]}縮圖 ${d}/${n}（只有第一次需要）`));
    setImportStatus("辨識中" + of);
    await new Promise((r) => setTimeout(r)); // let the status paint
    const out = Recognize.analyze(data, { [grid.kind]: refs }, grid);
    const warn = failed ? `有 ${failed} 張官方縮圖下載失敗，這些卡會認不出來，請再匯入一次這張截圖` : "";
    if (!out.cards.length) return { error: warn || "沒有辨識到卡片（請用團員名單或快照清單畫面）" };
    for (const card of out.cards) addFound(grid.kind, card, bmp);
    return { kind: grid.kind, count: out.cards.length, warn };
  }

  async function importFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length || imp.busy) return;
    imp.busy = true;
    imp.msg = "";
    renderImport();
    try {
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const of = images.length > 1 ? `（${i + 1}/${images.length}）` : "";
        setImportStatus("讀取截圖" + of);
        let bmp;
        try {
          bmp = await createImageBitmap(file);
        } catch (e) {
          imp.shots.push({ name: file.name, error: "無法讀取這個圖檔" });
          continue;
        }
        try {
          imp.shots.push({ name: file.name, ...(await readShot(bmp, of)) });
        } finally {
          if (bmp.close) bmp.close();
        }
      }
    } catch (e) {
      console.error(e);
      imp.msg = "辨識失敗：" + e.message;
    } finally {
      imp.busy = false;
      renderImport();
    }
  }

  /**
   * What applying an import entry writes: {level, awake} for a member, {level, rank} for a snap, or null to leave a
   * registered card alone. Awakening and snap rank are raised only as far as the level read needs (they are not
   * visible in the list screens); with "importMaxLevel" the level then goes to the cap of that awakening/rank.
   */
  function importTarget(e) {
    const m = state.master;
    const toMax = state.settings.importMaxLevel;
    if (e.kind === "member") {
      const lim = Engine.memberLimits(m, m.memberCards.get(e.id));
      const own = state.roster.members[e.id];
      if (own && !e.level && !toMax) return null;
      let awake = own ? own.awake || 1 : 1;
      while (awake < lim.maxAwake && lim.limit(awake) < (e.level || 1)) awake++;
      const level = toMax ? lim.limit(awake) : e.level || 1;
      return own && own.level === level && (own.awake || 1) === awake ? null : { level, awake };
    }
    const sc = m.snaps.get(e.id);
    const own = state.roster.snaps[e.id];
    if (own && !e.level && !toMax) return null;
    let rank = own ? own.rank || 1 : 1;
    while (rank < 5 && Engine.snapLimit(m, sc, rank) < (e.level || 1)) rank++;
    const level = toMax ? Engine.snapLimit(m, sc, rank) : e.level || 1;
    return own && own.level === level && (own.rank || 1) === rank ? null : { level, rank };
  }

  function importStatus(e) {
    const own = e.kind === "member" ? state.roster.members[e.id] : state.roster.snaps[e.id];
    const t = importTarget(e);
    if (!own) return `<span class="good">新增${t.level !== e.level ? ` Lv ${t.level}` : ""}</span>`;
    if (t && own.level !== t.level) return `<span class="warn">Lv ${own.level} → ${t.level}</span>`;
    return '<span class="muted">已登錄</span>';
  }

  function renderImportRow(key, e) {
    const m = state.master;
    const card = e.kind === "member" ? m.memberCards.get(e.id) : m.snaps.get(e.id);
    const thumb = e.kind === "member" ? Data.memberThumb(state.settings.region, card._assetID) : Data.snapThumb(state.settings.region, card._assetID);
    const title = e.kind === "member" ? memberTitle(card) : snapTitle(card);
    const pick = e.sure
      ? ""
      : `<select class="i-id" title="最接近的幾張">${e.candidates
          .map((id) => {
            const c = e.kind === "member" ? m.memberCards.get(id) : m.snaps.get(id);
            return c ? `<option value="${id}" ${id === e.id ? "selected" : ""}>${esc(cardName(c))} ${rarityName(c._rarity)} ${esc(e.kind === "member" ? memberTitle(c) : snapTitle(c))}</option>` : "";
          })
          .join("")}</select>`;
    return `<div class="imp-row ${e.kind} ${e.include ? "" : "off"}" data-key="${esc(key)}">
      <input type="checkbox" class="i-inc" ${e.include ? "checked" : ""} title="套用這張">
      <img class="i-shot" src="${e.preview}" alt="截圖">
      <img class="i-thumb" src="${thumb}" alt="">
      <div class="i-info">
        <div class="nm">${typeDot(card._cardType)} ${esc(cardName(card))} <span class="muted">${rarityName(card._rarity)}</span>
          ${e.sure ? "" : '<span class="warn">請確認是哪一張</span>'}</div>
        <div class="st muted">${esc(title)}</div>
        ${pick}
      </div>
      <label class="i-lv">Lv <input type="number" class="i-level" min="1" max="${levelRange(e.kind, e.id)}" value="${e.level || ""}" placeholder="?">
        ${e.levelSure ? "" : '<span class="warn">請確認</span>'}</label>
      <div class="i-st">${importStatus(e)}</div>
    </div>`;
  }

  function renderImport() {
    const el = $("#tab-import");
    if (!el || !state.master) return;
    const entries = [...imp.found.entries()];
    const groups = ["member", "snap"]
      .map((kind) => {
        const rows = entries.filter(([, e]) => e.kind === kind);
        if (!rows.length) return "";
        const unsure = rows.filter(([, e]) => !e.sure || !e.levelSure).length;
        return `<h3>${KIND_LABEL[kind]} ${rows.length} 張${unsure ? `，<span class="warn">${unsure} 張請確認</span>` : ""}</h3>
          <div class="imp-list">${rows.map(([k, e]) => renderImportRow(k, e)).join("")}</div>`;
      })
      .join("");
    const shots = imp.shots
      .map((s) => `<li>${esc(s.name)}：${s.error ? `<span class="warn">${esc(s.error)}</span>` : `${KIND_LABEL[s.kind]} ${s.count} 張${s.warn ? `，<span class="warn">${esc(s.warn)}</span>` : ""}`}</li>`)
      .join("");
    const chosen = entries.filter(([, e]) => e.include).length;
    el.innerHTML = `
      <div class="panel">
        <h2>從遊戲截圖匯入</h2>
        <p class="note">在遊戲的「團員名單」或「快照清單」畫面截圖，排序方式不限。可以一次選多張，辨識完會先列出結果讓你檢查，按「套用」才會寫入清單。
          辨識只在這個瀏覽器裡進行，截圖不會上傳。</p>
        <label class="drop ${imp.busy ? "busy" : ""}" id="imp-drop">
          <input type="file" id="imp-file" accept="image/*" multiple hidden>
          <span><strong>選擇截圖</strong>，或把圖片拖到這裡，也可以直接貼上（Ctrl+V）</span>
          <span id="imp-status" class="muted">${imp.busy ? "處理中…" : ""}</span>
        </label>
        ${imp.msg ? `<p class="good">${esc(imp.msg)}</p>` : ""}
        ${shots ? `<ul class="shots note">${shots}</ul>` : ""}
        <p class="note">看不到等級的卡片（被畫面邊緣切到）會略過，請捲動後再截一張。特訓次數、覺醒和開放上限在清單畫面上看不到，請之後在「成員卡」「快照」分頁調整。</p>
      </div>
      ${
        entries.length
          ? `<div class="panel">
        <h2>辨識結果</h2>
        ${groups}
        <div class="row imp-actions">
          <button id="imp-apply" ${chosen ? "" : "disabled"}>套用 ${chosen} 張到清單</button>
          <label><input type="checkbox" id="imp-max" ${state.settings.importMaxLevel ? "checked" : ""}> 等級直接設成上限（目前特訓／開放上限能升到的最高等，方便先排隊伍再升級）</label>
          <label><input type="checkbox" id="imp-remove" ${imp.removeMissing ? "checked" : ""}> 同時移除清單裡、截圖中沒出現的${[...new Set(imp.shots.filter((s) => s.kind).map((s) => KIND_LABEL[s.kind]))].join("和")}（截圖涵蓋全部持有卡時才勾）</label>
          <button class="ghost" id="imp-clear">清除結果</button>
        </div>
      </div>`
          : ""
      }`;
    $("#imp-file", el).onchange = (ev) => importFiles(ev.target.files);
    const drop = $("#imp-drop", el);
    drop.ondragover = (ev) => (ev.preventDefault(), drop.classList.add("over"));
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      importFiles(ev.dataTransfer.files);
    };
    if (!entries.length) return;
    el.querySelectorAll(".imp-row").forEach((row) => {
      const key = row.dataset.key;
      const e = imp.found.get(key);
      $(".i-inc", row).onchange = (ev) => ((e.include = ev.target.checked), renderImport());
      $(".i-level", row).onchange = (ev) => {
        const v = Math.round(Number(ev.target.value));
        e.level = v >= 1 ? Math.min(v, levelRange(e.kind, e.id)) : null;
        e.levelSure = !!e.level;
        renderImport();
      };
      const pick = $(".i-id", row);
      if (pick)
        pick.onchange = (ev) => {
          e.id = Number(ev.target.value);
          e.sure = true; // chosen by the player
          e.include = true;
          renderImport();
        };
    });
    $("#imp-max", el).onchange = (ev) => {
      state.settings.importMaxLevel = ev.target.checked;
      saveSettings();
      renderImport();
    };
    $("#imp-remove", el).onchange = (ev) => (imp.removeMissing = ev.target.checked);
    $("#imp-apply", el).onclick = applyImport;
    $("#imp-clear", el).onclick = () => {
      imp.found.clear();
      imp.shots = [];
      imp.msg = "";
      renderImport();
    };
  }

  function applyImport() {
    const chosen = [...imp.found.values()].filter((e) => e.include);
    const seen = { member: new Set(), snap: new Set() };
    let added = 0, updated = 0, removed = 0;
    for (const e of chosen) {
      seen[e.kind].add(e.id);
      const list = e.kind === "member" ? state.roster.members : state.roster.snaps;
      const t = importTarget(e);
      if (!list[e.id]) {
        list[e.id] = e.kind === "member" ? { ...t, rank: 1 } : t;
        added++;
      } else if (t) {
        Object.assign(list[e.id], t);
        delete list[e.id].guess;
        updated++;
      }
    }
    if (imp.removeMissing) {
      const scanned = new Set(imp.shots.filter((s) => s.kind).map((s) => s.kind));
      for (const kind of scanned) {
        const own = kind === "member" ? state.roster.members : state.roster.snaps;
        for (const id of Object.keys(own))
          if (!seen[kind].has(Number(id))) {
            delete own[id];
            removed++;
          }
      }
    }
    saveRoster();
    imp.found.clear();
    imp.shots = [];
    imp.removeMissing = false;
    imp.msg = `已套用：新增 ${added} 張、更新 ${updated} 張` + (removed ? `、移除 ${removed} 張` : "") + "。";
    renderMembers();
    renderSnaps();
    renderCalc();
    renderImport();
  }

  // --- settings ---

  function renderSettings() {
    const el = $("#tab-settings");
    const s = state.settings;
    const p = state.roster.player;
    // The preset and the file sync need serve.py (start.cmd); a static host such as GitHub Pages has neither.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    const m = state.master;
    // Same order as the in-game 角色TOP screen: bands in id order, members by _displayOrder.
    const chars = m.t.MasterCharacter.filter((c) => !c._isNonPlayable).sort((a, b) => a._bandID - b._bandID || a._displayOrder - b._displayOrder);
    const bandList = m.t.MasterBand.slice().sort((a, b) => a._id - b._id);
    const prof = activeProfile();
    const regionOptions = (sel) => Object.entries(Data.REGIONS)
      .map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)}</option>`)
      .join("");
    el.innerHTML = `
      <div class="panel">
        <h2>設定檔</h2>
        <div class="row">
          <label class="field"><span>名稱</span><input type="text" id="profileName" maxlength="40" value="${esc(prof.name)}"></label>
          <label class="field"><span>區服</span><select id="profileRegion">${regionOptions(s.region)}</select></label>
          ${profiles.list.length > 1 ? `<button class="ghost" id="deleteProfile">刪除這個設定檔</button>` : ""}
        </div>
        <div class="row" style="margin-top:10px">
          <label class="field"><span>新設定檔名稱</span><input type="text" id="newProfileName" maxlength="40" placeholder="例如：日服"></label>
          <label class="field"><span>區服</span><select id="newProfileRegion">${regionOptions(s.region === "jp" ? "hk-tw-mo" : "jp")}</select></label>
          <button id="addProfile">新增空白設定檔</button>
          <button class="ghost" id="copyProfile">複製目前的設定檔</button>
        </div>
        <p class="note">每個設定檔有自己的區服、設定、角色等級和卡片清單，用畫面右上角的選單切換。</p>
        <p class="note" id="profileMsg"></p>
      </div>
      <div class="panel">
        <h2>綜合力</h2>
        <div class="row">
          <label class="field"><span>T.G.W CARD 等級</span><input type="number" id="vip" min="1" max="30" value="${p.vipRank || 1}"></label>
          <label><input type="checkbox" id="eventParam" ${p.eventParameters ? "checked" : ""}> 一般 Live 也計入活動「數值」加成</label>
        </div>
        <p class="note">角色等級、強化樂團和 T.G.W CARD 等級都填好時，模型與遊戲顯示的綜合力完全一致（378,423、597,619 實測）；對不上時請先檢查這三項有沒有更新。
        活動「數值」加成在挑戰 Live 一律計入（244,053 實測），一般 Live 不計入，除非勾選上面的選項。</p>
      </div>
      <div class="panel">
        <h2>角色等級（選填）</h2>
        <p class="note">順序與遊戲「角色TOP」畫面相同。</p>
        ${bandList
          .map((b) => {
            const list = chars.filter((c) => c._bandID === b._id);
            if (!list.length) return "";
            return `<h3>${esc(T(b._nameTextID))}</h3><div class="char-ranks five">${list
              .map((c) => `<label>${esc(T(c._nameTextID))}<input type="number" min="1" max="50" data-char="${c._id}" value="${(p.characterRanks || {})[c._id] || ""}" placeholder="1"></label>`)
              .join("")}</div>`;
          })
          .join("")}
      </div>
      <div class="panel">
        <h2>強化樂團（道具等級）</h2>
        ${bandList
          .map((b) => {
            const items = m.t.MasterBandItem.filter((it) => it._bandId === b._id).sort((x, y) => x._displayOrder - y._displayOrder);
            if (!items.length) return "";
            return `<h3>${esc(T(b._nameTextID))}</h3><div class="char-ranks">${items
              .map((it) => `<label>${esc(T(it._nameTextId))}<input type="number" min="0" max="50" data-band-item="${it._id}" value="${(p.bandItems || {})[it._id] || ""}" placeholder="0"></label>`)
              .join("")}</div>`;
          })
          .join("")}
        <p class="note">每級使該樂團成員的三項能力 +0.1%（Lv.50 為 +5%）。未開放的道具填 0 或留空。</p>
      </div>
      <div class="panel">
        <h2>卡片清單</h2>
        <div class="row">
          ${local ? `<button id="loadPreset">載入從截圖辨識的清單</button>
          <button class="ghost" id="syncRoster">同步到檔案</button>` : ""}
          <button class="ghost" id="exportRoster">匯出 JSON</button>
          <label class="ghost" style="cursor:pointer"><input type="file" id="importFile" accept=".json,application/json" hidden><span class="muted">匯入 JSON 檔…</span></label>
          <button class="ghost" id="clearRoster">清除全部持有</button>
          <button class="ghost" id="clearCache">清除下載快取</button>
        </div>
        <p class="note">清單只存在這個瀏覽器裡（每個設定檔各一份），不會上傳。清除瀏覽資料、用無痕視窗，或 iPhone／iPad 的 Safari
        7 天沒開這個網站時，清單可能消失，請用「匯出 JSON」備份。換電腦或瀏覽器時用「匯入 JSON 檔」搬過去。${local ? `
        「同步到檔案」把目前設定檔的清單和設定存到 deckcalc/presets/browser-roster-${esc(prof.id)}.json。` : ""}</p>
        <p class="note" id="backupHint"></p>
        <p class="note" id="syncMsg"></p>
        <textarea id="rosterJson" readonly hidden></textarea>
      </div>`;
    renderBackupHint();
    $("#profileName").onchange = (e) => {
      const name = e.target.value.trim();
      if (!name) return void (e.target.value = prof.name);
      prof.name = name;
      saveProfiles();
      renderProfileSelect();
    };
    $("#profileRegion").onchange = (e) => {
      // Card ids are shared by the regions, so the roster stays; the event list is per region.
      state.settings.region = e.target.value;
      state.settings.eventId = null;
      state.lastResults = null;
      saveSettings();
      loadAll(false);
    };
    if ($("#deleteProfile")) $("#deleteProfile").onclick = () => {
      if (Date.now() - pendingConfirm < 4000) {
        pendingConfirm = 0;
        return deleteProfile();
      }
      pendingConfirm = Date.now();
      $("#profileMsg").innerHTML = `<span class="warn">會刪除「${esc(prof.name)}」的設定和卡片清單，4 秒內再按一次確認。</span>`;
    };
    const newProfile = (copy) => {
      const region = $("#newProfileRegion").value;
      const name = $("#newProfileName").value.trim() || (copy ? prof.name + " 副本" : regionLabel(region));
      addProfile(name, region, copy);
    };
    $("#addProfile").onclick = () => newProfile(false);
    $("#copyProfile").onclick = () => newProfile(true);
    $("#vip").onchange = (e) => ((p.vipRank = clamp(Number(e.target.value), 1, 30)), saveRoster());
    $("#eventParam").onchange = (e) => ((p.eventParameters = e.target.checked), saveRoster());
    el.querySelectorAll("[data-char]").forEach((inp) => (inp.onchange = () => {
      const v = Number(inp.value);
      p.characterRanks = p.characterRanks || {};
      if (v > 0) p.characterRanks[inp.dataset.char] = v;
      else delete p.characterRanks[inp.dataset.char];
      saveRoster();
    }));
    el.querySelectorAll("[data-band-item]").forEach((inp) => (inp.onchange = () => {
      const v = clamp(Math.floor(Number(inp.value) || 0), 0, 50);
      p.bandItems = p.bandItems || {};
      if (v > 0) p.bandItems[inp.dataset.bandItem] = v;
      else delete p.bandItems[inp.dataset.bandItem];
      inp.value = v || "";
      saveRoster();
    }));
    if (local) $("#loadPreset").onclick = async () => {
      if (Object.keys(state.roster.members).length && !confirmReplace()) return;
      try {
        const res = await fetch("presets/my-roster.json", { cache: "no-store" });
        importRoster(await res.json());
      } catch (e) {
        alertBox("無法讀取 presets/my-roster.json：" + e.message);
      }
    };
    if (local) $("#syncRoster").onclick = async () => {
      const msg = $("#syncMsg");
      msg.textContent = "同步中…";
      try {
        const body = { ...exportRoster(), profileId: profiles.active, settings: state.settings, syncedAt: new Date().toISOString() };
        const res = await fetch("api/roster", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 501 ? "伺服器不支援，請關掉後重新執行 start.cmd" : out.error || "HTTP " + res.status);
        msg.innerHTML = `<span class="good">已存到 ${esc(out.saved)}（${new Date().toLocaleTimeString()}）</span>`;
        markBackedUp();
      } catch (e) {
        msg.innerHTML = `<span class="warn">同步失敗：${esc(e.message)}</span>`;
      }
    };
    $("#exportRoster").onclick = () => {
      const blob = new Blob([JSON.stringify(exportRoster(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `deckcalc-roster-${activeProfile().name.replace(/[\\/:*?"<>|\s]+/g, "_")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      markBackedUp();
    };
    $("#importFile").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        importRoster(JSON.parse(await file.text()));
        markBackedUp(); // the file is the backup
      } catch (err) {
        alertBox("匯入失敗：" + err.message);
      }
    };
    $("#clearRoster").onclick = () => {
      if (!confirmReplace()) return;
      state.roster.members = {};
      state.roster.snaps = {};
      saveRoster();
      renderAll();
    };
    $("#clearCache").onclick = async () => {
      await Data.clearAll();
      loadAll(true);
    };
  }

  // Inline confirmation (no browser dialogs): a second click within 4 s confirms.
  let pendingConfirm = 0;
  function confirmReplace() {
    if (Date.now() - pendingConfirm < 4000) {
      pendingConfirm = 0;
      return true;
    }
    pendingConfirm = Date.now();
    alertBox("這會取代目前的卡片清單，4 秒內再按一次確認。");
    return false;
  }

  // Marks the settings tab when roster changes have gone unexported for a day, and says whether the browser agreed
  // to keep the site's storage.
  function renderBackupHint() {
    if (!state.roster) return;
    const since = Data.safeGet(unsavedKey());
    const age = since ? Date.now() - Date.parse(since) : 0;
    const due = !rosterEmpty() && age >= BACKUP_REMIND_MS;
    const tab = $('.tabs button[data-tab="settings"]');
    if (tab) {
      tab.classList.toggle("attention", due);
      tab.title = due ? "卡片清單的修改還沒匯出備份" : "";
    }
    const el = $("#backupHint");
    if (!el) return;
    const reminder = due ? `<span class="warn">卡片清單有 ${Math.floor(age / BACKUP_REMIND_MS)} 天前的修改還沒匯出備份，建議按「匯出 JSON」。</span> ` : "";
    el.innerHTML = reminder;
    if (rosterEmpty() || !(navigator.storage && navigator.storage.persisted)) return;
    navigator.storage.persisted().then((kept) => {
      if (!el.isConnected) return;
      el.innerHTML = reminder + (kept ? "瀏覽器已同意長期保留這個網站的資料。" : "瀏覽器沒有保證保留這個網站的資料，請定期匯出備份。");
    }, () => {});
  }

  function alertBox(msg) {
    const el = $("#tab-settings .panel:last-child .note");
    if (el) el.innerHTML = `<span class="warn">${esc(msg)}</span>`;
  }

  function exportRoster() {
    return {
      format: "deckcalc-roster/1",
      profile: activeProfile().name,
      region: state.settings.region,
      player: state.roster.player,
      members: Object.entries(state.roster.members).map(([id, o]) => ({ id: Number(id), ...o })),
      snaps: Object.entries(state.roster.snaps).map(([id, o]) => ({ id: Number(id), ...o })),
    };
  }

  function importRoster(json) {
    const r = { members: {}, snaps: {}, player: { vipRank: 1, characterRanks: {}, eventParameters: false, ...(json.player || {}) } };
    for (const o of json.members || []) {
      r.members[o.id] = {
        level: o.level || 1, awake: o.awake || 1, rank: o.rank || 1,
        ...(o.skillLevel > 1 ? { skillLevel: o.skillLevel } : {}),
        ...(o.gekisouSkillLevel > 1 ? { gekisouSkillLevel: o.gekisouSkillLevel } : {}),
        ...(o.guess ? { guess: true } : {}),
      };
    }
    for (const o of json.snaps || []) r.snaps[o.id] = { level: o.level || 1, rank: o.rank || 1, ...(o.guess ? { guess: true } : {}) };
    state.roster = r;
    saveRoster();
    renderAll();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Wiring

  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  }));
  $("#profile").onchange = (e) => switchProfile(e.target.value);
  $("#reload").onclick = () => loadAll(true);
  // Pasting a screenshot anywhere while the import tab is open reads it.
  document.addEventListener("paste", (e) => {
    if (!$("#tab-import").classList.contains("active") || !state.master) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) {
      e.preventDefault();
      importFiles(files);
    }
  });

  loadAll(false);
})();
