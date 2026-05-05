const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const webPush = require('web-push');
require('dotenv').config({ path: '.env.local' });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'gcc-intel';
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || '';

let db;
let vapidPublicKey = '';

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ Connected to MongoDB');
  await initVapid();
}

// ── Web Push / VAPID ──────────────────────────────────────────────────────────

async function initVapid() {
  let doc = await db.collection('config').findOne({ key: 'vapid' });
  if (!doc) {
    const keys = webPush.generateVAPIDKeys();
    doc = { key: 'vapid', publicKey: keys.publicKey, privateKey: keys.privateKey };
    await db.collection('config').insertOne(doc);
    console.log('✅ Generated new VAPID keys');
  }
  vapidPublicKey = doc.publicKey;
  webPush.setVapidDetails('mailto:gccintel@app.local', doc.publicKey, doc.privateKey);
  console.log('✅ Web Push ready');
}

async function sendPushNotifications(payload) {
  const subs = await db.collection('push_subscriptions').find({}).toArray();
  if (!subs.length) return;
  const data = JSON.stringify(payload);
  await Promise.all(subs.map(async sub => {
    try {
      await webPush.sendNotification(sub.subscription, data);
      console.log('✅ Push sent to', sub.subscription.endpoint.slice(0, 50));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await db.collection('push_subscriptions').deleteOne({ _id: sub._id });
        console.log('🗑️  Removed expired push subscription');
      } else {
        console.error('Push error:', e.message);
      }
    }
  }));
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

const SECTION_META = {
  exec:       { name: 'Executive Snapshot',    color: 'Accent',    emoji: '📊' },
  themes:     { name: 'Strategic Themes',       color: 'Accent',    emoji: '🔮' },
  deals:      { name: 'Deals & Capital',        color: 'Good',      emoji: '🤝' },
  risks:      { name: 'Risks & Opportunities',  color: 'Attention', emoji: '⚠️'  },
  competitor: { name: 'Market Moves',           color: 'Warning',   emoji: '⚡' },
  talent:     { name: 'Talent Signals',         color: 'Good',      emoji: '👥' },
  policy:     { name: 'Policy & Regulation',    color: 'Warning',   emoji: '⚖️'  },
  tech:       { name: 'Technology Signals',     color: 'Accent',    emoji: '💡' },
};
const SECTION_ORDER = ['exec','themes','deals','risks','competitor','talent','policy','tech'];

async function notifyTeams(sections) {
  if (!TEAMS_WEBHOOK) return;
  const ts = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  for (const sectionId of SECTION_ORDER) {
    const items = sections[sectionId];
    if (!items || !items.length) continue;

    const meta = SECTION_META[sectionId] || { name: sectionId, color: 'Default', emoji: '📰' };
    const show = items.slice(0, 5);

    const card = {
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
              text: `${meta.emoji}  GCC Intel  ·  ${meta.name}`,
              weight: 'Bolder',
              size: 'Large',
              color: meta.color,
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: `${items.length} article${items.length > 1 ? 's' : ''}  ·  ${ts}`,
              isSubtle: true,
              size: 'Small',
              spacing: 'None',
            },
            ...show.map((item, idx) => ({
              type: 'Container',
              separator: true,
              spacing: idx === 0 ? 'Medium' : 'Default',
              items: [
                { type: 'TextBlock', text: item.title, weight: 'Bolder', wrap: true, size: 'Medium' },
                {
                  type: 'TextBlock',
                  text: item.body.replace(/<[^>]+>/g, '').slice(0, 180) + '…',
                  wrap: true, isSubtle: true, size: 'Small', spacing: 'Small',
                },
                {
                  type: 'FactSet',
                  spacing: 'Small',
                  facts: [
                    { title: 'Source', value: item.src || '—' },
                    { title: 'Date',   value: item.age || '—' },
                    ...(item.pill ? [{ title: 'Type', value: item.pill }] : []),
                  ],
                },
                ...(item.url ? [{
                  type: 'ActionSet',
                  actions: [{ type: 'Action.OpenUrl', title: '↗ Read Article', url: item.url }],
                }] : []),
              ],
            })),
            ...(items.length > 5 ? [{
              type: 'TextBlock',
              text: `+ ${items.length - 5} more in this section`,
              isSubtle: true, size: 'Small', horizontalAlignment: 'Center', spacing: 'Medium',
            }] : []),
          ],
        },
      }],
    };

    try {
      const r = await fetch(TEAMS_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
      if (!r.ok) console.error(`Teams [${sectionId}] HTTP`, r.status);
      else console.log(`✅ Teams notified: ${meta.name} (${items.length} articles)`);
    } catch (e) {
      console.error(`Teams [${sectionId}] error:`, e.message);
    }
    // Small delay between messages to respect Teams rate limits
    await new Promise(r => setTimeout(r, 1200));
  }
}

// ── Section refresh helper (used by HTTP route + daily scheduler) ─────────────

const SECTION_IDS = ['exec','themes','deals','risks','competitor','talent','policy','tech'];

async function refreshSection(section) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
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
    await Promise.all(items.map(async item => {
      if (!item.img || !item.img.startsWith('https://')) {
        item.img = await fetchOgImage(item.url);
      }
    }));
    await saveNewsSection(section, items);
    return items;
  }
  throw new Error(JSON.stringify(mockRes.data || { error: 'unknown' }));
}

// ── 10 AM daily auto-refresh (server-side, no client needed) ──────────────────

async function dailyRefreshAll() {
  console.log('⏰ Daily refresh starting — all sections...');
  let total = 0;
  for (const section of SECTION_IDS) {
    try {
      const items = await refreshSection(section);
      total += items.length;
      console.log(`  ✅ ${section}: ${items.length} articles`);
      await new Promise(r => setTimeout(r, 2000)); // small gap between API calls
    } catch (e) {
      console.error(`  ❌ ${section}: ${e.message}`);
    }
  }
  console.log(`⏰ Daily refresh done — ${total} articles`);
  if (total > 0) {
    sendPushNotifications({
      title: 'GCC Intel',
      body: `Today's brief is ready — ${total} articles across ${SECTION_IDS.length} sections`,
      url: '/',
    }).catch(() => {});
  }
}

function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  const hh = Math.floor(delay / 3600000), mm = Math.floor((delay % 3600000) / 60000);
  console.log(`⏰ Next auto-refresh: ${next.toLocaleString('en-GB')} (in ${hh}h ${mm}m)`);
  setTimeout(async () => {
    await dailyRefreshAll();
    scheduleDailyRefresh(); // reschedule for next day
  }, delay);
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 40000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});
    const patterns = [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m?.[1]?.startsWith('http')) return m[1];
    }
  } catch {}
  return '';
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
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

    // ── Refresh (AI fetch) — only called by clearAndRefresh() ─────────────────
    if (pathname === '/api/refresh' && req.method === 'POST') {
      const { section } = JSON.parse(await body());
      if (!section) return json(400, { error: 'Missing section' });
      try {
        const items = await refreshSection(section);
        return json(200, { items });
      } catch (e) {
        return json(500, { error: e.message });
      }
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
      const date = parsed.searchParams.get('date') || todayStr();
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

    // ── VAPID public key (browser needs this to subscribe) ─────────────────
    if (pathname === '/api/vapidkey' && req.method === 'GET') {
      return json(200, { key: vapidPublicKey });
    }

    // ── Store push subscription ─────────────────────────────────────────────
    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const { subscription } = JSON.parse(await body());
      if (!subscription?.endpoint) return json(400, { error: 'Missing subscription' });
      await db.collection('push_subscriptions').updateOne(
        { 'subscription.endpoint': subscription.endpoint },
        { $set: { subscription, updated_at: new Date() } },
        { upsert: true }
      );
      console.log('✅ Push subscription saved');
      return json(200, { ok: true });
    }

    // ── Remove push subscription ────────────────────────────────────────────
    if (pathname === '/api/unsubscribe' && req.method === 'POST') {
      const { endpoint } = JSON.parse(await body());
      await db.collection('push_subscriptions').deleteOne({ 'subscription.endpoint': endpoint });
      return json(200, { ok: true });
    }

    // ── Send push notification to all subscribers ───────────────────────────
    if (pathname === '/api/push-notify' && req.method === 'POST') {
      const payload = JSON.parse(await body());
      await sendPushNotifications(payload);
      return json(200, { ok: true });
    }

    // ── Teams notify (called by frontend after full refresh) ────────────────
    if (pathname === '/api/teams-notify' && req.method === 'POST') {
      const payload = JSON.parse(await body());
      // Accept {sections:{exec:[...], themes:[...]}} — one card per section
      // Legacy fallback: {items:[...]} groups everything under 'exec'
      const sections = payload.sections || (payload.items ? { exec: payload.items } : {});
      await notifyTeams(sections);
      return json(200, { ok: true });
    }

    // ── On-demand og:image fetch (client calls this for articles with no image) ──
    if (pathname === '/api/getimage' && req.method === 'GET') {
      const artUrl = parsed.searchParams.get('url');
      if (!artUrl || !artUrl.startsWith('http')) return json(400, { img: '' });
      const img = await fetchOgImage(artUrl);
      return json(200, { img });
    }

    // ── Image proxy (bypasses hotlink protection on news sites) ───────────────
    if (pathname === '/api/imgproxy' && req.method === 'GET') {
      const imgUrl = parsed.searchParams.get('url');
      if (!imgUrl || !imgUrl.startsWith('https://')) {
        res.writeHead(400); return res.end();
      }
      try {
        // ref = the article page's origin (e.g. economictimes.indiatimes.com)
        // so the CDN thinks the request is coming from the news site itself
        const rawRef = parsed.searchParams.get('ref');
        const referer = rawRef ? decodeURIComponent(rawRef) + '/' : 'https://www.google.com/';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(imgUrl, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': referer,
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        clearTimeout(timer);
        if (!r.ok) { res.writeHead(404); return res.end(); }
        const ct = r.headers.get('content-type') || 'image/jpeg';
        if (!ct.startsWith('image/')) { res.writeHead(404); return res.end(); }
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(buf);
      } catch {
        if (!res.headersSent) { res.writeHead(404); res.end(); }
      }
      return;
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
    console.log('   Model: claude-haiku-4-5 | Data: Web search → Claude analysis');
    console.log('   Push notifications:', vapidPublicKey ? 'enabled' : 'disabled');
    scheduleDailyRefresh();
  });
}).catch(err => {
  console.error('❌ MongoDB connect failed:', err.message);
  process.exit(1);
});
