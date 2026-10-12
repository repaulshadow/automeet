'use strict';
// Перевірка нової версії програми (інсталятора) через GitHub Releases.
const cfg = require('./config');

/** Розбір версії «v1.2.3-beta.4» → {nums:[1,2,3], pre:['beta',4]}. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? +x : x)) : [] };
}

/** -1, 0, 1 за правилами semver (реліз новіший за будь-яку пре-версію того ж номера). */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Назва файлу-інсталятора для цієї системи (фіксовані імена з release-workflow). */
function assetNameFor(platform, arch) {
  if (platform === 'win32') return 'AutoMeet-Windows.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'AutoMeet-macOS-arm64.dmg' : 'AutoMeet-macOS-intel.dmg';
  return null;
}

/**
 * Обирає з відповіді GitHub API найновіший доречний реліз.
 * Користувачі стабільної версії не бачать пре-релізів; користувачі беті бачать і їх.
 */
function pickRelease(releases, currentVersion) {
  const cur = parseVersion(currentVersion);
  const allowPre = !!(cur && cur.pre.length);
  let best = null;
  for (const r of releases || []) {
    if (r.draft) continue;
    if (r.prerelease && !allowPre) continue;
    if (!parseVersion(r.tag_name)) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/** Повертає {version, url, page, notes} якщо є новіша версія, інакше null. Помилки мережі → null. */
async function checkAppUpdate(currentVersion, { platform = process.platform, arch = process.arch, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${cfg.REPO}/releases?per_page=15`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AutoMeet-updater' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel = pickRelease(await res.json(), currentVersion);
  if (!rel || compareVersions(rel.tag_name, currentVersion) <= 0) return null;
  const want = assetNameFor(platform, arch);
  const asset = (rel.assets || []).find((a) => a.name === want);
  return {
    version: rel.tag_name.replace(/^v/, ''),
    url: asset ? asset.browser_download_url : rel.html_url,
    page: rel.html_url,
    notes: (rel.body || '').trim().slice(0, 600),
    direct: !!asset,
  };
}

module.exports = { parseVersion, compareVersions, assetNameFor, pickRelease, checkAppUpdate };
