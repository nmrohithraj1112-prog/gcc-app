const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '.env.local' });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'gcc-intel';
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || '';

let db;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ Connected to MongoDB');
}

// ── Data helpers ──────────────────────────────────────────────────────────────

async function saveNewsSection(section, items) {
  const date = todayStr();
  await Promise.all([
    // Rolling cache (current data)
    db.collection('news_cache').updateOne(
      { section },
      { $set: { section, items, updated_at: new Date() } },
      { upsert: true }
    ),
    // Historical record keyed by date + section
    db.collection('news_history').updateOne(
      { date, section },
      { $set: { date, section, items, updated_at: new Date() } },
      { upsert: true }
    ),
  ]);
  await db.collection('settings').updateOne(
    { key: 'last_refresh' },
    { $set: { key: 'last_refresh', value: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getAllNews() {
  const docs = await db.collection('news_cache').find({}).toArray();
  const result = {};
  docs.forEach(d => { result[d.section] = d.items; });
  return result;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function weekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((day + 6) % 7));
  const fri = new Date(mon);
  fri.setDate(mon.getDate() + 4);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(mon), end: fmt(fri) };
}

// ── Teams Webhook ─────────────────────────────────────────────────────────────

async function notifyTeams(items) {
  if (!TEAMS_WEBHOOK) return;
  const high = items.filter(i => ['High', 'Act Now', 'Risk', 'Accelerating'].includes(i.pill)).slice(0, 5);
  if (!high.length) return;
  try {
    const body = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.5',
          body: [
            {
              type: 'TextBlock',
              text: '🔵 GCC Intel · High Priority Alert',
              weight: 'Bolder',
              size: 'Large',
              color: 'Accent',
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: `${high.length} important item${high.length > 1 ? 's' : ''} · ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
              isSubtle: true,
              size: 'Small',
            },
            ...high.map(item => ({
              type: 'Container',
              separator: true,
              items: [
                { type: 'TextBlock', text: item.title, weight: 'Bolder', wrap: true },
                {
                  type: 'TextBlock',
                  text: item.body.replace(/<[^>]+>/g, '').slice(0, 200) + '…',
                  wrap: true,
                  isSubtle: true,
                  size: 'Small',
                },
                {
                  type: 'FactSet',
                  facts: [
                    { title: 'Priority', value: item.pill },
                    { title: 'Source', value: item.src },
                  ],
                },
                ...(item.url ? [{
                  type: 'ActionSet',
                  actions: [{ type: 'Action.OpenUrl', title: '↗ Read article', url: item.url }],
                }] : []),
              ],
            })),
          ],
        },
      }],
    };
    const r = await fetch(TEAMS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('Teams notify HTTP', r.status, await r.text());
    else console.log(`✅ Teams notified (${high.length} high-priority items)`);
  } catch (e) {
    console.error('Teams notify error:', e.message);
  }
}

// ── og:image fetcher ──────────────────────────────────────────────────────────

async function fetchOgImage(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(articleUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GCCIntel/1.0; +https://gccintel.app)',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    // Read only first 20KB to find the <head> og:image quickly
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const body = () => new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => resolve(b));
  });

  try {

    // ── Refresh (AI fetch) ──────────────────────────────────────────────────
    if (pathname === '/api/refresh' && req.method === 'POST') {
      const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_API_KEY) return json(500, { error: 'API key not configured' });
      const { section } = JSON.parse(await body());
      if (!section) return json(400, { error: 'Missing section' });

      const handler = require('./api/refresh.js').default;
      const mockRes = {
        statusCode: 200, data: null,
        setHeader: () => {},
        status(code) { this.statusCode = code; return { json: d => { this.data = d; }, end: () => {} }; },
        json(d) { this.data = d; },
        end() {},
      };
      await handler({ method: 'POST', body: { section } }, mockRes);

      if (mockRes.statusCode === 200 && mockRes.data?.items) {
        const items = mockRes.data.items;
        // Enrich each item with og:image fetched server-side
        await Promise.all(items.map(async item => {
          item.img = await fetchOgImage(item.url);
        }));
        await saveNewsSection(section, items);
        return json(200, { items });
      }
      return json(mockRes.statusCode, mockRes.data || {});
    }

    // ── Cached news (all sections) ──────────────────────────────────────────
    if (pathname === '/api/data' && req.method === 'GET') {
      return json(200, await getAllNews());
    }

    // ── Save / unsave article ───────────────────────────────────────────────
    if (pathname === '/api/save' && req.method === 'POST') {
      const { title, item, action } = JSON.parse(await body());
      if (action === 'unsave') {
        await db.collection('saved_items').deleteOne({ title });
      } else {
        const { _id, ...clean } = item;
        await db.collection('saved_items').updateOne(
          { title },
          { $set: { ...clean, saved_at: new Date() } },
          { upsert: true }
        );
      }
      return json(200, { ok: true });
    }

    // ── Get saved articles ──────────────────────────────────────────────────
    if (pathname === '/api/saved' && req.method === 'GET') {
      const items = await db.collection('saved_items').find({}).sort({ saved_at: -1 }).toArray();
      items.forEach(i => delete i._id);
      return json(200, items);
    }

    // ── Settings (last_refresh etc.) ────────────────────────────────────────
    if (pathname === '/api/settings' && req.method === 'GET') {
      const docs = await db.collection('settings').find({}).toArray();
      const settings = {};
      docs.forEach(d => { settings[d.key] = d.value; });
      return json(200, settings);
    }

    // ── History for a date ──────────────────────────────────────────────────
    if (pathname === '/api/history' && req.method === 'GET') {
      const date = parsed.query.date || todayStr();
      const docs = await db.collection('news_history').find({ date }).toArray();
      const sections = {};
      docs.forEach(d => { sections[d.section] = d.items; });
      return json(200, { date, sections });
    }

    // ── Weekly history (Mon–Fri) ────────────────────────────────────────────
    if (pathname === '/api/weekly' && req.method === 'GET') {
      const { start, end } = weekBounds();
      const docs = await db.collection('news_history')
        .find({ date: { $gte: start, $lte: end } })
        .sort({ date: 1, section: 1 })
        .toArray();
      const byDay = {};
      docs.forEach(d => {
        if (!byDay[d.date]) byDay[d.date] = {};
        byDay[d.date][d.section] = d.items;
      });
      const days = Object.entries(byDay).map(([date, sections]) => ({ date, sections }));
      return json(200, { start, end, days });
    }

    // ── Clear all cached data (for testing new prompts) ────────────────────
    if (pathname === '/api/cleardata' && req.method === 'POST') {
      await Promise.all([
        db.collection('news_cache').deleteMany({}),
        db.collection('news_history').deleteMany({}),
        db.collection('settings').deleteMany({}),
      ]);
      console.log('🗑️  All news data cleared');
      return json(200, { ok: true, message: 'All data cleared' });
    }

    // ── Teams notify (called by frontend after full refresh) ────────────────
    if (pathname === '/api/teams-notify' && req.method === 'POST') {
      const { items } = JSON.parse(await body());
      await notifyTeams(items || []);
      return json(200, { ok: true });
    }

    // ── Static files ────────────────────────────────────────────────────────
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not Found'); }
      const ext = path.extname(filePath);
      const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    });

  } catch (e) {
    console.error(e);
    json(500, { error: e.message });
  }
});

connectMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ GCC Intel running at http://localhost:${PORT}`);
    console.log('   Model: claude-sonnet-4-6 | Data: RSS feeds → Claude analysis');
    console.log('   Auto-refresh: every 4 hours | Teams webhook:', TEAMS_WEBHOOK ? 'configured' : 'not set');
  });
}).catch(err => {
  console.error('❌ MongoDB connect failed:', err.message);
  process.exit(1);
});
