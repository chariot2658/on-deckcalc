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
    powerCal: 1.0,
    scoreCal: 1.0,
    importMaxLevel: false,
    songSort: "live",
    songPick: "live",
    songOverhead: 40,
    multi: false,
    multiPlayers: 5,
    multiOthersAvg: 5000000,
  };

  const state = {
    settings: loadJson("deckcalc:settings", {}),
    roster: null, // {members: {id: {level, awake, rank, guess}}, snaps: {id: {level, rank, guess}}, player}
    master: null,
    version: null,
    perPower: null,
    lengths: null,
    worker: null,
    workerReady: null,
    lastResults: null,
    filters: { m: { band: "", rarity: "", owned: false, bonus: false, q: "" }, s: { band: "", rarity: "", owned: false, bonus: false, q: "" } },
  };
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };

  function loadJson(key, fallback) {
    try {
      const v = Data.safeGet(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  const saveSettings = () => Data.safeSet("deckcalc:settings", JSON.stringify(state.settings));
  const rosterKey = () => "deckcalc:roster:" + state.settings.region;
  function loadRoster() {
    const r = loadJson(rosterKey(), null);
    state.roster = r && r.members ? r : { members: {}, snaps: {}, player: { vipRank: 1, characterRanks: {}, eventParameters: false } };
    state.roster.player = { vipRank: 1, characterRanks: {}, eventParameters: false, ...(state.roster.player || {}) };
  }
  const saveRoster = () => Data.safeSet(rosterKey(), JSON.stringify(state.roster));

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
      $("#data-status").textContent =
        `資料版本 ${String(mst.version).slice(0, 8)} · 更新於 ${new Date(mst.verifiedAt).toLocaleString()}` +
        (md ? "" : " · 譜面資料載入失敗");
      startWorker(mst.raw, lang);
      loadRoster();
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

  function startWorker(raw, lang) {
    if (state.worker) state.worker.terminate();
    const slim = {};
    for (const k of Object.keys(raw)) if (k !== "MasterText") slim[k] = raw[k];
    try {
      state.worker = new Worker("worker.js");
      state.workerReady = new Promise((resolve, reject) => {
        state.worker.onmessage = (e) => (e.data.type === "ready" ? resolve() : null);
        state.worker.onerror = (e) => reject(e);
      });
      state.worker.postMessage({ type: "init", raw: slim, lang, perPower: [...state.perPower], lengths: [...state.lengths] });
    } catch (e) {
      console.warn("worker unavailable, searching on the main thread", e);
      state.worker = null;
      state.workerReady = Promise.resolve();
    }
  }

  let searchSeq = 0;
  async function runSearch(input, eventId) {
    const now = Date.now();
    if (!state.worker) {
      const out = Engine.search({ ...input, master: state.master, event: state.master.events.get(eventId), perPowerByScore: state.perPower, lengthByScore: state.lengths, now: new Date(now) });
      const slim = (d) => ({ ...d, members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank })), snaps: d.snaps.map((s) => (s ? { id: s.id, level: s.level, rank: s.rank } : null)) });
      return { error: out.error, stats: out.stats, rate: out.rate, results: out.results.map(slim), songs: (out.songs || []).map(slim) };
    }
    await state.workerReady;
    const id = ++searchSeq;
    return new Promise((resolve, reject) => {
      state.worker.onmessage = (e) => {
        if (e.data.id !== id) return;
        if (e.data.type === "error") reject(new Error(e.data.message));
        else resolve(e.data);
      };
      state.worker.postMessage({ type: "search", id, eventId, input, now });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Rendering

  function renderAll() {
    renderRegion();
    renderCalc();
    renderMembers();
    renderSnaps();
    renderImport();
    renderSettings();
  }

  function renderRegion() {
    const sel = $("#region");
    sel.innerHTML = Object.entries(Data.REGIONS)
      .map(([k, v]) => `<option value="${k}" ${k === state.settings.region ? "selected" : ""}>${esc(v.label)}</option>`)
      .join("");
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
      <p class="note">數值是 rank 1 → rank 5 的加成，同一張卡符合多個條件時會疊加。成員卡的加成決定活動點數，快照的加成決定活動道具（已用遊戲結算畫面驗證）。「數值」加成只在挑戰 Live 反映在遊戲顯示的綜合力與分數上（已驗證），一般 Live 預設不計入。</p>`;
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
          <label class="field" ${s.mode === "challenge" ? "hidden" : ""}><span>加成道具（LB）用量</span>
            <input type="number" id="boosts" min="0" max="10" value="${s.boosts}"></label>
          <div class="field" ${s.mode === "challenge" ? "hidden" : ""}><span>遊玩方式</span>
            <div class="chips">
              <label><input type="radio" name="multi" value="solo" ${s.multi ? "" : "checked"}>單人</label>
              <label><input type="radio" name="multi" value="multi" ${s.multi ? "checked" : ""}>多人（激奏）</label>
            </div>
          </div>
          <label class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"}><span>房間人數</span>
            <input type="number" id="multiPlayers" min="2" max="5" value="${s.multiPlayers}" style="width:70px"></label>
          <label class="field" ${s.mode === "normal" && s.multi ? "" : "hidden"}><span>其他玩家平均分數</span>
            <input type="number" id="multiOthersAvg" min="0" step="100000" value="${s.multiOthersAvg}" style="width:120px"></label>
          <label class="field" ${s.mode === "challenge" ? "" : "hidden"}><span>消耗挑戰點數</span>
            <select id="cp">${[200, 400, 800, 1600].map((v) => `<option ${v === s.cp ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="field"><span>可穩定打的最高等級</span><input type="number" id="maxLevel" min="1" max="40" value="${s.maxLevel}"></label>
          <div class="field"><span>難度</span><div class="chips">${diffChips}</div></div>
          <div class="field"><span>選歌</span>
            <div class="chips">
              <label><input type="radio" name="songPick" value="live" ${s.songPick !== "minute" ? "checked" : ""}>每場收益最高</label>
              <label><input type="radio" name="songPick" value="minute" ${s.songPick === "minute" ? "checked" : ""}>每分鐘收益最高</label>
            </div>
          </div>
          <label class="field" ${s.songPick === "minute" ? "" : "hidden"}><span>每場額外時間（載入＋結算，秒）</span>
            <input type="number" id="pickOverhead" min="0" max="300" value="${s.songOverhead}" style="width:80px"></label>
          <div class="field"><span>優先</span>
            <div class="chips">
              <label><input type="radio" name="objective" value="points" ${s.objective === "points" ? "checked" : ""}>活動點數</label>
              <label><input type="radio" name="objective" value="items" ${s.objective === "items" ? "checked" : ""}>活動道具</label>
            </div>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="run" ${ownedM < 5 ? "disabled" : ""}>計算最佳配隊</button>
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
    }));
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
    $("#multiPlayers").onchange = (e) => {
      s.multiPlayers = clamp(Math.round(Number(e.target.value)), 2, 5);
      saveSettings();
    };
    $("#multiOthersAvg").onchange = (e) => {
      s.multiOthersAvg = clamp(Number(e.target.value), 0, 1e9);
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
    $("#run").onclick = calculate;
    if (state.lastResults && state.lastResults.eventId === ev._id) renderResults(state.lastResults);
  }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, isFinite(x) ? x : a));

  async function calculate() {
    const s = state.settings;
    const ev = currentEvent();
    const btn = $("#run");
    btn.disabled = true;
    btn.textContent = "計算中…";
    const input = {
      mode: s.mode,
      members: Object.entries(state.roster.members).map(([id, o]) => ({ id: Number(id), level: o.level, awake: o.awake || 1, rank: o.rank || 1 })),
      snaps: Object.entries(state.roster.snaps).map(([id, o]) => ({ id: Number(id), level: o.level, rank: o.rank || 1 })),
      player: state.roster.player,
      maxLevel: s.maxLevel,
      difficulties: s.difficulties,
      calibration: s.scoreCal,
      powerCalibration: s.powerCal,
      boosts: s.mode === "challenge" ? s.cp : s.boosts,
      objective: s.objective,
      topK: s.topK,
      compareSongs: true,
      multi: s.mode === "normal" && s.multi ? { players: s.multiPlayers, othersScore: s.multiOthersAvg * (s.multiPlayers - 1) } : null,
      perMinute: s.songPick === "minute" ? { overhead: s.songOverhead } : null,
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
      const out = await runSearch(input, ev._id);
      songView.selected = null;
      state.lastResults = { ...out, eventId: ev._id, mode: s.mode, input, cpPlan };
      renderResults(state.lastResults);
    } catch (e) {
      console.error(e);
      $("#results").innerHTML = `<div class="panel warn">計算失敗：${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "計算最佳配隊";
    }
  }

  // One deck: rank, payoff, song and the five slots. `label` heads the summary line; `key` finds the deck again for
  // the calibration button.
  function deckCard(d, label, key, unit, out) {
    const s = state.settings;
    const m = state.master;
    const mu = d.chart.musicId;
    const margin = d.needDisplayPower > 0 ? d.displayPower / d.needDisplayPower - 1 : null;
    const multi = out.input.multi;
    const slots = d.members
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
          ${b.point ? `<br><span class="tag-point">點數 +${pct(b.point)}</span>` : ""}</div>
          ${sc ? `<img class="s-img" loading="lazy" src="${Data.snapThumb(s.region, sc._assetID)}" alt="">
            <div class="nm">${typeDot(sc._cardType)} ${esc(cardName(sc))}<br><span class="muted">${esc(snapTitle(sc))} · Lv${sn.level}</span>
            ${sb && sb.item ? `<br><span class="tag-item">道具 +${pct(sb.item)}</span>` : ""}</div>` : `<div class="nm muted">（無快照）</div>`}
        </div>`;
      })
      .join("");
    return `<div class="result">
      <div class="result-head">
        <div class="rank-badge" title="${multi ? "預估房間評級" : "預估評級"}">${esc(d.rankName)}</div>
        <div><div class="big"><span class="points">${fmt(d.points)} pt</span>${
          d.cp ? ` · <span class="cp">${fmt(d.cp)} CP</span>` : ""
        } · <span class="items">${fmt(d.items)} 道具</span></div>
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
          <div class="muted small">${esc(label)} · ${unit} · 點數加成 +${pct(d.pointBonus)} · 道具加成 +${pct(d.itemBonus)}</div></div>
        <div style="margin-left:auto;text-align:right">
          <div><b>${esc(musicTitle(mu))}</b> ${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</div>
          <div class="small">預估綜合力 <b>${fmt(d.displayPower)}</b>（${
            margin === null
              ? `${esc(d.rankName)} 靠其他玩家的分數就夠`
              : `${esc(d.rankName)} 需要 ${fmt(d.needDisplayPower)}，餘裕 <span class="${margin < 0.03 ? "warn" : ""}">${(margin * 100).toFixed(1)}%</span>`
          }）</div>
          ${d.nextRankName ? `<div class="small muted">${esc(d.nextRankName)} 需要 ${fmt(d.nextNeedDisplayPower)}</div>` : ""}
          <div class="small muted">預估分數約 ${fmt(d.estScore)}${
            multi ? `，房間總分約 ${fmt(d.estScore + multi.othersScore)}（${multi.players} 人）` : ""
          }</div>
        </div>
      </div>
      <div class="slots">${slots}</div>
      <div class="calib">
        用這隊實際打一場後，可以回報數據校正模型：
        遊戲顯示綜合力 <input type="number" class="cal-power" style="width:100px">
        實際分數 <input type="number" class="cal-score" style="width:110px">
        <button class="small cal-apply" data-key="${key}">校正</button>
      </div>
    </div>`;
  }

  function bindCalibration(el, decks) {
    el.querySelectorAll(".cal-apply").forEach((b) => (b.onclick = () => {
      const d = decks.get(b.dataset.key);
      const box = b.closest(".calib");
      const shown = Number($(".cal-power", box).value);
      const score = Number($(".cal-score", box).value);
      const msgs = [];
      if (shown > 0) {
        state.settings.powerCal = shown / d.power;
        msgs.push(`綜合力校正 = ${state.settings.powerCal.toFixed(4)}`);
      }
      if (score > 0) {
        const base = (shown > 0 ? shown : d.displayPower) * d.chart.perPower;
        state.settings.scoreCal = score / base;
        msgs.push(`分數校正 = ${state.settings.scoreCal.toFixed(4)}`);
      }
      if (!msgs.length) return;
      saveSettings();
      box.insertAdjacentHTML("beforeend", `<div class="good">已更新：${msgs.join("，")}。請重新計算。</div>`);
    }));
  }

  const resultUnit = (out) =>
    out.mode === "challenge" ? `每次（${state.settings.cp} CP）` : `每場（${out.input.boosts} 個加成道具，倍率 ×${out.rate}）`;

  function renderResults(out) {
    const el = $("#results");
    if (!el) return;
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
    el.innerHTML = `<div class="panel">
        <h2>結果</h2>
        <p class="note">分數以「全 Perfect、不含演出技能」的計分資料 × 分數校正 ${s.scoreCal.toFixed(3)} 估算，綜合力 × 綜合力校正 ${s.powerCal.toFixed(3)}。
        餘裕小於 3% 的隊伍，實際可能差一級。${
          out.input.multi
            ? `<br>多人（激奏）：活動點數、道具和 CP 看的是<b>房間評級</b>（結算畫面右上角的大徽章），不是自己分數的評級。房間評級＝全房總分對照該曲的多人門檻（依人數調整）；這裡用「自己的預估分數＋其他 ${out.input.multi.players - 1} 人 × ${fmt(state.settings.multiOthersAvg)}」估算。其他玩家的分數通常佔大部分，所以加成高的隊伍比綜合力高的隊伍划算。直接開始時歌曲是隨機的，可以在下方「歌曲比較」查各首歌會拿到的評級。`
            : ""
        }${
          out.cpPlan
            ? `<br>一般 Live 拿到的 CP 只看評級（不吃加成），排名時已換算成 pt 一起比較：用目前最佳的挑戰隊（${esc(out.cpPlan.rankName)}、點數加成 +${pct(out.cpPlan.pointBonus)}、${esc(musicTitle(out.cpPlan.chart.musicId))} ${DIFF_NAMES[out.cpPlan.chart.difficulty]}）清 CP，1 CP ≈ ${out.cpPlan.value.toFixed(1)} pt。挑戰隊請切到「挑戰 Live」模式查看。`
            : ""
        }${
          out.input.perMinute
            ? `<br>選歌依「每分鐘收益」：每支隊伍都改選每分鐘（歌曲長度＋每場額外 ${fmt(out.input.perMinute.overhead)} 秒）賺最多的歌和評級，所以可能故意選短歌、拿低一級的評級。LB 有限、會用完的話，請改回「每場收益最高」。`
            : ""
        }${hasSongs ? "各首歌的比較在下方「歌曲比較」。" : ""}搜尋了 ${fmt(out.stats ? out.stats.sets : 0)} 種成員組合，耗時 ${out.stats ? out.stats.ms : "?"} ms。</p>
      </div>${cards || '<div class="panel">沒有結果。</div>'}${hasSongs ? `<div class="panel" id="songs"></div><div id="song-deck"></div>` : ""}`;
    bindCalibration(el, decks);
    if (hasSongs) renderSongs(out);
  }

  // --- song comparison ---

  const songView = { showAll: false, selected: null };
  const mmss = (sec) => {
    const t = Math.round(sec);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  const SONG_LIMIT = 15;

  function renderSongs(out) {
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
        const tags =
          (r.v === bestLive ? '<span class="song-best">每場最佳</span>' : "") +
          (r.pm !== null && r.pm === bestMin ? '<span class="song-best">每分鐘最佳</span>' : "");
        return `<tr class="song-row ${r.k === songView.selected ? "sel" : ""}" data-k="${r.k}">
          <td class="num">${list.indexOf(r) + 1}</td>
          <td><b>${esc(musicTitle(d.chart.musicId))}</b> <span class="muted small">${DIFF_NAMES[d.chart.difficulty]} Lv${d.chart.level}</span>${tags}</td>
          <td>${esc(d.rankName)}</td>
          <td class="num"><b>${fmt(Math.round(r.v))}</b>${parts}</td>
          <td class="num">${len ? mmss(len) : "—"}</td>
          <td class="num">${r.pm !== null ? fmt(Math.round(r.pm)) : "—"}</td>
          <td class="num">${margin === null ? "—" : `<span class="${margin < 0.03 ? "warn" : ""}">${(margin * 100).toFixed(1)}%</span>`}</td>
          <td class="num muted">${d.nextRankName ? `${esc(d.nextRankName)}：${fmt(d.nextNeedDisplayPower)}` : "—"}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<h2>歌曲比較</h2>
      <p class="note">每首歌各自配出最佳隊伍後的收益（${esc(resultUnit(out))}）。活動點數只看評級和加成、不看分數多寡，所以「每場」最高的通常是評級門檻相對低、最容易衝上高一級的歌。
      LB 會用完的話看「每場」；時間有限、LB 用不完的話看「每分鐘」＝每場 ÷（歌曲長度＋每場額外時間）。點一列可看那首歌的隊伍。</p>
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

  function renderSongDeck(out) {
    const el = $("#song-deck");
    const d = songView.selected !== null ? out.songs[songView.selected] : null;
    if (!d) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = deckCard(d, `${musicTitle(d.chart.musicId)} 的最佳隊伍`, "s", resultUnit(out), out);
    bindCalibration(el, new Map([["s", d]]));
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
          Lv <input type="number" class="c-level" min="1" max="${lim.limit(awake)}" value="${own.level}">
          特訓 <select class="c-awake">${range(1, lim.maxAwake).map((a) => `<option ${a === awake ? "selected" : ""}>${a}</option>`).join("")}</select>
          Rank <select class="c-rank">${range(1, 5).map((r) => `<option ${r === (own.rank || 1) ? "selected" : ""}>${r}</option>`).join("")}</select>
          <button class="small ghost c-max" title="等級拉到目前特訓上限">Max</button>
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
        delete own.guess;
        saveRoster();
      };
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
          Lv <input type="number" class="c-level" min="1" max="${Engine.snapLimit(m, sc, rank)}" value="${own.level}">
          Rank <select class="c-rank">${range(1, 5).map((r) => `<option ${r === rank ? "selected" : ""}>${r}</option>`).join("")}</select>
          <button class="small ghost c-max">Max</button>
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
        <p class="note">看不到等級的卡片（被畫面邊緣切到）會略過，請捲動後再截一張。特訓次數和 Rank 在清單畫面上看不到，請之後在「成員卡」「快照」分頁調整。</p>
      </div>
      ${
        entries.length
          ? `<div class="panel">
        <h2>辨識結果</h2>
        ${groups}
        <div class="row imp-actions">
          <button id="imp-apply" ${chosen ? "" : "disabled"}>套用 ${chosen} 張到清單</button>
          <label><input type="checkbox" id="imp-max" ${state.settings.importMaxLevel ? "checked" : ""}> 等級直接設成上限（目前特訓／Rank 能升到的最高等，方便先排隊伍再升級）</label>
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
    const m = state.master;
    // Same order as the in-game 角色TOP screen: bands in id order, members by _displayOrder.
    const chars = m.t.MasterCharacter.filter((c) => !c._isNonPlayable).sort((a, b) => a._bandID - b._bandID || a._displayOrder - b._displayOrder);
    const bandList = m.t.MasterBand.slice().sort((a, b) => a._id - b._id);
    el.innerHTML = `
      <div class="panel">
        <h2>校正</h2>
        <div class="row">
          <label class="field"><span>綜合力校正（遊戲顯示 ÷ 模型）</span><input type="number" step="0.001" id="powerCal" value="${s.powerCal}"></label>
          <label class="field"><span>分數校正（技能與準度）</span><input type="number" step="0.001" id="scoreCal" value="${s.scoreCal}"></label>
          <label class="field"><span>T.G.W CARD 等級</span><input type="number" id="vip" min="1" max="30" value="${p.vipRank || 1}"></label>
          <label><input type="checkbox" id="eventParam" ${p.eventParameters ? "checked" : ""}> 一般 Live 也計入活動「數值」加成</label>
        </div>
        <p class="note">模型有角色等級、強化樂團與 T.G.W CARD 加成，其餘差距由綜合力校正補上。填好角色等級和 T.G.W CARD 等級後模型與遊戲完全一致（378,423 實測），校正應為 1.000。
        活動「數值」加成在挑戰 Live 一律計入（244,053 實測），一般 Live 不計入，除非勾選上面的選項。
        分數校正 1.0 表示不計演出技能；實測一場後可在結果卡片上回報，讓工具自動算。</p>
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
          <button id="loadPreset">載入從截圖辨識的清單</button>
          <button class="ghost" id="syncRoster">同步到檔案</button>
          <button class="ghost" id="exportRoster">匯出 JSON</button>
          <label class="ghost" style="cursor:pointer"><input type="file" id="importFile" accept=".json,application/json" hidden><span class="muted">匯入 JSON 檔…</span></label>
          <button class="ghost" id="clearRoster">清除全部持有</button>
          <button class="ghost" id="clearCache">清除下載快取</button>
        </div>
        <p class="note">清單存在這個瀏覽器裡（每個區服各一份）。換電腦或瀏覽器時用匯出／匯入搬過去。
        「同步到檔案」把目前的清單和設定存到 deckcalc/presets/browser-roster.json（需用 start.cmd 開啟本工具）。</p>
        <p class="note" id="syncMsg"></p>
        <textarea id="rosterJson" readonly hidden></textarea>
      </div>`;
    $("#powerCal").onchange = (e) => ((s.powerCal = Number(e.target.value) || 1), saveSettings());
    $("#scoreCal").onchange = (e) => ((s.scoreCal = Number(e.target.value) || 1), saveSettings());
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
    $("#loadPreset").onclick = async () => {
      if (Object.keys(state.roster.members).length && !confirmReplace()) return;
      try {
        const res = await fetch("presets/my-roster.json", { cache: "no-store" });
        importRoster(await res.json());
      } catch (e) {
        alertBox("無法讀取 presets/my-roster.json：" + e.message);
      }
    };
    $("#syncRoster").onclick = async () => {
      const msg = $("#syncMsg");
      msg.textContent = "同步中…";
      try {
        const body = { ...exportRoster(), settings: state.settings, syncedAt: new Date().toISOString() };
        const res = await fetch("api/roster", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 501 ? "伺服器不支援，請關掉後重新執行 start.cmd" : out.error || "HTTP " + res.status);
        msg.innerHTML = `<span class="good">已存到 ${esc(out.saved)}（${new Date().toLocaleTimeString()}）</span>`;
      } catch (e) {
        msg.innerHTML = `<span class="warn">同步失敗：${esc(e.message)}</span>`;
      }
    };
    $("#exportRoster").onclick = () => {
      const blob = new Blob([JSON.stringify(exportRoster(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `deckcalc-roster-${state.settings.region}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    $("#importFile").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        importRoster(JSON.parse(await file.text()));
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

  function alertBox(msg) {
    const el = $("#tab-settings .panel:last-child .note");
    if (el) el.innerHTML = `<span class="warn">${esc(msg)}</span>`;
  }

  function exportRoster() {
    return {
      format: "deckcalc-roster/1",
      region: state.settings.region,
      player: state.roster.player,
      members: Object.entries(state.roster.members).map(([id, o]) => ({ id: Number(id), ...o })),
      snaps: Object.entries(state.roster.snaps).map(([id, o]) => ({ id: Number(id), ...o })),
    };
  }

  function importRoster(json) {
    const r = { members: {}, snaps: {}, player: { vipRank: 1, characterRanks: {}, eventParameters: false, ...(json.player || {}) } };
    for (const o of json.members || []) r.members[o.id] = { level: o.level || 1, awake: o.awake || 1, rank: o.rank || 1, ...(o.guess ? { guess: true } : {}) };
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
  $("#region").onchange = (e) => {
    state.settings.region = e.target.value;
    state.settings.eventId = null;
    state.lastResults = null;
    saveSettings();
    loadAll(false);
  };
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
