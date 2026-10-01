/*
 * Reads screenshots of the in-game member list (團員名單) and snap list (快照清單).
 *
 *   1. Grid: card frames make strong, evenly spaced edges. Edge counts are projected onto each axis and a regular
 *      grid (offset, card size, pitch) is fitted to the peaks. Only fully visible cards are kept.
 *   2. Card: the art inside each frame is reduced to a small colour grid and compared with the same grid of every
 *      official thumbnail (corners with badges and the level strip are masked out).
 *   3. Level: the white "Lv.NN" glyphs are segmented and each digit is read with a small shape classifier.
 *
 * Images are plain {width, height, data: RGBA bytes}, so this runs in the browser (window.Recognize) and in Node.
 */
(function (root) {
  "use strict";

  const WORK_WIDTH = 800; // grid detection runs on a copy scaled to this width
  const EDGE_THRESHOLD = 20;

  // Card shapes (width / height, frame included), their feature grids, and where the art compared sits: `card` is
  // an inset inside the frame (fractions of the card), `thumb` the same area on the official thumbnail. Member cards
  // show a zoomed crop of the thumbnail's upper part (measured on IMG_0012 by template matching).
  const KINDS = {
    member: { aspect: 0.75, gw: 12, gh: 16, card: { x: 0.05, y: 0.04 }, thumb: { x: 0.132, y: 0.009, w: 0.707, h: 0.71 } },
    snap: { aspect: 16 / 9, gw: 16, gh: 9, card: { x: 0.04, y: 0.07 }, thumb: { x: 0, y: 0, w: 1, h: 1 } },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Pixels

  function lum(d, i) {
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  /** Grayscale copy scaled to `tw` wide (box filter). */
  function grayScaled(img, tw) {
    const s = img.width / tw;
    const th = Math.max(1, Math.round(img.height / s));
    const out = new Float32Array(tw * th);
    const d = img.data;
    const step = Math.max(1, Math.floor(s / 2));
    for (let y = 0; y < th; y++) {
      const y0 = Math.floor(y * s), y1 = Math.min(img.height, Math.floor((y + 1) * s));
      for (let x = 0; x < tw; x++) {
        const x0 = Math.floor(x * s), x1 = Math.min(img.width, Math.floor((x + 1) * s));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy += step)
          for (let xx = x0; xx < x1; xx += step) {
            sum += lum(d, (yy * img.width + xx) * 4);
            n++;
          }
        out[y * tw + x] = n ? sum / n : 0;
      }
    }
    return { w: tw, h: th, g: out, scale: s };
  }

  /** Share of strong vertical edges in each column (within rows y0..y1) and horizontal edges in each row. */
  function edgeProfiles(G, x0 = 0, x1 = G.w, y0 = 0, y1 = G.h) {
    const { w, g } = G;
    const ex = new Float32Array(w);
    const ey = new Float32Array(G.h);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1 - 1; x++) if (Math.abs(g[y * w + x + 1] - g[y * w + x]) > EDGE_THRESHOLD) ex[x]++;
    for (let y = y0; y < y1 - 1; y++)
      for (let x = x0; x < x1; x++) if (Math.abs(g[(y + 1) * w + x] - g[y * w + x]) > EDGE_THRESHOLD) ey[y]++;
    for (let x = 0; x < w; x++) ex[x] /= Math.max(1, y1 - y0);
    for (let y = 0; y < G.h; y++) ey[y] /= Math.max(1, x1 - x0);
    return { ex, ey };
  }

  /** Peak strength around each position (max of ±1), minus the profile's median so flat regions score ~0. */
  function peakSignal(p) {
    const sorted = Array.from(p).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) {
      const v = Math.max(p[i], i > 0 ? p[i - 1] : 0, i + 1 < p.length ? p[i + 1] : 0);
      out[i] = Math.max(0, v - med);
    }
    return out;
  }

  /**
   * Best regular grid on one axis: n cells of `size` every `pitch` from `start`, all inside the axis. The score is
   * the strength of `startSig` at each cell start plus `endSig` at each cell end, summed over the 2n edges and
   * divided by sqrt(2n), which prefers the true pitch over half or double of it.
   */
  function fitAxis(startSig, endSig, { minSize, maxSize, pitchRange, minCount = 1 }) {
    const len = startSig.length;
    let best = null;
    for (let size = minSize; size <= Math.min(maxSize, len); size++) {
      const [pLo, pHi] = pitchRange(size);
      for (let start = 0; start + size < len; start++) {
        const first = startSig[start] + endSig[start + size];
        for (let pitch = Math.max(size + 1, pLo); pitch <= pHi; pitch++) {
          let sum = first, n = 1;
          for (let p = start + pitch; p + size < len; p += pitch) {
            sum += startSig[p] + endSig[p + size];
            n++;
          }
          if (n < minCount) continue;
          const score = sum / Math.sqrt(2 * n);
          if (!best || score > best.score) best = { start, size, pitch, count: n, score };
          if (n === 1) break; // every larger pitch also gives a single cell
        }
      }
    }
    return best;
  }

  /**
   * Where the cards' left and right frame edges run: for each row, the share of those edge columns with a strong
   * horizontal step. It is high along a card and drops in the gaps between rows, so its rises and falls mark the
   * card tops and bottoms (badges above a card do not reach the side edges).
   */
  function sideSteps(G, cols) {
    const { w, h, g } = G;
    const xs = [];
    for (let c = 0; c < cols.count; c++) xs.push(cols.start + c * cols.pitch, cols.start + c * cols.pitch + cols.size);
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (const xe of xs) {
        let hit = false;
        for (let x = Math.max(0, xe - 2); x <= Math.min(w - 2, xe + 1) && !hit; x++)
          hit = Math.abs(g[y * w + x + 1] - g[y * w + x]) > EDGE_THRESHOLD;
        if (hit) n++;
      }
      prof[y] = n / xs.length;
    }
    const K = 2;
    const rise = new Float32Array(h), fall = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let before = 0, after = 0;
      for (let k = 1; k <= K; k++) {
        before += y - k >= 0 ? prof[y - k] : 0;
        after += y + k - 1 < h ? prof[y + k - 1] : 0;
      }
      const d = (after - before) / K;
      rise[y] = Math.max(0, d);
      fall[y] = Math.max(0, -d);
    }
    return { rise, fall };
  }

  /**
   * Finds the card grid. Returns {kind: "member"|"snap", cells: [{x, y, w, h, row, col}]} in image pixels, or null.
   */
  function detectGrid(img) {
    const G = grayScaled(img, Math.min(WORK_WIDTH, img.width));
    const s = G.scale;
    const ex = peakSignal(edgeProfiles(G).ex);
    // Columns: at least two cards across, each between 1/14 and 1/2 of the width.
    const cols = fitAxis(ex, ex, {
      minSize: Math.round(G.w / 14),
      maxSize: Math.round(G.w / 2),
      pitchRange: (size) => [size + 2, Math.round(size * 1.35)],
      minCount: 2,
    });
    if (!cols) return null;
    const { rise, fall } = sideSteps(G, cols);
    let best = null;
    for (const kind of Object.keys(KINDS)) {
      const h = cols.size / KINDS[kind].aspect;
      const rows = fitAxis(rise, fall, {
        minSize: Math.round(h * 0.9),
        maxSize: Math.round(h * 1.1),
        pitchRange: (size) => [size + 2, Math.round(size * 1.35)],
      });
      if (rows && (!best || rows.score > best.rows.score)) best = { kind, rows };
    }
    if (!best) return null;
    const { rows, kind } = best;
    const cells = [];
    for (let r = 0; r < rows.count; r++)
      for (let c = 0; c < cols.count; c++)
        cells.push({
          x: Math.round((cols.start + c * cols.pitch) * s),
          y: Math.round((rows.start + r * rows.pitch) * s),
          w: Math.round(cols.size * s),
          h: Math.round(rows.size * s),
          row: r,
          col: c,
        });
    return { kind, cells, cols, rows };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Card identification

  /** Mean colour of a gw×gh grid over rect (x, y, w, h) of img, as [r, g, b] per cell. */
  function colorGrid(img, x, y, w, h, gw, gh) {
    const out = new Float32Array(gw * gh * 3);
    const d = img.data;
    const S = 4; // samples per cell side
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = 0; sy < S; sy++)
          for (let sx = 0; sx < S; sx++) {
            const px = Math.min(img.width - 1, Math.max(0, Math.floor(x + ((gx + (sx + 0.5) / S) * w) / gw)));
            const py = Math.min(img.height - 1, Math.max(0, Math.floor(y + ((gy + (sy + 0.5) / S) * h) / gh)));
            const i = (py * img.width + px) * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            n++;
          }
        const o = (gy * gw + gx) * 3;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
      }
    return out;
  }

  /** Cells that badges and the level strip cover on the in-game card. */
  function featureMask(kind) {
    const { gw, gh } = KINDS[kind];
    const m = new Uint8Array(gw * gh).fill(1);
    const off = (x, y) => (m[y * gw + x] = 0);
    const corner = kind === "member" ? [3, 2] : [2, 2];
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        if (y < corner[1] && (x < corner[0] || x >= gw - corner[0])) off(x, y); // attribute icon, "!" mark
        if (kind === "member" && y === 0) off(x, y); // "♪ 20%" badge
        if (y >= gh - 2 && (x < Math.ceil(gw * 0.45) || x >= gw - Math.ceil(gw * 0.2))) off(x, y); // Lv text, star
      }
    return m;
  }

  /** Masked colour grid, normalised per channel (mean 0, unit spread) so tint and brightness matter less. */
  function feature(img, rect, kind) {
    const { gw, gh } = KINDS[kind];
    const raw = colorGrid(img, rect.x, rect.y, rect.w, rect.h, gw, gh);
    const mask = featureMask(kind);
    const n = mask.reduce((a, b) => a + b, 0);
    const out = new Float32Array(raw.length);
    for (let c = 0; c < 3; c++) {
      let mean = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) mean += raw[i * 3 + c];
      mean /= n;
      let v = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) v += (raw[i * 3 + c] - mean) ** 2;
      const sd = Math.sqrt(v / n) + 8;
      for (let i = 0; i < mask.length; i++) out[i * 3 + c] = mask[i] ? (raw[i * 3 + c] - mean) / sd : 0;
    }
    return out;
  }

  function distance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return s / a.length;
  }

  /** Feature of an official thumbnail. */
  function thumbFeature(img, kind) {
    const t = KINDS[kind].thumb;
    return feature(img, { x: t.x * img.width, y: t.y * img.height, w: t.w * img.width, h: t.h * img.height }, kind);
  }

  // Frames differ a little by rarity and the grid is found at reduced size, so a few insets are tried.
  const INSET_DELTAS = [-0.015, 0, 0.015];

  /**
   * Best matching thumbnails for one cell. `refs` is [{id, feat}] of the same kind.
   * Returns [{id, dist}] sorted, best first.
   */
  function identify(img, cell, kind, refs) {
    const inset = KINDS[kind].card;
    const feats = INSET_DELTAS.map((k) => {
      const ix = cell.w * (inset.x + k), iy = cell.h * (inset.y + k * KINDS[kind].aspect);
      return feature(img, { x: cell.x + ix, y: cell.y + iy, w: cell.w - 2 * ix, h: cell.h - 2 * iy }, kind);
    });
    const out = refs.map((r) => ({ id: r.id, dist: Math.min(...feats.map((f) => distance(f, r.feat))) }));
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Level text

  // Where "Lv.NN" is printed, as fractions of the card.
  const LEVEL_AREA = {
    member: { x0: 0, x1: 0.62, y0: 0.78, y1: 1 },
    snap: { x0: 0, x1: 0.45, y0: 0.68, y1: 1 },
  };

  /**
   * White glyphs in the level area. The text is white with a dark outline, which keeps it apart from white art.
   * Glyphs grow from clearly white pixels into greyish ones, since compressed screenshots blur thin strokes.
   * Returns {w, h, glyphs: [{x0, y0, x1, y1, n, pixels}]} with coordinates inside the area.
   */
  function levelGlyphs(img, cell, kind) {
    const a = LEVEL_AREA[kind];
    const ox = Math.max(0, Math.round(cell.x + a.x0 * cell.w)), oy = Math.max(0, Math.round(cell.y + a.y0 * cell.h));
    const w = Math.min(img.width, Math.round(cell.x + a.x1 * cell.w)) - ox;
    const h = Math.min(img.height, Math.round(cell.y + a.y1 * cell.h)) - oy;
    if (w <= 2 || h <= 2) return { w: 0, h: 0, glyphs: [] };
    const d = img.data;
    const mask = new Uint8Array(w * h); // 2 white, 1 greyish white
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((oy + y) * img.width + ox + x) * 4;
        const lo = Math.min(d[i], d[i + 1], d[i + 2]), hi = Math.max(d[i], d[i + 1], d[i + 2]);
        mask[y * w + x] = lo > 200 && hi - lo < 45 ? 2 : lo > 175 && hi - lo < 55 ? 1 : 0;
      }
    const label = new Int32Array(w * h).fill(-1);
    const glyphs = [];
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (mask[start] !== 2 || label[start] >= 0) continue;
      const g = { x0: w, y0: h, x1: -1, y1: -1, n: 0, pixels: [], edge: false };
      label[start] = glyphs.length;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p - x) / w;
        g.n++;
        g.pixels.push(p);
        if (x < g.x0) g.x0 = x;
        if (x > g.x1) g.x1 = x;
        if (y < g.y0) g.y0 = y;
        if (y > g.y1) g.y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) g.edge = true;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= w * h || !mask[q] || label[q] >= 0) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          label[q] = glyphs.length;
          stack.push(q);
        }
      }
      glyphs.push(g);
    }
    return { w, h, glyphs: glyphs.filter((g) => !g.edge && g.n >= 6) };
  }

  /**
   * The digit glyphs of "Lv.NN": after the "L" (the leftmost glyph of full height), the run of glyphs of the same
   * height on the same baseline ("v" and "." are shorter). Returns {area, capH, digits} with digits left to right.
   */
  function levelDigits(img, cell, kind) {
    const area = levelGlyphs(img, cell, kind);
    const gh = (g) => g.y1 - g.y0 + 1, gw = (g) => g.x1 - g.x0 + 1;
    const tall = area.glyphs
      .filter((g) => gh(g) >= area.h * 0.25 && gh(g) <= area.h * 0.9 && gw(g) <= gh(g) * 0.9)
      .sort((p, q) => p.x0 - q.x0);
    for (const L of tall) {
      const capH = gh(L);
      // Round digits overshoot the cap height a little; at small sizes that is a pixel or two.
      const tol = Math.max(2, capH * 0.12);
      const same = (g) => Math.abs(g.y1 - L.y1) <= tol && Math.abs(gh(g) - capH) <= tol;
      const rest = tall.filter((g) => g.x0 > L.x1 && same(g));
      if (!rest.length || rest[0].x0 - L.x1 > capH * 2.2) continue;
      const digits = [rest[0]];
      for (const g of rest.slice(1)) {
        if (g.x0 - digits[digits.length - 1].x1 > capH * 0.5 || digits.length === 3) break;
        digits.push(g);
      }
      return { area, capH, digits };
    }
    return { area, capH: 0, digits: [] };
  }

  const DIGIT_W = 8, DIGIT_H = 12;

  /** Ink coverage of a glyph on a DIGIT_W×DIGIT_H grid over a box capH tall and 0.8·capH wide around it. */
  function digitFeature(area, g, capH) {
    const out = new Float32Array(DIGIT_W * DIGIT_H);
    const bw = capH * 0.8, cx = (g.x0 + g.x1 + 1) / 2, bx = cx - bw / 2, by = g.y1 + 1 - capH;
    const cnt = new Float32Array(out.length);
    for (const p of g.pixels) {
      const x = p % area.w, y = (p - x) / area.w;
      const gx = Math.floor(((x + 0.5 - bx) / bw) * DIGIT_W), gy = Math.floor(((y + 0.5 - by) / capH) * DIGIT_H);
      if (gx >= 0 && gx < DIGIT_W && gy >= 0 && gy < DIGIT_H) cnt[gy * DIGIT_W + gx]++;
    }
    const cellArea = (bw / DIGIT_W) * (capH / DIGIT_H);
    for (let i = 0; i < out.length; i++) out[i] = Math.min(1, cnt[i] / cellArea);
    return out;
  }

  // Digit templates (coverage ×9 per cell, row by row): for each digit, the mean of the game's glyphs read from
  // screenshots when available (0–6), then the same digit in Arial, Arial Bold, Segoe UI and Malgun Gothic, which
  // stand in for digits not seen yet.
  const DIGIT_TEMPLATES = [
    ["059999500660057029400492172002712930039217200271293003922930039217200271196006910575575001799710","005885000351153008400280090000900800007009000090090000900800007009000090084002800351153000588500","005885000366663008911980096006900840048009600690096006900840048009600690089119800366663000588500","007887000360063009200280070000702800009124000072370000833700009007000070091002800340062001889600","004885000250053007100170070000700500005009000090090000900600005007000070071001700350052000588400"],
    ["000186000047740000369600000065000000760000006500000087000000760000006500000086000000540000008600","000036000001540000198600006536000000240000003600000036000000240000003600000036000000240000003600","000079000001660000299900009979000030460000006900000069000000460000006900000069000000460000006900","000047000026740000443700000024000000370000002400000037000000370000002400000037000000240000003700","000025000003640000674600001036000000240000003600000036000000240000003600000036000000240000003600"],
    ["017998300463356009500390031002900000036000004950003873000164000007800000094000000853333009999990","015896100451055009200190060000900000016000000660000067000004500000681000058100000720000009999990","004996100268665007930792036006930000046100003970000398100007610000693000049933310568666219999993","039797000610063000000370000002400000046000000710000183000028300001710000064000000700000009999990","015973000430161001000450000003600000032000001810000183000007100000750000055000000520000009999990"],
    ["017997100364463006500760021006600000162000089400000459400000046006200690095006900464464001899810","015985000350153009200370010003700000153000069810000006800000008002000090091001900550155001598510","015985000466663009701980002009800002563000069810000238900000048004300490098118900466665001588510","039798100210063000000370000002400000181000476100002348300000029000000070000001900300034006979710","016993000110160000000620000006200000150000469100002367100000032000000360000004400410160003799200"],
    ["000069300001772000068930000717200047093000610720057009301954496127787772022239510000072000000930","000039000000560000019900000769000025260000813900054039001500260039999993000039000000260000003900","000049300000662000049930001989300046262002943930087039301820262039999993286679920000262000003930","000009300000372000008830000164200007273000240420018107300830073027779772133348610000042000000730","000008300000262000007630000536300015042000620630054006300600042039999993000006300000042000000630"],
    ["099999300740000009400000072000000969993007722740033007900000079007200470098008900376673001698600","019999900250000004600000063130000556661008400680000000900000006004000090091001900451154001588510","009999600266864003954320069140000466850009969960002007910000046213400693098119800366863000589500","009999700070000000800000014000000383200002777600000017700000019000000070000001900300063006979600","009999300040000000600000006000000153100002669500000006200000024000000360000005300210250004899100"],
    ["017997100562263009500660093000000622310009799930096007800620026009300390095005900564464001799710","004796100261045007400190090000000614630009743860092001900800006009000090084001900361054000489510","003795000166863007931980098001002640400039889830399459802650046109700693079318900266863000479500","001899400063000002900000043000000730400006379610099106800930009004200070064001900160034000399810","001699400054001004700000072000000601300009466830093001800800006009000090082000800351033000588500"],
    ["099999900000027000000740000048000000520000028000000650000006100000290000004600000044000000630000","099999900866668004333890000059200000650000049200000880000016400000393000006910000046000000890000","099999900000026000000740000016000000660000006100000090000003700000042000000920000007000000390000","099999900000015000000540000018000000230000007100000250000003200000070000001600000023000000430000"],
    ["005885000351153008400390083002900350053000899800076006800800008009000090091001900551055001589610","015996100466664009811890097007900364463001899810089438800840038009600390098107900566665001589610","018897000340063008300370042002400370083000477300038339301910019024000072290000900630036001888810","005885000340043008000180071001700340043000799700064004600400004009000090080000800440044001588510"],
    ["015885000451153009200190090000900800008009100190058437900026416000000090081003800450163001698400","016984000566663009601980093006900830048009834990039998900013048000200790097039800566662001697400","006997000260063007300180062000700830009003600370019987900003109000000160000004600200171004999300","005885000330153008000280090000900600008007100390038666900003106000000180000006400100350004896100"],
  ].map((list) => list.map((t) => Float32Array.from(t, (c) => Number(c) / 9)));

  // Enclosed counters of each digit in the game font ("4" is closed).
  const DIGIT_HOLES = [1, 0, 0, 0, 1, 0, 1, 0, 2, 1];

  /** Number of background regions inside a glyph's box that do not reach the box edge. */
  function holeCount(area, g) {
    const w = g.x1 - g.x0 + 3, h = g.y1 - g.y0 + 3; // one pixel of margin all round
    const ink = new Uint8Array(w * h);
    for (const p of g.pixels) {
      const x = p % area.w, y = (p - x) / area.w;
      ink[(y - g.y0 + 1) * w + (x - g.x0 + 1)] = 1;
    }
    const seen = new Uint8Array(w * h);
    let holes = 0;
    for (let start = 0; start < w * h; start++) {
      if (ink[start] || seen[start]) continue;
      let size = 0, outside = false;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p - x) / w;
        size++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) outside = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!ink[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      if (!outside && size >= 2) holes++;
    }
    return holes;
  }

  // Added to a digit's distance when its hole count differs from the glyph's (small glyphs can close or open one).
  const HOLE_PENALTY = 4;

  /** Nearest digit template; `holes` (the glyph's hole count) breaks near ties such as 5/6 and 0/8. */
  function readDigit(f, holes) {
    let best = { digit: -1, dist: Infinity }, second = Infinity;
    DIGIT_TEMPLATES.forEach((list, digit) => {
      const d =
        Math.min(...list.map((t) => distance(f, t) * f.length)) +
        (holes === undefined || DIGIT_HOLES[digit] === Math.min(holes, 2) ? 0 : HOLE_PENALTY);
      if (d < best.dist) {
        if (best.digit >= 0) second = best.dist;
        best = { digit, dist: d };
      } else if (d < second) second = d;
    });
    return { ...best, margin: second - best.dist };
  }

  /** Reads "Lv.NN" on a card: {level, sure} or null when no digits were found. */
  function readLevel(img, cell, kind) {
    const { area, capH, digits } = levelDigits(img, cell, kind);
    if (!digits.length) return null;
    const read = digits.map((g) => readDigit(digitFeature(area, g, capH), holeCount(area, g)));
    const level = Number(read.map((r) => r.digit).join(""));
    return { level, sure: level > 0 && read.every((r) => r.dist < 20 && r.margin > 0.5) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Whole screenshot

  const SURE_DIST = 0.3, MAYBE_DIST = 0.45, SURE_RATIO = 1.8;

  /**
   * Reads one screenshot. `refs` is {member: [{id, feat}], snap: [{id, feat}]} (see thumbFeature); `grid` may be
   * passed when detectGrid already ran (to learn which kind of thumbnails to prepare).
   * Returns {kind, cards: [{cell, id, dist, alternatives, sure, level}]} for every cell that looks like a card, or
   * null when no card grid is found.
   */
  function analyze(img, refs, grid = detectGrid(img)) {
    if (!grid || !refs[grid.kind] || !refs[grid.kind].length) return null;
    const cards = [];
    for (const cell of grid.cells) {
      const m = identify(img, cell, grid.kind, refs[grid.kind]);
      if (!m.length || m[0].dist > MAYBE_DIST) continue; // empty slot or a card cut off by the screen edge
      const ratio = m.length > 1 ? m[1].dist / m[0].dist : Infinity;
      const sure = m[0].dist <= SURE_DIST && ratio >= SURE_RATIO;
      const level = readLevel(img, cell, grid.kind);
      if (!sure && !level) continue; // a weak match without level text is not a card
      cards.push({ cell, id: m[0].id, dist: m[0].dist, alternatives: m.slice(1, 4).map((x) => x.id), sure, level });
    }
    return { kind: grid.kind, cards };
  }

  const api = {
    KINDS, analyze, detectGrid, thumbFeature, identify, readLevel, fitAxis, levelGlyphs, levelDigits, digitFeature,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Recognize = api;
})(typeof self !== "undefined" ? self : this);
