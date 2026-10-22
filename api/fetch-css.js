// api/fetch-css.js
import JSZip from 'jszip';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

/* ---------------- helpers ---------------- */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function deriveFilename(urlStr, fallback = 'style.css') {
  try {
    const u = new URL(urlStr);
    let last = decodeURIComponent(
      (u.pathname.split('/').filter(Boolean).pop() || '').split('?')[0]
    );
    if (!last) return fallback;
    if (!/\.css$/i.test(last)) last = last.replace(/\.[a-z0-9]{1,8}$/i, '') + '.css';
    last = last.replace(/[^a-zA-Z0-9._-]/g, '_');
    return last || fallback;
  } catch {
    return fallback;
  }
}

function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot  = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot) : '';
  let i = 1, cand;
  do { cand = `${base}-${i}${ext}`; i++; } while (used.has(cand));
  used.add(cand);
  return cand;
}

async function fetchText(url, accept) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CssFetchProxy/1.0; +https://jfr-blob-db.vercel.app)',
      'Accept': accept,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function scrapeCssUrls(pageUrl) {
  const html = await fetchText(pageUrl, 'text/html,application/xhtml+xml,*/*;q=0.1');
  const out = new Set();
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    if (!rel || !/(^|\s)stylesheet(\s|$)/i.test(rel[1])) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    try {
      const abs = new URL(href[1], pageUrl).href;
      if (/^https?:/i.test(abs)) out.add(abs);
    } catch {}
  }
  return [...out];
}

/* ---------------- responses ---------------- */

async function sendSingle(url, res, overrideName) {
  const css  = await fetchText(url, 'text/css,*/*;q=0.1');
  const name = overrideName || deriveFilename(url);
  cors(res);
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('X-Filename', name);
  return res.status(200).send(css);
}

async function sendZip(urls, res, scrapeErrors = []) {
  const zip = new JSZip();
  const used = new Set();
  const results = [];

  await Promise.all(urls.map(async (url) => {
    try {
      const css  = await fetchText(url, 'text/css,*/*;q=0.1');
      const name = uniqueName(deriveFilename(url), used);
      zip.file(name, css);
      results.push({ url, filename: name, ok: true });
    } catch (e) {
      results.push({ url, ok: false, error: String(e.message || e) });
    }
  }));

  const okCount = results.filter(r => r.ok).length;
  if (!okCount) {
    cors(res);
    return res.status(502).json({ error: 'All CSS fetches failed', results, scrapeErrors });
  }

  zip.file('_manifest.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: results.length,
    ok: okCount,
    results,
    scrapeErrors,
  }, null, 2));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  cors(res);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="css-bundle.zip"');
  res.setHeader('X-Fetched', `${okCount}/${results.length}`);
  return res.status(200).send(buf);
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let single        = null;
    let overrideName  = null;
    let urls          = [];
    let scrapePages   = [];
    let forceZip      = false;

    if (req.method === 'GET') {
      const q = req.query;
      if (q.url)      single       = q.url;
      if (q.filename) overrideName = q.filename;
      if (q.urls) {
        const arr = Array.isArray(q.urls) ? q.urls : [q.urls];
        for (const v of arr) urls.push(...String(v).split(',').map(s => s.trim()).filter(Boolean));
      }
      if (q.scrape)    scrapePages.push(...(Array.isArray(q.scrape)    ? q.scrape    : [q.scrape]));
      if (q.scrapeUrl) scrapePages.push(...(Array.isArray(q.scrapeUrl) ? q.scrapeUrl : [q.scrapeUrl]));
      forceZip = q.zip === '1' || q.zip === 'true';
    } else {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      if (body.url)      single       = body.url;
      if (body.filename) overrideName = body.filename;
      if (body.urls) {
        const arr = Array.isArray(body.urls) ? body.urls : [body.urls];
        urls.push(...arr.filter(u => typeof u === 'string'));
      }
      const s = body.scrape ?? body.scrapeUrls ?? body.scrapeUrl;
      if (s) scrapePages.push(...(Array.isArray(s) ? s : [s]));
      forceZip = body.zip === true;
    }

    // Resolve scrape pages -> css urls
    const scrapeErrors = [];
    for (const page of scrapePages) {
      try {
        urls.push(...await scrapeCssUrls(page));
      } catch (e) {
        scrapeErrors.push({ page, error: String(e.message || e) });
      }
    }

    urls = [...new Set(urls)];

    // Single direct CSS download (unless zip is forced or extra urls were added)
    if (single && !forceZip && urls.length === 0) {
      return sendSingle(single, res, overrideName);
    }
    if (single) urls.unshift(single);

    if (!urls.length) {
      return res.status(400).json({
        error: 'Provide `url` (single CSS), `urls` (list/comma-separated), or `scrape` (page URL). Add `zip=1` to force a zip for a single URL.',
        scrapeErrors,
      });
    }

    return sendZip(urls, res, scrapeErrors);
  } catch (err) {
    console.error('fetch-css error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
