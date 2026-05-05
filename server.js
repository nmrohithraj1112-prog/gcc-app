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
let _refreshAllInProgress = false;

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
    try { await webPush.sendNotification(sub.subscription, data); }
    catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404)
        await db.collection('push_subscriptions').deleteOne({ _id: sub._id });
    }
  }));
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function todayStr() { return new Date().toISOString().split('T')[0]; }

function weekBounds() {
  const now = new Date(), day = now.getDay();
  const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(mon), end: fmt(fri) };
}

async function saveNewsSection(section, items) {
  const date = todayStr();
  await Promise.all([
    db.collection('news_cache').updateOne(
      { section }, { $set: { section, items, updated_at: new Date() } }, { upsert: true }
    ),
    db.collection('news_history').updateOne(
      { date, section }, { $set: { date, section, items, updated_at: new Date() } }, { upsert: true }
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

// ── Robust JSON extractor ─────────────────────────────────────────────────────

function extractItems(raw) {
  if (!raw || !raw.trim()) return null;

  // Strip markdown fences
  let text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '');

  // Strategy 1: bracket-count from {"items"
  for (const pat of ['{"items"', '{ "items"']) {
    const start = text.indexOf(pat);
    if (start === -1) continue;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const p = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(p.items) && p.items.length > 0) return p.items;
      } catch {}
    }
  }

  // Strategy 2: find outermost [...] array
  const arrStart = text.indexOf('[');
  if (arrStart !== -1) {
    let depth = 0, end = -1;
    for (let i = arrStart; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const arr = JSON.parse(text.slice(arrStart, end + 1));
        if (Array.isArray(arr) && arr.length > 0 && arr[0].title) return arr;
      } catch {}
    }
  }

  // Strategy 3: greedy last-resort
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (Array.isArray(p.items) && p.items.length > 0) return p.items;
    } catch {}
  }

  return null;
}

// ── Section config & prompts ──────────────────────────────────────────────────

const SECTION_CONFIG = {
  exec: {
    name: 'Executive Snapshot', n: 5, riskMode: false,
    focus: 'the most impactful news for Global Capability Center (GCC) leaders this week — a major GCC industry announcement, new GCC setup by a Fortune 500 company in India, NASSCOM GCC report, or a strategic shift in the India technology ecosystem',
    search: '"Global Capability Center" OR "GCC India" announcement 2026',
    alt: 'NASSCOM GCC India technology hub Fortune 500 India expansion 2026',
  },
  themes: {
    name: 'Strategic Themes', n: 5, riskMode: false,
    focus: 'the most significant AI or technology trend reshaping how Global Capability Centers operate — GenAI adoption, agentic AI, automation, platform modernisation, or new operating models GCC leaders are piloting in India',
    search: 'GenAI AI adoption Global Capability Center India technology 2026',
    alt: 'agentic AI automation GCC India operations transformation 2026',
  },
  competitor: {
    name: 'Market Moves', n: 5, riskMode: false,
    focus: 'a major move by a hyperscaler or global tech vendor — Microsoft, Google Cloud, AWS, Oracle, SAP — launching a new India cloud region, AI service, or strategic programme for Global Capability Centers',
    search: 'Microsoft Google AWS Oracle India cloud AI GCC enterprise 2026',
    alt: 'hyperscaler technology vendor India GCC programme announcement 2026',
  },
  talent: {
    name: 'Talent Signals', n: 5, riskMode: false,
    focus: 'the most important hiring trend, salary benchmark, or workforce shift for Global Capability Centers in India — AI/ML talent demand, GCC attrition data, salary benchmarks, or upskilling programmes',
    search: 'India tech talent GCC hiring salary AI ML workforce 2026',
    alt: 'NASSCOM India IT salary benchmark GCC attrition hiring 2026',
  },
  policy: {
    name: 'Policy & Regulation', n: 5, riskMode: false,
    focus: 'the most actionable government regulation or policy change affecting Global Capability Centers in India — India DPDPA, SEZ/IT park policy, US H-1B visa changes, India budget IT incentives, or cross-border data regulations',
    search: 'India DPDPA data protection SEZ IT regulation GCC policy 2026',
    alt: 'US H-1B visa India IT policy GCC compliance 2026',
  },
  tech: {
    name: 'Technology Signals', n: 5, riskMode: false,
    focus: 'a concrete AI platform, tool, or capability that Global Capability Centers in India are adopting — GitHub Copilot enterprise, GenAI coding tools, cloud AI services, or enterprise software with embedded AI',
    search: 'AI platform tool enterprise India GCC GenAI productivity 2026',
    alt: 'GitHub Copilot enterprise AI coding tool cloud platform India GCC 2026',
  },
  deals: {
    name: 'Deals & Capital', n: 5, riskMode: false,
    focus: 'the most significant deal in the Global Capability Center ecosystem — a new GCC by a Fortune 500 company in India, major expansion, PE investment in India tech services, or acquisition of an India tech firm',
    search: '"Global Capability Center" India new setup expansion investment 2026',
    alt: 'Fortune 500 GCC India Bangalore Hyderabad Pune Chennai investment deal 2026',
  },
  risks: {
    name: 'Risks & Opportunities', n: 6, riskMode: true,
    focus: 'risks facing Global Capability Centers (AI job displacement, US visa restrictions, DPDPA compliance, cybersecurity) AND opportunities (new GCC sectors, India government incentives, AI competitive advantage)',
    search: '"Global Capability Center" India risk opportunity AI regulation 2026',
    alt: 'GCC India H-1B offshoring AI automation risk opportunity 2026',
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const yr = new Date().getFullYear().toString();
  const search = cfg.search.replace(/20\d\d/g, yr);
  const alt    = cfg.alt.replace(/20\d\d/g, yr);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const windowStart = sevenDaysAgo.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const countNote = cfg.riskMode
    ? `Return exactly ${cfg.n} items: exactly 3 with pill:"Risk", exactly 3 with pill:"Opp". Each must cite a DIFFERENT news story.`
    : `Return exactly ${cfg.n} items from DIFFERENT real articles. Run multiple searches if needed.`;

  const pillField = cfg.riskMode ? ',"pill":"Risk or Opp"' : '';

  return `You are an intelligence analyst for the Global Capability Center (GCC) industry — offshore technology operations of multinational companies, primarily in India. Today is ${today}.

NOTE: "GCC" = Global Capability Center, NOT Gulf Cooperation Council.

Search steps:
1. Search: "${search}"
2. If insufficient, search: "${alt}"
3. If still insufficient, try broader queries

Topic: ${cfg.focus}

Date range: ${windowStart} to ${today} only. Do NOT use older articles.
Preferred sources: NASSCOM.in, Economic Times, Mint, Business Standard, Reuters, Bloomberg, TechCrunch, YourStory, Inc42.

${countNote}

CRITICAL: Your ENTIRE response must be ONLY the JSON below. Do NOT write any text before or after it. Start with { immediately:

{"items":[{"tag":"${cfg.name} · DATE","age":"D Mon YYYY","title":"headline max 15 words","body":"2-3 sentences with real facts and company names","why":"<strong>Strategic Implication:</strong> 1-2 sentences for GCC leaders","src":"Publication Name","url":"https://real-url-from-search"${pillField}}]}

NEVER add explanation, preamble, or any text outside the JSON object.`;
}

// ── Anthropic API call with retry ─────────────────────────────────────────────

async function callAnthropicWithRetry(section, maxRetries = 3) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const prompt = buildPrompt(section, today);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (netErr) {
      console.error(`  🌐 [${section}] network error:`, netErr.message);
      if (attempt < maxRetries) { await sleep(5000); continue; }
      throw netErr;
    }

    if (apiRes.status === 429) {
      const retryAfter = parseInt(apiRes.headers.get('retry-after') || '30', 10);
      console.log(`  ⏳ [${section}] 429 — waiting ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
      if (attempt < maxRetries) { await sleep((retryAfter + 5) * 1000); continue; }
      throw new Error('Rate limited after max retries');
    }

    if (!apiRes.ok) {
      const err = await apiRes.text();
      // Don't retry on auth errors
      if (apiRes.status === 401 || apiRes.status === 403) throw new Error(`Auth error ${apiRes.status}`);
      console.warn(`  ⚠️  [${section}] API ${apiRes.status} (attempt ${attempt})`);
      if (attempt < maxRetries) { await sleep(8000); continue; }
      throw new Error(`Anthropic API ${apiRes.status}: ${err.slice(0, 200)}`);
    }

    const data = await apiRes.json();
    const allText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    console.log(`  📄 [${section}] text: ${allText.length} chars, stop: ${data.stop_reason}`);

    const items = extractItems(allText);
    if (items && items.length > 0) {
      console.log(`  ✅ [${section}] extracted ${items.length} items`);
      return items;
    }

    console.warn(`  ⚠️  [${section}] no valid JSON. Preview:\n`, allText.slice(0, 300));
    if (attempt < maxRetries) { await sleep(6000); }
  }

  throw new Error(`No valid JSON after ${maxRetries} attempts`);
}

// ── Refresh a single section ──────────────────────────────────────────────────

async function refreshSection(section) {
  const items = await callAnthropicWithRetry(section);
  await saveNewsSection(section, items);
  return items;
}

// ── Refresh ALL sections sequentially with SSE progress ──────────────────────

const SECTION_IDS = ['exec', 'themes', 'deals', 'risks', 'competitor', 'talent', 'policy', 'tech'];
const SECTION_GAP_MS = 8000; // 8 s between calls to avoid 429

async function refreshAllSequential(onProgress) {
  if (_refreshAllInProgress) {
    onProgress({ type: 'error', message: 'Refresh already in progress — please wait' });
    return;
  }
  _refreshAllInProgress = true;
  let succeeded = 0, failed = 0;

  try {
    for (let i = 0; i < SECTION_IDS.length; i++) {
      const section = SECTION_IDS[i];
      onProgress({ type: 'start', section, index: i, total: SECTION_IDS.length });
      try {
        const items = await refreshSection(section);
        succeeded++;
        onProgress({ type: 'done', section, count: items.length, items });
      } catch (e) {
        failed++;
        console.error(`  ❌ [${section}]: ${e.message}`);
        onProgress({ type: 'fail', section, error: e.message });
      }
      if (i < SECTION_IDS.length - 1) {
        onProgress({ type: 'wait', ms: SECTION_GAP_MS, next: SECTION_IDS[i + 1] });
        await sleep(SECTION_GAP_MS);
      }
    }
  } finally {
    _refreshAllInProgress = false;
  }

  onProgress({ type: 'complete', succeeded, failed });
  if (succeeded > 0) {
    sendPushNotifications({ title: 'GCC Intel', body: `Brief refreshed — ${succeeded} sections updated`, url: '/' }).catch(() => {});
  }
}

// ── Teams Webhook ─────────────────────────────────────────────────────────────

const SECTION_META = {
  exec: { name: 'Executive Snapshot', color: 'Accent', emoji: '📊' },
  themes: { name: 'Strategic Themes', color: 'Accent', emoji: '🔮' },
  deals: { name: 'Deals & Capital', color: 'Good', emoji: '🤝' },
  risks: { name: 'Risks & Opportunities', color: 'Attention', emoji: '⚠️' },
  competitor: { name: 'Market Moves', color: 'Warning', emoji: '⚡' },
  talent: { name: 'Talent Signals', color: 'Good', emoji: '👥' },
  policy: { name: 'Policy & Regulation', color: 'Warning', emoji: '⚖️' },
  tech: { name: 'Technology Signals', color: 'Accent', emoji: '💡' },
};

async function notifyTeams(sections) {
  if (!TEAMS_WEBHOOK) return;
  const ts = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  for (const sectionId of SECTION_IDS) {
    const items = sections[sectionId]; if (!items?.length) continue;
    const meta = SECTION_META[sectionId] || { name: sectionId, color: 'Default', emoji: '📰' };
    const card = {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
        type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5',
        body: [
          { type: 'TextBlock', text: `${meta.emoji} GCC Intel · ${meta.name}`, weight: 'Bolder', size: 'Large', color: meta.color, wrap: true },
          { type: 'TextBlock', text: `${items.length} articles · ${ts}`, isSubtle: true, size: 'Small', spacing: 'None' },
          ...items.slice(0, 5).map((item, idx) => ({
            type: 'Container', separator: true, spacing: idx === 0 ? 'Medium' : 'Default',
            items: [
              { type: 'TextBlock', text: item.title, weight: 'Bolder', wrap: true, size: 'Medium' },
              { type: 'TextBlock', text: (item.body||'').replace(/<[^>]+>/g,'').slice(0,180)+'…', wrap:true, isSubtle:true, size:'Small', spacing:'Small' },
              { type: 'FactSet', spacing: 'Small', facts: [{ title: 'Source', value: item.src||'—' }, { title: 'Date', value: item.age||'—' }] },
              ...(item.url ? [{ type:'ActionSet', actions:[{ type:'Action.OpenUrl', title:'↗ Read', url:item.url }] }] : []),
            ],
          })),
        ],
      }}],
    };
    try {
      const r = await fetch(TEAMS_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(card) });
      if (!r.ok) console.error(`Teams [${sectionId}] HTTP`, r.status);
    } catch (e) { console.error(`Teams [${sectionId}]:`, e.message); }
    await sleep(1200);
  }
}

// ── Daily scheduler ───────────────────────────────────────────────────────────

async function dailyRefreshAll() {
  console.log('⏰ Daily auto-refresh starting...');
  await refreshAllSequential(ev => console.log('  daily:', JSON.stringify(ev)));
}

function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  const hh = Math.floor(delay / 3600000), mm = Math.floor((delay % 3600000) / 60000);
  console.log(`⏰ Next auto-refresh: ${next.toLocaleString('en-GB')} (in ${hh}h ${mm}m)`);
  setTimeout(async () => { await dailyRefreshAll(); scheduleDailyRefresh(); }, delay);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const jsonRes = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const body = () => new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });

  try {

    // ── /api/refresh-all — SSE stream of sequential refresh ───────────────────
    if (pathname === '/api/refresh-all' && req.method === 'POST') {
      let doClear = false;
      try { const b = JSON.parse(await body()); doClear = !!b.clear; } catch {}

      if (doClear) {
        await Promise.all([
          db.collection('news_cache').deleteMany({}),
          db.collection('news_history').deleteMany({}),
          db.collection('settings').deleteMany({}),
        ]);
        console.log('🗑️  Data cleared');
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

      refreshAllSequential(send)
        .then(() => { try { res.end(); } catch {} })
        .catch(e => { send({ type: 'error', message: e.message }); try { res.end(); } catch {}; });

      return;
    }

    // ── /api/refresh — single section (backward compat) ───────────────────────
    if (pathname === '/api/refresh' && req.method === 'POST') {
      let payload;
      try { payload = JSON.parse(await body()); } catch { return jsonRes(400, { error: 'Invalid JSON' }); }
      const { section } = payload;
      if (!section) return jsonRes(400, { error: 'Missing section' });
      try {
        const items = await refreshSection(section);
        return jsonRes(200, { items });
      } catch (e) {
        console.error(`❌ /api/refresh [${section}]:`, e.message);
        return jsonRes(500, { error: e.message });
      }
    }

    if (pathname === '/api/data' && req.method === 'GET') return jsonRes(200, await getAllNews());

    if (pathname === '/api/refresh-status' && req.method === 'GET') return jsonRes(200, { inProgress: _refreshAllInProgress });

    if (pathname === '/api/save' && req.method === 'POST') {
      const { title, item, action } = JSON.parse(await body());
      if (action === 'unsave') { await db.collection('saved_items').deleteOne({ title }); }
      else { const { _id, ...clean } = item; await db.collection('saved_items').updateOne({ title }, { $set: { ...clean, saved_at: new Date() } }, { upsert: true }); }
      return jsonRes(200, { ok: true });
    }

    if (pathname === '/api/saved' && req.method === 'GET') {
      const items = await db.collection('saved_items').find({}).sort({ saved_at: -1 }).toArray();
      items.forEach(i => delete i._id);
      return jsonRes(200, items);
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      const docs = await db.collection('settings').find({}).toArray();
      const s = {}; docs.forEach(d => { s[d.key] = d.value; });
      return jsonRes(200, s);
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const date = parsed.searchParams.get('date') || todayStr();
      const docs = await db.collection('news_history').find({ date }).toArray();
      const sections = {}; docs.forEach(d => { sections[d.section] = d.items; });
      return jsonRes(200, { date, sections });
    }

    if (pathname === '/api/weekly' && req.method === 'GET') {
      const { start, end } = weekBounds();
      const docs = await db.collection('news_history').find({ date: { $gte: start, $lte: end } }).sort({ date:1, section:1 }).toArray();
      const byDay = {};
      docs.forEach(d => { if (!byDay[d.date]) byDay[d.date] = {}; byDay[d.date][d.section] = d.items; });
      return jsonRes(200, { start, end, days: Object.entries(byDay).map(([date, sections]) => ({ date, sections })) });
    }

    if (pathname === '/api/cleardata' && req.method === 'POST') {
      await Promise.all([
        db.collection('news_cache').deleteMany({}),
        db.collection('news_history').deleteMany({}),
        db.collection('settings').deleteMany({}),
      ]);
      console.log('🗑️  All data cleared');
      return jsonRes(200, { ok: true });
    }

    if (pathname === '/api/vapidkey' && req.method === 'GET') return jsonRes(200, { key: vapidPublicKey });

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const { subscription } = JSON.parse(await body());
      if (!subscription?.endpoint) return jsonRes(400, { error: 'Missing subscription' });
      await db.collection('push_subscriptions').updateOne(
        { 'subscription.endpoint': subscription.endpoint }, { $set: { subscription, updated_at: new Date() } }, { upsert: true }
      );
      return jsonRes(200, { ok: true });
    }

    if (pathname === '/api/unsubscribe' && req.method === 'POST') {
      const { endpoint } = JSON.parse(await body());
      await db.collection('push_subscriptions').deleteOne({ 'subscription.endpoint': endpoint });
      return jsonRes(200, { ok: true });
    }

    if (pathname === '/api/push-notify' && req.method === 'POST') {
      const payload = JSON.parse(await body());
      await sendPushNotifications(payload);
      return jsonRes(200, { ok: true });
    }

    if (pathname === '/api/teams-notify' && req.method === 'POST') {
      const payload = JSON.parse(await body());
      const sections = payload.sections || (payload.items ? { exec: payload.items } : {});
      await notifyTeams(sections);
      return jsonRes(200, { ok: true });
    }

    // Static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); return res.end('Not Found'); }
      const ext = path.extname(filePath);
      const ct = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'}[ext]||'text/plain';
      res.writeHead(200, {'Content-Type': ct}); res.end(data);
    });

  } catch (e) {
    console.error('Unhandled:', e);
    jsonRes(500, { error: e.message });
  }
});

connectMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ GCC Intel running at http://localhost:${PORT}`);
    scheduleDailyRefresh();
  });
}).catch(err => { console.error('❌ MongoDB failed:', err.message); process.exit(1); });