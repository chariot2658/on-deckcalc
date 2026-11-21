/*
 * Loads the master tables from StarMoe-org/moenotes-masterdata (raw GitHub) and music-data.json (with the
 * gekisou-levels.json beside it) from music-data/ beside the page: the deployment's (.github/workflows/pages.yml), or
 * on a local copy the one tools/build-local.py wrote, else the deployment's. Both are cached with the Cache API (keyed
 * by the masterdata version of the region).
 */
(function (root) {
  "use strict";

  const MASTER_ROOT = "https://raw.githubusercontent.com/StarMoe-org/moenotes-masterdata/main";
  const DEPLOYED_MUSIC_DATA = "https://chariot2658.github.io/on-deckcalc/music-data/music-data.json";
  const OWN_MUSIC_DATA = new URL("music-data/music-data.json", self.location.href).href;
  const ASSET_ROOT = "https://assets.bdon.moe";
  const MUSIC_DATA_MAX_AGE = 24 * 3600 * 1000;

  const REGIONS = {
    "hk-tw-mo": { label: "台港澳服", text: "_traditionalChinese", asset: "zh-Hant" },
    jp: { label: "日服", text: "_japanese", asset: "ja" },
    en: { label: "EN", text: "_english", asset: "en" },
    kr: { label: "韓服", text: "_korean", asset: "ko" },
  };

  const hasCache = typeof caches !== "undefined";

  async function cachedJson(cacheName, url, onProgress) {
    if (hasCache) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(url);
      if (hit) return hit.json();
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) throw new Error(url + ": HTTP " + res.status);
      await cache.put(url, res.clone());
      if (onProgress) onProgress();
      return res.json();
    }
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(url + ": HTTP " + res.status);
    if (onProgress) onProgress();
    return res.json();
  }

  async function dropCaches(prefix, keep) {
    if (!hasCache) return;
    for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== keep) await caches.delete(name);
  }

  /** The region's current masterdata version (always fetched fresh). */
  async function masterVersion(region) {
    const res = await fetch(MASTER_ROOT + "/current_version.json?t=" + Date.now(), { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error("current_version.json: HTTP " + res.status);
    const v = await res.json();
    const r = v.regions && v.regions[region];
    if (!r) throw new Error("unknown region " + region);
    return { version: r.version, verifiedAt: r.verified_at, path: r.data_path || region };
  }

  /** Every table the engine needs: {version, verifiedAt, raw: {Table: json}}. */
  async function loadMaster(region, tables, onProgress) {
    const info = await masterVersion(region);
    const cacheName = "deckcalc-master-" + region + "-" + String(info.version).replace(/[^\w.-]/g, "_");
    await dropCaches("deckcalc-master-" + region + "-", cacheName);
    let done = 0;
    const raw = {};
    await Promise.all(
      tables.map(async (t) => {
        raw[t] = await cachedJson(cacheName, MASTER_ROOT + "/" + info.path + "/" + t + ".json");
        done++;
        if (onProgress) onProgress(done, tables.length);
      }),
    );
    return { ...info, raw };
  }

  /**
   * music-data.json, refreshed once a day (or after `maxAge` ms, or when forced), with `gekisouLevels` attached: the
   * gekisou-levels.json the same build wrote beside it (the Gekisou skills' lower levels, measured; see
   * tools/build-music-data.py; Engine.battleFromMusicData uses it only when it was made from the same masterdata and
   * charts). Without it (an older build) the search falls back to sampled level factors.
   */
  async function loadMusicData(force, maxAge = MUSIC_DATA_MAX_AGE) {
    const stamp = Number(safeGet("deckcalc:musicDataAt") || 0);
    const cacheName = "deckcalc-musicdata";
    if (hasCache && (force || Date.now() - stamp > maxAge)) {
      await caches.delete(cacheName);
      safeSet("deckcalc:musicDataAt", String(Date.now()));
    }
    musicDataUrl = await chooseMusicData();
    const md = await cachedJson(cacheName, musicDataUrl);
    const levels = await cachedJson(cacheName, new URL("gekisou-levels.json", musicDataUrl).href).catch(() => null);
    if (md && levels) md.gekisouLevels = levels;
    return md;
  }

  let musicDataUrl = DEPLOYED_MUSIC_DATA;

  /** The local build when this page's server has one (or the page is the deployment), else the deployment's. */
  async function chooseMusicData() {
    try {
      const res = await fetch(OWN_MUSIC_DATA, { method: "HEAD", cache: "no-store" });
      if (res.ok) return OWN_MUSIC_DATA;
    } catch (e) {
      /* offline: the deployment's entry in the cache may still serve */
    }
    return DEPLOYED_MUSIC_DATA;
  }

  async function clearAll() {
    if (!hasCache) return;
    for (const name of await caches.keys()) if (name.startsWith("deckcalc-")) await caches.delete(name);
  }

  function memberThumb(region, assetId) {
    const lang = (REGIONS[region] || REGIONS["hk-tw-mo"]).asset;
    return `${ASSET_ROOT}/${lang}/MemberCard/${assetId}/member_thumbnail/member_thumbnail.webp`;
  }

  function snapThumb(region, assetId) {
    const lang = (REGIONS[region] || REGIONS["hk-tw-mo"]).asset;
    return `${ASSET_ROOT}/${lang}/SupportCard/${assetId}/snap_thumbnail/snap_thumbnail.webp`;
  }

  function safeGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }

  function safeSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* storage unavailable */
    }
  }

  function safeRemove(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {
      /* storage unavailable */
    }
  }

  root.Data = {
    REGIONS, get MUSIC_DATA_URL() { return musicDataUrl; }, loadMaster, loadMusicData, clearAll, memberThumb, snapThumb, safeGet, safeSet, safeRemove,
  };
})(self);
