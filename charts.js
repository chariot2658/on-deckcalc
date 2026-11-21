/*
 * The replay's chart records, made in the browser from the published charts, so the site does not host any notes.
 *
 * `record` is nnnotes' chart_record (src/nnnotes/deckdata.py) over its port of the game's converter (score.py's
 * runtime_score, whose function names are kept here in comments), less what a record does not hold: lanes survive only
 * as far as they decide which notes merge. Every step is in binary32 where the original is, so results are the same to
 * the byte. tools/publish-music-data.js compares them with the Python build's on every chart before the site is
 * published, and `fullDeck` checks the SHA-256 of the whole result.
 *
 * UMD: window.Charts or module.exports.
 */
(function (root) {
  "use strict";

  const f = Math.fround;
  const NOTE_TYPES = { tap: 0, flick: 1, trace: 2, long: 3, guide: 4, node: 5 };
  const FLICK_DIRS = { up: 0, left: 1, right: 2, down: 3 };
  const EASES = { linear: 0, in: 1, out: 2 };
  const MAX_LINES = 20;
  const NOT_JUDGED = new Set([0, 80, 82, 100, 103, 121, 122, 123]);
  const SLIDE_BEGIN_CLASS = new Set([20, 41, 61, 80, 104]);
  const SLIDE_END_CLASS = new Set([22, 42, 62, 82, 105]);
  const MERGEABLE = new Set([20, 22, 41, 42, 61, 62, 80, 82, 100, 101, 102, 103, 104, 105]);
  const EPSILON_8 = f(f(1.401298e-45) * 8);

  /** System.Math.Round(double), as the game's inlined code does it. */
  function netRound(x) {
    const ip = Math.trunc(x);
    const frac = x - ip;
    if (x >= 0) return frac === 0.5 ? (ip & 1 ? ip + 1 : ip) : Math.floor(x + 0.5);
    return frac === -0.5 ? (ip & 1 ? ip - 1 : ip) : Math.trunc(x - 0.5);
  }

  const isJudgement = (op) => !NOT_JUDGED.has(op);

  function judgementType(op, crit) {
    if (op === 0 || op === 21) return op;
    if (op === 1) return crit ? 2 : 1;
    if (op === 20) return crit ? 15 : 10;
    if (op === 22) return 11;
    if (op === 40 || op === 41 || op === 42 || op === 102) return 5;
    if (op === 60 || op === 61 || op === 63 || op === 104 || op === 105 || op === 120) return 21;
    if (op === 62) return 22;
    if (op === 80 || op === 82 || op === 100 || op === 101 || op === 103 || op === 121 || op === 122) return 1;
    throw new Error("operate type " + op + " has no judgement type");
  }

  function approximately(a, b) {
    const tol = Math.max(f(Math.max(Math.abs(a), Math.abs(b)) * f(1e-6)), EPSILON_8);
    return Math.abs(f(b - a)) < tol;
  }

  function toInt(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return netRound(v);
    const n = Number(String(v).trim());
    if (!Number.isInteger(n)) throw new Error("not an integer: " + v);
    return n;
  }

  const toF32 = (v) => f(typeof v === "string" ? parseFloat(v) : Number(v));

  function named(table, s, what) {
    const v = table[s];
    if (typeof v !== "number") throw new Error("ss " + what + " value '" + s + "'");
    return v;
  }

  // ------------------------------------------------------------------ SsRootDeserializer
  function readNote(n) {
    const o = { type: 0, t: 0, pos: 0, auto: false, size: 6, crit: false, dir: 0, easeL: 0, easeR: 0, visible: true, node: null };
    if (typeof n.type === "string") o.type = named(NOTE_TYPES, n.type, "type");
    if (n.t != null) o.t = toInt(n.t);
    if (n.pos != null) {
      if (n.pos === "auto") o.auto = true;
      else o.pos = toF32(n.pos);
    }
    if (n.size != null) o.size = toF32(n.size);
    if (n.crit != null) o.crit = !!n.crit;
    if (typeof n.dir === "string") o.dir = named(FLICK_DIRS, n.dir, "dir");
    if (n.ease != null) {
      if (Array.isArray(n.ease)) {
        o.easeL = named(EASES, n.ease[0], "ease");
        o.easeR = named(EASES, n.ease[1], "ease");
      } else o.easeL = o.easeR = named(EASES, n.ease, "ease");
    }
    if (n.visible != null) o.visible = !!n.visible;
    if (Array.isArray(n.node)) o.node = n.node.map((c) => readNote(c));
    return o;
  }

  function readEvents(ev) {
    return {
      bpm: (ev.bpm || []).map((b) => [toInt(b.t), toF32(b.bpm)]),
      sig: (ev.sig || []).map((s) => [toInt(s.t), toInt(s.sig[0]), toInt(s.sig[1])]),
      skill: (ev.skill || []).map(toInt),
      fever: (ev.fever || []).map((x) => [toInt(x[0]), toInt(x[1])]),
    };
  }

  const byStart = (a, b) => a[0] - b[0];

  // ------------------------------------------------------------------ SsTickConverter
  function tickConverter(sigs, bpms) {
    const sorted = sigs.slice().sort(byStart);
    const sig = !sorted.length || sorted[0][0] > 0 ? [[0, 0, 1920, 4, 4]] : [];
    let bar = 0, prev = 0, tpm = 1920;
    for (const [t, num, den] of sorted) {
      const q = tpm !== 0 ? Math.trunc((t - prev) / tpm) : 0;
      if (t - prev !== 0 && prev <= t) bar += q;
      tpm = den !== 0 ? Math.trunc((num * 1920) / den) : 0;
      sig.push([t, bar, tpm, num, den]);
      prev = t;
    }
    const bySpeed = bpms.slice().sort(byStart);
    const bpm = !bySpeed.length || bySpeed[0][0] > 0 ? [[0, 0, f(120)]] : [];
    let acc = 0, prevT = 0, prevBpm = f(120);
    for (const [t, b] of bySpeed) {
      if (t - prevT !== 0 && prevT <= t) acc += ((t - prevT) * 60000) / f(prevBpm * 480);
      bpm.push([t, netRound(acc), b]);
      prevT = t;
      prevBpm = b;
    }
    const find = (segs, tick) => {
      for (let i = segs.length - 1; i >= 0; i--) if (segs[i][0] <= tick) return segs[i];
      return segs[0];
    };
    return {
      timeMs(tick) {
        const [t0, ms0, b] = find(bpm, tick);
        return Math.floor(((tick - t0) * 60000) / f(b * 480) + ms0);
      },
      barPosition(tick) {
        const [t0, bar0, perMeasure] = find(sig, tick);
        const q = perMeasure !== 0 ? Math.trunc((tick - t0) / perMeasure) : 0;
        const r = tick - t0 - q * perMeasure;
        return { bar: bar0 + q, progress: f(f(r) / f(perMeasure)) };
      },
    };
  }

  const keyOf = (bar, progress) => f(progress + f(bar));

  function makePosition(tick, tc) {
    const bp = tc.barPosition(tick);
    return { bar: bp.bar, progress: bp.progress, ms: tc.timeMs(tick), key: keyOf(bp.bar, bp.progress) };
  }

  const before = (p, bar, progress) => p.bar < bar || (p.bar === bar && p.progress < progress);

  /** MusicScoreUtility.GetTimeMsFromBar. */
  function timeMsFromBar(bar, progress, bpmEvents, barEvents) {
    let ref = { bar: 0, progress: 0, ms: 0 };
    let beats = f(4);
    for (const [value, p] of barEvents) {
      if (before(p, bar, progress)) {
        beats = value;
        if (p.ms > ref.ms) ref = p;
      }
    }
    let bpm = f(160);
    for (const [value, p] of bpmEvents) {
      if (before(p, bar, progress)) {
        bpm = value;
        if (p.ms > ref.ms) ref = p;
      }
    }
    const spb = f(f(beats * 60) / bpm);
    const x = f(f(f(spb * f(bar - ref.bar)) + f(spb * f(progress - ref.progress))) * 1000);
    return ref.ms + Math.floor(x);
  }

  function barRhythm(bar, barEvents) {
    let v = f(4);
    for (const [value, p] of barEvents) {
      if (bar < p.bar) return v;
      v = value;
    }
    return v;
  }

  function bpmAtMs(ms, bpmEvents) {
    let v = f(160);
    for (const [value, p] of bpmEvents) if (p.ms <= ms) v = value;
    return v;
  }

  const samePosition = (a, b) => a.bar === b.bar && approximately(a.progress, b.progress);

  /** LiveCalculator.GetNoteLineTypeEasing. */
  function ease(t, kind) {
    if (kind === 0) return t;
    if (kind === 2) return f(t * t);
    if (kind === 1) return f(f(f(2) - t) * t);
    throw new Error("noteLineEaseType " + kind);
  }

  const convertEase = (e) => (e === 1 ? 2 : e === 2 ? 1 : 0);
  const flickDirection = (n) => (n.dir === 1 ? 1 : n.dir === 2 ? 2 : 0);
  const overlapKey = (t, pos, size) => t + "," + netRound(pos) + "," + netRound(size);

  // ------------------------------------------------------------------ NoteInfoData
  function noteInfo(tick, tc, lanePos, size, op, more) {
    const bp = tc.barPosition(tick);
    const laneF = f(lanePos + 0);
    return {
      bar: bp.bar, progress: bp.progress, key: keyOf(bp.bar, bp.progress), lane: netRound(laneF), width: Math.max(1, netRound(size)),
      op, slideAlong: false, crit: false, direction: 0, ease: 0, easeR: 0, lines: [], ...more,
    };
  }

  function singleInfo(n, tc) {
    const op = n.type === 1 ? 40 : n.type === 2 ? 60 : 1;
    return noteInfo(n.t, tc, n.pos, n.size, op, { crit: n.crit, direction: n.type === 1 ? flickDirection(n) : 0 });
  }

  function longNodeOp(nodes, i) {
    const n = nodes[i];
    if (i === 0) return !n.visible ? 80 : n.type === 1 ? 41 : n.type === 2 ? 61 : 20;
    if (i === nodes.length - 1) return !n.visible ? 82 : n.type === 1 ? 42 : n.type === 2 ? 62 : 22;
    if (n.auto) return 21;
    if (!n.visible) return 122;
    return n.type === 2 ? 63 : 21;
  }

  function guideNodeOp(nodes, i, guideMap) {
    const n = nodes[i];
    if (i === 0) {
      if (guideMap && !n.auto) {
        const s = guideMap.get(overlapKey(n.t, n.pos, n.size));
        if (s && s.type < 3) return [101, 102, 104][s.type];
      }
      return 100;
    }
    if (i === nodes.length - 1) return !n.visible ? 103 : n.type === 2 ? 105 : 103;
    if (n.auto) return 63;
    return !n.visible ? 122 : 63;
  }

  /** LineIndexAssigner. */
  function lineAssigner() {
    const inUse = [];
    return {
      acquire(startTick) {
        for (let i = inUse.length - 1; i >= 0; i--) if (inUse[i][1] < startTick) inUse.splice(i, 1);
        const used = new Set(inUse.map((x) => x[0]));
        for (let i = 0; i < MAX_LINES; i++) if (!used.has(i)) return i;
        throw new Error("ss lineIndex " + MAX_LINES + " startTick " + startTick);
      },
      register(idx, endTick) {
        inUse.push([idx, endTick]);
      },
    };
  }

  /** BuildLongOrGuideNoteInfos. */
  function lineInfos(chains, isLong, tc, out, guideMap, assigner) {
    for (const [, chain] of chains) {
      const nodes = chain.node;
      const N = nodes.length;
      const lineIdx = assigner.acquire(nodes[0].t);
      nodes.forEach((nd, i) => {
        const op = isLong ? longNodeOp(nodes, i) : guideNodeOp(nodes, i, guideMap);
        let pos, size;
        if (!nd.auto) {
          pos = nd.pos;
          size = nd.size;
        } else if (i === 0 || i >= N - 1) {
          pos = nodes[0].pos;
          size = nodes[0].size;
        } else {
          let j = i;
          for (;;) {
            if (j < 2) {
              j = 0;
              break;
            }
            j--;
            if (!nodes[j].auto) break;
          }
          let k = i + 1;
          while (k < N - 1 && nodes[k].auto) k++;
          const a = nodes[j], b = nodes[k];
          const span = b.t - a.t;
          const prog = span < 1 ? 0 : f(f(nd.t - a.t) / f(span));
          const el = ease(prog, convertEase(a.easeL));
          const er = ease(prog, convertEase(a.easeR));
          pos = f(a.pos + f(el * f(b.pos - a.pos)));
          const aR = f(a.pos + a.size);
          const right = f(aR + f(er * f(f(b.pos + b.size) - aR)));
          size = f(right - pos);
        }
        let dirSrc = nd;
        if (guideMap && i === 0 && !isLong && !nd.auto) {
          const s = guideMap.get(overlapKey(nd.t, nd.pos, nd.size));
          if (s) dirSrc = s;
        }
        out.push(noteInfo(nd.t, tc, pos, size, op, {
          slideAlong: nd.auto, crit: nd.crit, direction: dirSrc.type === 1 ? flickDirection(dirSrc) : 0,
          ease: convertEase(nd.easeL), easeR: convertEase(nd.easeR), lines: [lineIdx],
        }));
      });
      assigner.register(lineIdx, nodes[N - 1].t);
    }
  }

  /** BuildNoteInfoList. */
  function buildNoteInfos(notes, tc) {
    const guideStarts = new Set();
    for (const n of notes) {
      if (n.type === 4 && n.node && n.node.length && !n.node[0].auto) guideStarts.add(overlapKey(n.node[0].t, n.node[0].pos, n.node[0].size));
    }
    const guideMap = new Map();
    const merged = new Set();
    notes.forEach((n, i) => {
      if (n.type >= 3) return;
      const k = overlapKey(n.t, n.pos, n.size);
      if (guideStarts.has(k) && !guideMap.has(k)) {
        guideMap.set(k, n);
        merged.add(i);
      }
    });
    const out = [];
    notes.forEach((n, i) => {
      if (!merged.has(i) && n.type < 3) out.push(singleInfo(n, tc));
    });
    const chainsOf = (type) => notes.map((n, i) => [i, n]).filter(([, n]) => n.type === type && n.node && n.node.length > 1)
      .sort((a, b) => a[1].node[0].t - b[1].node[0].t || a[0] - b[0]);
    const assigner = lineAssigner();
    lineInfos(chainsOf(3), true, tc, out, null, assigner);
    lineInfos(chainsOf(4), false, tc, out, guideMap, assigner);
    return out;
  }

  /** BuildNoteInfoDictionary + TryMergeSlideEndpoint: position key -> lane -> infos, both in insertion order. */
  function infoDictionary(infos) {
    const d = new Map();
    for (const n of infos) {
      if (!d.has(n.key)) d.set(n.key, new Map());
      const lanes = d.get(n.key);
      if (!lanes.has(n.lane)) lanes.set(n.lane, []);
      const lst = lanes.get(n.lane);
      if (MERGEABLE.has(n.op) && n.lines.length) {
        const hit = lst.find((e) => e.op === n.op && e.width === n.width && e.crit === n.crit && e.direction === n.direction && e.ease === n.ease && e.easeR === n.easeR);
        if (hit) {
          hit.lines.push(...n.lines);
          continue;
        }
      }
      lst.push(n);
    }
    return d;
  }

  function priority(op) {
    if (op === 20 || op === 41 || op === 61 || op === 80 || op === 100 || op === 101 || op === 102 || op === 104) return 8;
    return op === 122 ? 9 : 10;
  }

  /** GetRelativeEighthNotePositions d__45. */
  function eighths(start, end, bpmEvents, barEvents, out) {
    let bar = start.bar;
    let prog = start.progress;
    let r = barRhythm(bar, barEvents);
    let step = 1 / (r + r);
    for (;;) {
      prog += step;
      if (prog >= 1) {
        bar += 1;
        prog -= 1;
        r = barRhythm(bar, barEvents);
        step = 1 / (r + r);
      }
      const progress = f(prog);
      const ms = timeMsFromBar(bar, progress, bpmEvents, barEvents);
      if (end.ms <= ms) return;
      out.push({ bar, progress, ms, key: keyOf(bar, progress) });
    }
  }

  /** MusicScoreNoteCreator: `create` returns a note, or null for one it does not make. */
  function noteCreator(bpmEvents, barEvents) {
    let curId = 0, curLine = 0, curGuideLine = 0;
    const beginByLine = new Map();
    const lineArr = new Array(MAX_LINES).fill(-1);
    const guideArr = new Array(MAX_LINES).fill(-1);

    function endLine(end) {
      const begins = [];
      let ok = true;
      for (const lid of end.lineIds) {
        const begin = beginByLine.get(lid);
        if (!begin) {
          ok = false;
          break;
        }
        begins.push(begin);
        const notes = begin.viewNotes.filter((x) => x.lineIds.includes(lid)).sort((a, b) => a.pos.bar - b.pos.bar || a.pos.progress - b.pos.progress);
        notes.push(end);
        const mids = notes.filter((x) => x !== end && isJudgement(x.op)).map((x) => x.pos);
        const bounds = [begin.pos, ...mids, end.pos];
        const beats = [];
        for (let s = 0; s + 1 < bounds.length; s++) eighths(bounds[s], bounds[s + 1], bpmEvents, barEvents, beats);
        beats.forEach((beat, k) => {
          if (notes.some((x) => isJudgement(x.op) && samePosition(x.pos, beat))) return;
          const window = 15000 / bpmAtMs(beat.ms, bpmEvents);
          let skip = mids.some((mp) => mp.ms - window <= beat.ms && beat.ms < mp.ms);
          if (k === 0 && window > beat.ms - begin.pos.ms) skip = true;
          if (k === beats.length - 1 && window > end.pos.ms - beat.ms) skip = true;
          const combo = { id: lid + k * 10000 + 10000, pos: beat, op: skip ? 121 : 120, crit: false, lineIds: [lid] };
          if (SLIDE_BEGIN_CLASS.has(begin.op)) begin.comboNotes.push(combo);
        });
        beginByLine.delete(lid);
      }
      if (ok) {
        for (const b of begins) if (SLIDE_END_CLASS.has(end.op) && SLIDE_BEGIN_CLASS.has(b.op)) end.endCombo.push(...b.comboNotes);
      }
    }

    return function create(info) {
      const pos = { bar: info.bar, progress: info.progress, key: info.key, ms: timeMsFromBar(info.bar, info.progress, bpmEvents, barEvents) };
      curId += 1;
      const op = info.op;
      const make = (lineIds) => ({ id: curId, pos, op, crit: info.crit, slideAlong: info.slideAlong, lineIds, viewNotes: [], comboNotes: [], endCombo: [] });
      const toBegin = (note, ids) => ids.forEach((lid) => beginByLine.set(lid, note));
      const view = (note, lid) => {
        const b = beginByLine.get(lid);
        if (b) b.viewNotes.push(note);
      };
      let note;
      if (op === 1 || op === 40 || op === 60) {
        note = make([]);
      } else if (op === 20 || op === 41 || op === 61 || op === 80) {
        const ids = info.lines.map((li) => {
          curLine += 1;
          lineArr[li] = curLine;
          return curLine;
        });
        note = make(ids);
        toBegin(note, ids);
      } else if (op === 21 || op === 63) {
        const lid = (op === 21 ? lineArr : guideArr)[info.lines[0]];
        note = make([lid]);
        view(note, lid);
      } else if (op === 22 || op === 42 || op === 62 || op === 82) {
        const ids = info.lines.map((li) => {
          const lid = lineArr[li];
          lineArr[li] = -1;
          return lid;
        });
        note = make(ids);
        endLine(note);
      } else if (op === 100 || op === 101 || op === 102 || op === 104) {
        const ids = info.lines.map((li) => {
          const lid = curGuideLine + 10001;
          curGuideLine += 1;
          guideArr[li] = lid;
          return lid;
        });
        note = make(ids);
        toBegin(note, ids);
      } else if (op === 103 || op === 105) {
        const ids = info.lines.map((li) => {
          const lid = guideArr[li];
          guideArr[li] = -1;
          return lid;
        });
        note = make(ids);
        endLine(note);
      } else if (op === 122) {
        let lid = lineArr[info.lines[0]];
        if (lid < 1) {
          lid = guideArr[info.lines[0]];
          if (lid < 1) return null;
        }
        note = make([lid]);
        view(note, lid);
      } else {
        return null;
      }
      return note;
    };
  }

  /** SsMusicScoreConverter.Load: the notes in the order the game enumerates them, skill events and fevers. */
  function runtimeScore(rootJson) {
    const score = rootJson.score;
    if (!score || typeof score !== "object" || Array.isArray(score)) throw new Error("ss score");
    const ev = readEvents(score.events && typeof score.events === "object" ? score.events : {});
    const notes = (score.notes || []).map((n) => readNote(n));
    const tc = tickConverter(ev.sig, ev.bpm);
    const infos = buildNoteInfos(notes, tc);
    const bpmEvents = ev.bpm.slice().sort(byStart).map(([t, b]) => [b, makePosition(t, tc)]);
    const barEvents = ev.sig.slice().sort(byStart).map(([t, n, d]) => [f(f(f(n) * 4) / f(d)), makePosition(t, tc)]);
    const fevers = ev.fever.slice().sort(byStart).map(([a, b]) => [makePosition(a, tc), makePosition(b, tc)]);
    const skills = ev.skill.map((t) => makePosition(t, tc));

    const dict = infoDictionary(infos);
    const create = noteCreator(bpmEvents, barEvents);
    const byKey = new Map();
    const listOf = (key) => {
      if (!byKey.has(key)) byKey.set(key, []);
      return byKey.get(key);
    };
    for (const key of [...dict.keys()].sort((a, b) => a - b)) {
      const flat = [];
      for (const lst of dict.get(key).values()) flat.push(...lst);
      flat.sort((a, b) => priority(a.op) - priority(b.op));
      for (const info of flat) {
        const note = create(info);
        if (!note) continue;
        listOf(note.pos.key).push(note);
        if (SLIDE_END_CLASS.has(note.op)) {
          for (const c of note.endCombo) {
            const lst = listOf(c.pos.key);
            if (!lst.includes(c)) lst.push(c);
          }
        }
      }
    }
    const ordered = [];
    for (const lst of byKey.values()) ordered.push(...lst);
    return { notes: ordered, skills, fevers };
  }

  /** deckdata.chart_record: the deck data's record of a chart, its keys in the published order. */
  function record(scoreId, key, sha256, rootJson) {
    const rs = runtimeScore(rootJson);
    const seen = new Set();
    const notes = { id: [], op: [], judgementType: [], timeMs: [] };
    for (const n of rs.notes) {
      if (seen.has(n.id)) throw new Error("chart " + key + ": note id " + n.id + " occurs twice");
      seen.add(n.id);
      notes.id.push(n.id);
      notes.op.push(n.op);
      notes.judgementType.push(judgementType(n.op, n.crit));
      notes.timeMs.push(n.pos.ms);
    }
    return {
      scoreId,
      asset: { key, sha256 },
      notes,
      skillEvents: { timeMs: rs.skills.map((p) => p.ms) },
      fevers: { startMs: rs.fevers.map(([a]) => a.ms), endMs: rs.fevers.map(([, b]) => b.ms) },
    };
  }

  /** A chart file's JSON: gunzipped when the first two bytes are 1F 8B, as MusicScoreLoader.Load. */
  async function parseChart(bytes) {
    let data = bytes;
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    }
    return JSON.parse(new TextDecoder("utf-8").decode(data));
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const fileOf = (key) => key.replace(/^Live\/MusicScore\//, "") + ".bytes";

  // A chart file of the release the data was built on (haneoka.org serves the current one if that release is gone; the
  // deck's hash decides). Waits a little longer after each failure, as for a 429.
  async function download(source, key) {
    const url = source.url + fileOf(key) + (source.release ? "?release=" + encodeURIComponent(source.release) : "");
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
      try {
        const res = await fetch(url, { credentials: "omit" });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        last = "HTTP " + res.status;
        if (res.status === 404) break;
      } catch (e) {
        last = String(e);
      }
    }
    throw new Error("譜面下載失敗（" + fileOf(key) + "）：" + last);
  }

  /**
   * The whole deck data, from the published file without notes (`stripped`, ending in an empty "charts" list) and
   * manifest.chartSource: {url, release, charts: [{scoreId, key, sha256}], deckSha256} (tools/publish-music-data.js).
   */
  async function fullDeck(stripped, source, width = 32) {
    const tail = "]}\n";
    if (!stripped.endsWith('"charts":[' + tail)) throw new Error("deck data with charts already in it");
    const records = new Array(source.charts.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < records.length) {
        const i = next++;
        const c = source.charts[i];
        records[i] = JSON.stringify(record(c.scoreId, c.key, c.sha256, await parseChart(await download(source, c.key))));
      }
    }));
    const text = stripped.slice(0, -tail.length) + records.join(",") + tail;
    if ((await sha256(text)) !== source.deckSha256) throw new Error("下載的譜面和建置網站資料時用的不同，請稍後按「更新資料」再試");
    return text;
  }

  const api = { record, parseChart, fullDeck, fileOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Charts = api;
})(typeof self !== "undefined" ? self : this);
