// api/fetch-css-bundle.js
import JSZip from 'jszip';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
export const maxDuration = 60;

const FETCH_TIMEOUT_MS   = 20000;
const CONCURRENCY        = 24;
const PER_ASSET_LIMIT    = 5 * 1024 * 1024;      // 5 MB per file
const DEFAULT_MAX_ASSETS = 300;
const DEFAULT_MAX_BYTES  = 20 * 1024 * 1024;     // 20 MB total
const DEFAULT_MAX_DEPTH  = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; CssBundleFetcher/1.0; +https://jfr-blob-db.vercel.app)';

/* ---------- misc helpers ---------- */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Css-Count, X-Asset-Count, X-Total-Bytes');
}

function sanitizeName(name, fallback = 'file') {
  let s = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._-]+/, '');
  if (!s) s = fallback;
  if (s.length > 100) {
    const dot = s.lastIndexOf('.');
    s = (dot > 0 && s.length - dot < 12)
      ? s.slice(0, 100 - (s.length - dot)) + s.slice(dot)
      : s.slice(0, 100);
  }
  return s;
}

function deriveFileName(absUrl, fallback = 'file') {
  try {
    const u = new URL(absUrl);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (!last) return fallback;
    return sanitizeName(last, fallback);
  } catch { return fallback; }
}

function uniqueName(used, base) {
  if (!used.has(base)) { used.add(base); return base; }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext  = dot > 0 ? base.slice(dot) : '';
  let i = 1, cand;
  do { cand = `${stem}-${i}${ext}`; i++; } while (used.has(cand));
  used.add(cand);
  return cand;
}

function ensureCssExt(name) {
  return /\.css$/i.test(name) ? name : name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.css';
}

function extFromContentType(ct) {
  if (!ct) return '';
  const t = ct.toLowerCase().split(';')[0].trim();
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp',
    'image/avif': '.avif', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
    'image/bmp': '.bmp', 'image/tiff': '.tiff',
    'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf', 'font/otf': '.otf',
    'application/font-woff': '.woff', 'application/font-woff2': '.woff2',
    'application/x-font-ttf': '.ttf', 'application/x-font-otf': '.otf',
    'application/vnd.ms-fontobject': '.eot',
    'application/json': '.json', 'text/plain': '.txt', 'text/html': '.html',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
  };
  return map[t] || '';
}

function deriveAssetName(absUrl, contentType) {
  let name = deriveFileName(absUrl, 'asset');
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ext = extFromContentType(contentType);
    if (ext) name += ext;
  }
  return name;
}

function isCssContentType(ct, url) {
  const t = (ct || '').toLowerCase().split(';')[0].trim();
  if (t === 'text/css' || t === 'text/x-css') return true;
  if (t && t !== 'text/plain' && t !== 'application/octet-stream' && t !== 'binary/octet-stream') return false;
  try { return /\.css$/i.test(new URL(url).pathname); } catch { return false; }
}

/* ---------- SSRF guard (basic) ---------- */

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

/* ---------- fetch ---------- */

function resolveRef(ref, baseUrl) {
  const s = String(ref || '').trim();
  if (!s) return null;
  if (s.startsWith('data:') || s.startsWith('#')) return null;
  try { return new URL(s, baseUrl).href; } catch { return null; }
}

async function fetchResource(url) {
  assertSafeUrl(url);
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > PER_ASSET_LIMIT) throw new Error(`Asset too large (${buf.length} bytes)`);
    return {
      buffer: buf,
      contentType: r.headers.get('content-type') || '',
      finalUrl: r.url || url,
    };
  } finally { clearTimeout(t); }
}

/* ---------- CSS parsing ---------- */

function extractRefs(css) {
  const refs = [];
  const seen = new Set();
  let m;

  // 1) @import url(...)
  const importUrlRe = /@import\s+url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)"'\s][^)]*?))\s*\)/gi;
  while ((m = importUrlRe.exec(css))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    const key = 'import:' + raw;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ raw, type: 'import' });
  }

  // 2) @import "..."
  const importStrRe = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = importStrRe.exec(css))) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (!raw) continue;
    const key = 'import:' + raw;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ raw, type: 'import' });
  }

  // 3) url(...)
  const urlRe = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)"'\s][^)]*?))\s*\)/gi;
  while ((m = urlRe.exec(css))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    if (seen.has('import:' + raw)) continue;
    const key = 'url:' + raw;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ raw, type: 'url' });
  }

  return refs;
}

function rewriteCss(css, urlMap, baseUrl, urlToCanonical) {
  const lookup = (raw) => {
    const abs = resolveRef(raw, baseUrl);
    if (!abs) return null;
    const canonical = urlToCanonical.get(abs) || abs;
    return urlMap.get(canonical) || null;
  };

  // url(...) — includes @import url(...)
  css = css.replace(
    /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)"'\s][^)]*?))\s*\)/gi,
    (match, dq, sq, bare) => {
      const raw = (dq ?? sq ?? bare ?? '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return match;
      const local = lookup(raw);
      return local ? `url("${local}")` : match;
    }
  );

  // @import "..."
  css = css.replace(/@import\s+(?:"([^"]+)"|'([^']+)')/gi, (match, dq, sq) => {
    const raw = (dq ?? sq ?? '').trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return match;
    const local = lookup(raw);
    return local ? `@import url("${local}")` : match;
  });

  return css;
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let urls = [];
    let recursive = true;
    let maxDepth  = DEFAULT_MAX_DEPTH;
    let maxAssets = DEFAULT_MAX_ASSETS;
    let maxBytes  = DEFAULT_MAX_BYTES;

    if (req.method === 'GET') {
      const q = req.query;
      if (q.url) urls.push(q.url);
      if (q.urls) {
        const arr = Array.isArray(q.urls) ? q.urls : [q.urls];
        for (const v of arr) urls.push(...String(v).split(',').map(s => s.trim()).filter(Boolean));
      }
      if (q.recursive !== undefined) recursive = q.recursive !== '0' && q.recursive !== 'false';
      if (q.maxDepth)  maxDepth  = Math.max(0, parseInt(q.maxDepth,  10) || 0);
      if (q.maxAssets) maxAssets = Math.max(1, parseInt(q.maxAssets, 10) || DEFAULT_MAX_ASSETS);
      if (q.maxBytes)  maxBytes  = Math.max(1024, parseInt(q.maxBytes, 10) || DEFAULT_MAX_BYTES);
    } else {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      if (body.url) urls.push(body.url);
      if (body.urls) {
        const arr = Array.isArray(body.urls) ? body.urls : [body.urls];
        urls.push(...arr.filter(u => typeof u === 'string'));
      }
      if (body.recursive === false) recursive = false;
      if (body.maxDepth)  maxDepth  = Math.max(0, parseInt(body.maxDepth,  10) || 0);
      if (body.maxAssets) maxAssets = Math.max(1, parseInt(body.maxAssets, 10) || DEFAULT_MAX_ASSETS);
      if (body.maxBytes)  maxBytes  = Math.max(1024, parseInt(body.maxBytes, 10) || DEFAULT_MAX_BYTES);
    }

    urls = [...new Set(urls.map(u => String(u).trim()).filter(Boolean))];
    if (!urls.length) return res.status(400).json({ error: 'Provide `url` or `urls` (CSS file URL(s)).' });

    const errors = [];
    const rootUrls = [];
    for (const raw of urls) {
      try { assertSafeUrl(raw); rootUrls.push(new URL(raw).href); }
      catch (e) { errors.push({ url: raw, error: String(e.message || e) }); }
    }
    if (!rootUrls.length) return res.status(400).json({ error: 'No valid URLs', errors });

    /* ---------------- Phase 1: fetch ---------------- */
    const resources      = new Map(); // canonicalUrl -> { buffer, contentType, finalUrl, isCss, refs }
    const urlToCanonical = new Map(); // anyUrl -> canonicalUrl
    const inFlight       = new Set();
    let totalBytes = 0;
    let assetCount = 0;

    const queued = rootUrls.map(u => ({ url: u, depth: 0, isRoot: true, forceCss: true }));

    while (queued.length) {
      const wave = queued.splice(0, CONCURRENCY);
      const results = await Promise.all(wave.map(async (item) => {
        if (resources.has(item.url) || urlToCanonical.has(item.url) || inFlight.has(item.url)) {
          return { newRefs: [] };
        }
        inFlight.add(item.url);
        try {
          const r = await fetchResource(item.url);
          const finalUrl = r.finalUrl || item.url;

          if (urlToCanonical.has(finalUrl)) {
            urlToCanonical.set(item.url, urlToCanonical.get(finalUrl));
            return { newRefs: [] };
          }

          const isCss = !!(item.isRoot || item.forceCss || isCssContentType(r.contentType, finalUrl));

          if (!isCss) {
            if (assetCount >= maxAssets) {
              errors.push({ url: item.url, error: `maxAssets ${maxAssets} exceeded` });
              return { newRefs: [] };
            }
            if (totalBytes + r.buffer.length > maxBytes) {
              errors.push({ url: item.url, error: `maxBytes ${maxBytes} exceeded` });
              return { newRefs: [] };
            }
            assetCount++;
            totalBytes += r.buffer.length;
          }

          const rec = { buffer: r.buffer, contentType: r.contentType, finalUrl, isCss, refs: [] };
          resources.set(finalUrl, rec);
          urlToCanonical.set(finalUrl, finalUrl);
          urlToCanonical.set(item.url, finalUrl);

          if (!isCss) return { newRefs: [] };

          if (item.depth > maxDepth) {
            errors.push({ url: item.url, error: `maxDepth ${maxDepth} exceeded` });
            return { newRefs: [] };
          }

          const text = r.buffer.toString('utf8');
          const refs = extractRefs(text);
          rec.refs = refs;

          const newRefs = [];
          for (const ref of refs) {
            if (ref.type === 'import' && !recursive) continue;
            if (ref.raw.startsWith('data:') || ref.raw.startsWith('#')) continue;
            const abs = resolveRef(ref.raw, finalUrl);
            if (!abs) continue;
            if (resources.has(abs) || urlToCanonical.has(abs) || inFlight.has(abs)) continue;
            newRefs.push({
              url: abs,
              depth: item.depth + 1,
              isRoot: false,
              forceCss: ref.type === 'import',
            });
          }
          return { newRefs };
        } catch (e) {
          errors.push({ url: item.url, error: String(e.message || e) });
          return { newRefs: [] };
        } finally {
          inFlight.delete(item.url);
        }
      }));

      for (const r of results) if (r.newRefs?.length) queued.push(...r.newRefs);
    }

    /* ---------------- Phase 2: assign paths ---------------- */
    const usedNames = new Set();
    const urlMap    = new Map(); // canonicalUrl -> './local/path'

    // Root CSS first (preserves filenames the user probably expects)
    for (const rawUrl of rootUrls) {
      const canonical = urlToCanonical.get(rawUrl);
      if (!canonical || !resources.has(canonical)) continue;
      if (urlMap.has(canonical)) continue;
      const name = uniqueName(usedNames, ensureCssExt(deriveFileName(canonical, 'style.css')));
      urlMap.set(canonical, './' + name);
    }

    // Everything else
    for (const [canonical, rec] of resources) {
      if (urlMap.has(canonical)) continue;
      if (rec.isCss) {
        const name = uniqueName(usedNames, ensureCssExt(deriveFileName(canonical, 'imported.css')));
        urlMap.set(canonical, './' + name);
      } else {
        const name = uniqueName(usedNames, deriveAssetName(canonical, rec.contentType));
        urlMap.set(canonical, './assets/' + name);
      }
    }

    /* ---------------- Phase 3: rewrite + zip ---------------- */
    const zip = new JSZip();
    const savedPaths = new Set();
    const manifest = {
      generatedAt: new Date().toISOString(),
      options: { recursive, maxDepth, maxAssets, maxBytes },
      css: [],
      assets: [],
      errors,
    };

    for (const [canonical, rec] of resources) {
      const localPath = urlMap.get(canonical);
      if (!localPath) continue;
      const zipPath = localPath.replace(/^\.\//, '');
      if (savedPaths.has(zipPath)) continue;
      savedPaths.add(zipPath);

      if (rec.isCss) {
        const rewritten = rewriteCss(rec.buffer.toString('utf8'), urlMap, rec.finalUrl, urlToCanonical);
        zip.file(zipPath, rewritten);
        manifest.css.push({ url: rec.finalUrl, path: zipPath, refs: rec.refs?.length || 0 });
      } else {
        zip.file(zipPath, rec.buffer);
        manifest.assets.push({
          url: rec.finalUrl,
          path: zipPath,
          bytes: rec.buffer.length,
          contentType: rec.contentType,
        });
      }
    }

    if (!manifest.css.length) {
      return res.status(502).json({ error: 'No CSS files could be fetched', manifest });
    }

    manifest.summary = {
      cssFiles: manifest.css.length,
      assets:   manifest.assets.length,
      errors:   manifest.errors.length,
      totalBytes,
    };

    zip.file('_manifest.json', JSON.stringify(manifest, null, 2));

    const zipBuf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="css-bundle-with-assets.zip"');
    res.setHeader('X-Css-Count',   String(manifest.css.length));
    res.setHeader('X-Asset-Count', String(manifest.assets.length));
    res.setHeader('X-Total-Bytes', String(totalBytes));
    return res.status(200).send(zipBuf);
  } catch (err) {
    console.error('fetch-css-bundle error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
