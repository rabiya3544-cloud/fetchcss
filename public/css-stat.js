// api/css-stats.js
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
export const maxDuration = 60;

const USER_AGENT        = 'Mozilla/5.0 (compatible; CssStats/1.0; +https://jfr-blob-db.vercel.app)';
const FETCH_TIMEOUT_MS  = 20000;
const PROBE_TIMEOUT_MS  = 10000;
const MAX_CSS_BYTES     = 5 * 1024 * 1024;
const CSS_CONCURRENCY   = 10;
const PROBE_CONCURRENCY = 16;

/* ================================================================
   Helpers
   ================================================================ */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

function assertSafeUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  if (isBlockedHost(u.hostname)) throw new Error(`Blocked host: ${u.hostname}`);
}

function deriveFileName(absUrl, fallback = 'file.css') {
  try {
    const u = new URL(absUrl);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || fallback;
  } catch { return fallback; }
}

function resolveRef(ref, baseUrl) {
  const s = String(ref || '').trim();
  if (!s) return null;
  if (s.startsWith('data:') || s.startsWith('#')) return null;
  try {
    const u = new URL(s, baseUrl);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

/* ================================================================
   CSS parsing
   ================================================================ */

function extractRefs(css) {
  const map = new Map();
  const add = (raw, type) => {
    raw = String(raw || '').trim();
    if (!raw) return;
    if (!map.has(raw)) map.set(raw, type);
  };

  let m;
  const importUrlRe = /@import\s+url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)"'\s][^)]*?))\s*\)/gi;
  while ((m = importUrlRe.exec(css))) add(m[1] ?? m[2] ?? m[3], 'import');

  const importStrRe = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = importStrRe.exec(css))) add(m[1] ?? m[2], 'import');

  const urlRe = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)"'\s][^)]*?))\s*\)/gi;
  while ((m = urlRe.exec(css))) add(m[1] ?? m[2] ?? m[3], 'url');

  return [...map.entries()].map(([raw, type]) => ({ raw, type }));
}

function resolveRefs(cssText, baseUrl) {
  const out = new Map();
  for (const { raw, type } of extractRefs(cssText)) {
    const abs = resolveRef(raw, baseUrl);
    if (!abs) continue;
    if (!out.has(abs)) out.set(abs, { url: abs, type, raw });
  }
  return [...out.values()];
}

/* ================================================================
   Asset classification  (font / image / css / other)
   ================================================================ */

function classifyAsset(url, contentType, refType) {
  if (refType === 'import') return 'css';

  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct.startsWith('font/') ||
      ct === 'application/font-woff'  ||
      ct === 'application/font-woff2' ||
      ct === 'application/x-font-ttf' ||
      ct === 'application/x-font-otf' ||
      ct === 'application/vnd.ms-fontobject') return 'font';
  if (ct.startsWith('image/')) return 'image';
  if (ct === 'text/css')       return 'css';

  let path = String(url || '');

  // data: URIs
  if (path.startsWith('data:')) {
    const mm = path.match(/^data:([^;,]+)/i);
    const mt = (mm ? mm[1] : '').toLowerCase();
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('font/') || mt.includes('font-') || mt.includes('font/')) return 'font';
    return 'other';
  }

  // strip query + fragment, then use pathname if parseable
  path = path.split(/[?#]/)[0];
  try { path = new URL(path, 'https://x.invalid/').pathname; } catch (_) {}
  path = path.toLowerCase();

  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?)$/i.test(path)) return 'image';
  if (/\.css$/i.test(path)) return 'css';

  return 'other';
}

/* ================================================================
   HTTP fetch
   ================================================================ */

async function fetchCss(url) {
  assertSafeUrl(url);
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/css,*/*;q=0.1' },
      signal: ac.signal,
    });
    assertSafeUrl(r.url || url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_CSS_BYTES) {
      throw new Error(`CSS too large (${buf.length} bytes)`);
    }

    return {
      bytes: buf.length,
      text: buf.toString('utf8'),
      contentType: r.headers.get('content-type') || '',
      finalUrl: r.url || url,
    };
  } finally { clearTimeout(t); }
}

async function probeAsset(url) {
  assertSafeUrl(url);
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
      signal: ac.signal,
    });
    assertSafeUrl(r.url || url);

    if (r.ok) {
      const len = r.headers.get('content-length');
      return {
        ok: true,
        bytes: len != null ? Number(len) : null,
        contentType: r.headers.get('content-type') || '',
      };
    }

    const r2 = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Range': 'bytes=0-0' },
      signal: ac.signal,
    });
    assertSafeUrl(r2.url || url);

    if (r2.ok || r2.status === 206) {
      const cr = r2.headers.get('content-range') || '';
      const match = cr.match(/\/(\d+)\s*$/);
      try { await r2.body?.cancel(); } catch (_) {}
      return {
        ok: true,
        bytes: match ? Number(match[1]) : null,
        contentType: r2.headers.get('content-type') || '',
      };
    }

    return { ok: false, bytes: null, contentType: '', error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, bytes: null, contentType: '', error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

/* ================================================================
   Concurrency pool
   ================================================================ */

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ================================================================
   Handler
   ================================================================ */

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let urls = [];
    let probeAssets = true;

    if (req.method === 'GET') {
      const q = req.query;
      if (q.url) urls.push(q.url);
      if (q.urls) {
        const arr = Array.isArray(q.urls) ? q.urls : [q.urls];
        for (const v of arr) urls.push(...String(v).split(',').map(s => s.trim()).filter(Boolean));
      }
      if (q.probe === '0' || q.probe === 'false') probeAssets = false;
    } else {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      if (body.url) urls.push(body.url);
      if (body.urls) {
        const arr = Array.isArray(body.urls) ? body.urls : [body.urls];
        urls.push(...arr.filter(u => typeof u === 'string'));
      }
      if (body.probeAssets === false) probeAssets = false;
    }

    urls = [...new Set(urls.map(u => String(u).trim()).filter(Boolean))];
    if (!urls.length) {
      return res.status(400).json({
        error: 'Provide `url` or `urls` (CSS file URLs). Set probeAssets/probe=0 to skip asset-size probing.',
      });
    }

    /* ------------------------------------------------------------
       1. fetch every CSS
       ------------------------------------------------------------ */
    const cssResults = await mapPool(urls, CSS_CONCURRENCY, async (url) => {
      try {
        const r = await fetchCss(url);
        const refs = resolveRefs(r.text, r.finalUrl);
        return {
          ok: true,
          url,
          finalUrl: r.finalUrl,
          filename: deriveFileName(r.finalUrl),
          bytes: r.bytes,
          contentType: r.contentType,
          refs,
        };
      } catch (e) {
        return { ok: false, url, error: String(e.message || e) };
      }
    });

    /* ------------------------------------------------------------
       2. probe every unique asset once
       ------------------------------------------------------------ */
    const allAssetUrls = new Set();
    for (const c of cssResults) {
      if (!c.ok) continue;
      for (const ref of c.refs) allAssetUrls.add(ref.url);
    }

    const assetInfo = new Map();
    if (probeAssets && allAssetUrls.size) {
      const assetList = [...allAssetUrls];
      const probed = await mapPool(assetList, PROBE_CONCURRENCY, async (u) => {
        const info = await probeAsset(u);
        return [u, info];
      });
      for (const [u, info] of probed) assetInfo.set(u, info);
    }

    /* ------------------------------------------------------------
       3. global ref counts: how many CSS reference each asset
       ------------------------------------------------------------ */
    const assetRefCount = new Map();
    const assetRefType  = new Map(); // url -> 'url' | 'import'
    for (const c of cssResults) {
      if (!c.ok) continue;
      for (const ref of c.refs) {
        assetRefCount.set(ref.url, (assetRefCount.get(ref.url) || 0) + 1);
        if (!assetRefType.has(ref.url)) assetRefType.set(ref.url, ref.type);
      }
    }

    /* ------------------------------------------------------------
       4. per-CSS stats
       ------------------------------------------------------------ */
    const perCss = [];
    for (const c of cssResults) {
      if (!c.ok) {
        perCss.push({ ok: false, url: c.url, error: c.error });
        continue;
      }

      const assets = c.refs.map(ref => {
        const info   = assetInfo.get(ref.url);
        const refs   = assetRefCount.get(ref.url) || 0;
        const kind   = classifyAsset(ref.url, info?.contentType, ref.type);
        const shared = refs > 1;

        if (probeAssets) {
          return {
            url: ref.url,
            type: ref.type,
            kind,
            refsInCss: refs,
            sharedWithOthers: shared,
            bytes: info ? info.bytes : null,
            contentType: info ? info.contentType : '',
            ok: info ? info.ok : false,
            ...(info && info.error ? { error: info.error } : {}),
          };
        }
        return {
          url: ref.url,
          type: ref.type,
          kind,
          refsInCss: refs,
          sharedWithOthers: shared,
          bytes: null,
          contentType: '',
          ok: true,
        };
      });

      const byKind      = { font: 0, image: 0, css: 0, other: 0 };
      const bytesByKind = { font: 0, image: 0, css: 0, other: 0 };
      for (const a of assets) {
        byKind[a.kind]++;
        if (a.bytes != null) bytesByKind[a.kind] += a.bytes;
      }

      const uniqueAssets = assets.filter(a => !a.sharedWithOthers).length;
      const sharedAssets = assets.length - uniqueAssets;
      const knownBytes   = assets.reduce((s, a) => s + (a.bytes || 0), 0);
      const unknownCount = assets.filter(a => a.bytes == null).length;

      perCss.push({
        ok: true,
        url: c.url,
        finalUrl: c.finalUrl,
        filename: c.filename,
        bytes: c.bytes,
        contentType: c.contentType,

        assetCount: assets.length,
        uniqueAssets,
        sharedAssets,
        importCount: byKind.css,

        fontCount:  byKind.font,
        imageCount: byKind.image,
        otherCount: byKind.other,

        assetBytes: probeAssets ? knownBytes : null,
        assetBytesUnknown: probeAssets ? unknownCount : null,
        fontBytes:  probeAssets ? bytesByKind.font  : null,
        imageBytes: probeAssets ? bytesByKind.image : null,
        otherBytes: probeAssets ? bytesByKind.other : null,

        assets,
      });
    }

    /* ------------------------------------------------------------
       5. summary
       ------------------------------------------------------------ */
    let uniqueAssetBytes        = 0;
    let uniqueAssetBytesUnknown = 0;
    let onlyInOneCss            = 0;
    let sharedAcrossCss         = 0;

    const uniqueByKind      = { font: 0, image: 0, css: 0, other: 0 };
    const uniqueBytesByKind = { font: 0, image: 0, css: 0, other: 0 };
    const refsByKind        = { font: 0, image: 0, css: 0, other: 0 };

    for (const [u, refs] of assetRefCount) {
      if (refs === 1) onlyInOneCss++;
      else if (refs > 1) sharedAcrossCss++;

      const info     = assetInfo.get(u);
      const refType  = assetRefType.get(u) || 'url';
      const kind     = classifyAsset(u, info?.contentType, refType);

      uniqueByKind[kind]++;
      refsByKind[kind] += refs;

      if (probeAssets) {
        if (info && info.ok && info.bytes != null) {
          uniqueAssetBytes += info.bytes;
          uniqueBytesByKind[kind] += info.bytes;
        } else {
          uniqueAssetBytesUnknown++;
        }
      }
    }

    const totalAssetRefs    = perCss.reduce((s, c) => s + (c.ok ? c.assetCount : 0), 0);
    const sharedRefOverhead = totalAssetRefs - allAssetUrls.size;

    const summary = {
      cssFiles:   perCss.length,
      cssFilesOk: perCss.filter(c => c.ok).length,
      cssBytes:   perCss.reduce((s, c) => s + (c.ok ? c.bytes : 0), 0),

      assetRefs: totalAssetRefs,
      uniqueAssets: allAssetUrls.size,
      sharedRefOverhead,
      avgRefsPerAsset: allAssetUrls.size
        ? +(totalAssetRefs / allAssetUrls.size).toFixed(2) : 0,

      onlyInOneCss,
      sharedAcrossCss,

      fontAssets:  uniqueByKind.font,
      imageAssets: uniqueByKind.image,
      cssAssets:   uniqueByKind.css,
      otherAssets: uniqueByKind.other,

      fontRefs:  refsByKind.font,
      imageRefs: refsByKind.image,
      cssRefs:   refsByKind.css,
      otherRefs: refsByKind.other,

      assetBytes: probeAssets ? uniqueAssetBytes : null,
      fontBytes:  probeAssets ? uniqueBytesByKind.font  : null,
      imageBytes: probeAssets ? uniqueBytesByKind.image : null,
      otherBytes: probeAssets ? uniqueBytesByKind.other : null,
      assetBytesUnknown: probeAssets ? uniqueAssetBytesUnknown : null,

      errors: perCss.filter(c => !c.ok).length,
      probeAssets,
    };

    const errors = perCss.filter(c => !c.ok).map(c => ({ url: c.url, error: c.error }));

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      summary,
      css: perCss,
      errors,
    });
  } catch (err) {
    console.error('css-stats error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}