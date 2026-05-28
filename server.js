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
  // Priority 1: env vars (required for stateless deploys like Render)
  const envPub  = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;

  if (envPub && envPriv) {
    vapidPublicKey = envPub;
    webPush.setVapidDetails('mailto:gccintel@app.local', envPub, envPriv);
    console.log('✅ Web Push ready (VAPID from env)');
    return;
  }

  // Priority 2: stored in MongoDB (single-instance setups)
  let doc = await db.collection('config').findOne({ key: 'vapid' });
  if (!doc) {
    const keys = webPush.generateVAPIDKeys();
    doc = { key: 'vapid', publicKey: keys.publicKey, privateKey: keys.privateKey };
    await db.collection('config').insertOne(doc);
    console.log('⚠️  Generated new VAPID keys — existing push subscriptions will break.');
    console.log('   Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your env to avoid this.');
    console.log('   Public:', doc.publicKey);
    console.log('   Private:', doc.privateKey);
  }
  vapidPublicKey = doc.publicKey;
  webPush.setVapidDetails('mailto:gccintel@app.local', doc.publicKey, doc.privateKey);
  console.log('✅ Web Push ready (VAPID from MongoDB)');
}

// Send a push payload to all subscribers, removing expired ones
async function sendPushNotifications(payload) {
  const subs = await db.collection('push_subscriptions').find({}).toArray();
  if (!subs.length) return 0;
  const data = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async sub => {
    try { await webPush.sendNotification(sub.subscription, data); sent++; }
    catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404 || e.statusCode === 403) {
        await db.collection('push_subscriptions').deleteOne({ _id: sub._id });
        console.log('Removed stale push subscription (HTTP ' + e.statusCode + ')');
      } else {
        console.error('Push error:', e.statusCode, e.message?.slice(0, 80));
      }
    }
  }));
  return sent;
}

// Send one push per section (shows grouped in notification tray by category)
async function sendSectionPush(section, items) {
  if (!items || !items.length) return;
  const headline = items[0]?.title || 'New intelligence available.';
  await sendPushNotifications({ mode: 'section', section, headline, url: '/?section=' + section });
}

// Send a summary push after full refresh
async function sendSummaryPush(succeededSections, totalArticles) {
  await sendPushNotifications({ mode: 'summary', sections: succeededSections, count: totalArticles, url: '/' });
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
    name: 'Executive Snapshot', riskMode: false,
    focus: 'the most impactful news for Global Capability Center (GCC) leaders — major GCC industry announcements, new GCC setups by Fortune 500 companies in India, NASSCOM GCC reports, or strategic shifts in the India technology ecosystem',
    queries: [
      '"Global Capability Center" OR "GCC India" announcement 2026',
      'NASSCOM GCC India technology hub Fortune 500 India expansion 2026',
      'GCC India Bangalore Hyderabad Pune Chennai setup launch 2026',
    ],
  },
  themes: {
    name: 'Strategic Themes', riskMode: false,
    focus: 'significant AI or technology trends reshaping how Global Capability Centers operate — GenAI adoption, agentic AI, automation, platform modernisation, or new operating models GCC leaders are piloting in India',
    queries: [
      'GenAI AI adoption Global Capability Center India technology 2026',
      'agentic AI automation GCC India operations transformation 2026',
      'AI strategy India enterprise GCC digital transformation 2026',
    ],
  },
  competitor: {
    name: 'Market Moves', riskMode: false,
    focus: 'major moves by hyperscalers or global tech vendors — Microsoft, Google Cloud, AWS, Oracle, SAP, Salesforce — in India: new cloud regions, AI services, partnerships, or strategic programmes for Global Capability Centers or India enterprise market',
    queries: [
      'Microsoft Google AWS Oracle India cloud AI announcement 2026',
      'hyperscaler technology vendor India GCC enterprise partnership 2026',
      'SAP Salesforce ServiceNow India launch programme GCC 2026',
      'Microsoft Azure Google Cloud AWS India region expansion 2026',
    ],
  },
  talent: {
    name: 'Talent Signals', riskMode: false,
    focus: 'hiring trends, salary benchmarks, or workforce shifts for Global Capability Centers in India — AI/ML talent demand, GCC attrition data, salary benchmarks for senior engineers or AI specialists, or upskilling programmes',
    queries: [
      'India tech talent GCC hiring salary AI ML workforce 2026',
      'NASSCOM India IT salary benchmark GCC attrition hiring 2026',
      'India engineer AI ML jobs GCC workforce upskilling 2026',
    ],
  },
  policy: {
    name: 'Policy & Regulation', riskMode: false,
    focus: 'actionable government regulations or policy changes affecting Global Capability Centers in India — India DPDPA data protection rules, SEZ/IT park policy, US H-1B visa changes, India budget IT incentives, or cross-border data transfer regulations',
    queries: [
      'India DPDPA data protection SEZ IT regulation GCC policy 2026',
      'US H-1B visa India IT offshoring policy compliance 2026',
      'India IT policy regulation budget incentive technology 2026',
    ],
  },
  tech: {
    name: 'Technology Signals', riskMode: false,
    focus: 'AI platforms, tools, or capabilities that Global Capability Centers in India are adopting — GitHub Copilot enterprise rollout, GenAI coding tools, cloud AI services, or enterprise software with embedded AI that changes GCC productivity',
    queries: [
      'AI platform tool enterprise India GCC GenAI productivity 2026',
      'GitHub Copilot enterprise AI coding tool India GCC 2026',
      'AI developer tools enterprise India technology adoption 2026',
    ],
  },
  deals: {
    name: 'Deals & Capital', riskMode: false,
    focus: 'significant deals in the Global Capability Center ecosystem — new GCCs established by Fortune 500 companies in India, major GCC expansions, PE/VC investment in India tech services, or acquisitions of India-based tech firms',
    queries: [
      '"Global Capability Center" India setup expansion investment 2026',
      'Fortune 500 GCC India Bangalore Hyderabad Pune Chennai investment 2026',
      'India tech services PE investment acquisition deal 2026',
      'GCC India new launch expansion funding announcement 2026',
      'India IT company acquisition merger investment capital 2026',
    ],
  },
  risks: {
    name: 'Risks & Opportunities', riskMode: true,
    focus: 'risks facing Global Capability Centers (AI job displacement, US visa/offshoring restrictions, DPDPA compliance burden, cybersecurity threats) AND opportunities (new GCC sectors like semiconductors or healthcare, India government GCC incentives, AI competitive advantage)',
    queries: [
      '"Global Capability Center" India risk opportunity regulation 2026',
      'GCC India H-1B offshoring AI automation risk opportunity 2026',
      'India IT risk cybersecurity regulation AI disruption GCC 2026',
    ],
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const yr = new Date().getFullYear().toString();
  const queries = cfg.queries.map(q => q.replace(/20\d\d/g, yr));

  // 14-day window — wide enough for slow-moving categories like deals
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const windowStart = cutoff.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const pillField = cfg.riskMode ? ',"pill":"Risk or Opp"' : '';

  const countInstruction = cfg.riskMode
    ? `You must return between 2 and 6 items total. At least 1 must have pill:"Risk" and at least 1 must have pill:"Opp". Aim for a mix of risks and opportunities.`
    : `Return between 2 and 5 items. Quality over quantity — only include articles you actually found. Do NOT pad with invented articles.`;

  const searchInstructions = queries.map((q, i) => `${i + 1}. "${q}"`).join('\n');

  return `You are an intelligence analyst for the Global Capability Center (GCC) industry — offshore technology operations of multinational companies, primarily in India. Today is ${today}.

IMPORTANT: "GCC" = Global Capability Center (NOT Gulf Cooperation Council). Focus on India-based GCC ecosystem.

Run these web searches in order until you have enough articles:
${searchInstructions}

Topic: ${cfg.focus}

PREFERRED date range: ${windowStart} to ${today}. Use the most recent articles you can find.
If you cannot find articles within this window, use the most recent relevant articles available — do NOT explain or apologise, just return the JSON with what you found.

Preferred sources: Times of India, Economic Times, Mint, Business Standard, NASSCOM.in, Reuters, Bloomberg, TechCrunch, YourStory, Inc42, LiveMint, MoneyControl.

${countInstruction}

═══════════════════════════════════════════════
OUTPUT RULE — THIS IS ABSOLUTE:
Your response must contain ONLY the JSON object below.
NO text before the opening {
NO text after the closing }
NO explanation of what you found or didn't find
NO apology if results are limited
If you only found 2 articles, return 2. Never return 0.
═══════════════════════════════════════════════

{"items":[{"tag":"${cfg.name} · DATE","age":"D Mon YYYY","title":"headline max 15 words","body":"2-3 sentences with real facts, company names, and numbers","why":"<strong>Strategic Implication:</strong> 1-2 sentences for GCC leaders","src":"Publication Name","url":"https://actual-url-from-search"${pillField}}]}`;
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
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
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
        // Send per-section push notification immediately after each section loads
        sendSectionPush(section, items).catch(e => console.error(`Push [${section}]:`, e.message));
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
    // After all sections done, send one summary push
    sendSummaryPush(SECTION_IDS.slice(0, succeeded), succeeded * 5).catch(() => {});
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

    if (pathname === '/api/data' && req.method === 'GET') return jsonRes(200, await getAllNews());

    if (pathname === '/api/refresh-status' && req.method === 'GET') return jsonRes(200, { inProgress: _refreshAllInProgress });

    if (pathname === '/api/refresh-stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
      refreshAllSequential(send)
        .catch(e => send({ type: 'error', message: e.message }))
        .finally(() => { try { res.end(); } catch {} });
      req.on('close', () => {});
      return;
    }

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

    if (pathname === '/api/weekly-agg' && req.method === 'GET') {
      const { start, end } = weekBounds();
      const docs = await db.collection('news_history')
        .find({ date: { $gte: start, $lte: end } })
        .sort({ date: -1, section: 1 })
        .toArray();
      const sections = {};
      const seenTitles = {};
      docs.forEach(d => {
        if (!sections[d.section]) { sections[d.section] = []; seenTitles[d.section] = new Set(); }
        (d.items || []).forEach(item => {
          if (item.title && !seenTitles[d.section].has(item.title)) {
            seenTitles[d.section].add(item.title);
            sections[d.section].push(item);
          }
        });
      });
      return jsonRes(200, { start, end, sections });
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

    // Helper: returns BOTH keys so you can copy them into env vars (remove in production)
    if (pathname === '/api/vapid-keys' && req.method === 'GET') {
      const doc = await db.collection('config').findOne({ key: 'vapid' });
      return jsonRes(200, { publicKey: vapidPublicKey, privateKey: doc?.privateKey || '(set VAPID_PRIVATE_KEY env var)' });
    }

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

    if (pathname === '/api/clear-subscriptions' && req.method === 'POST') {
      const result = await db.collection('push_subscriptions').deleteMany({});
      console.log(`🗑️  Cleared ${result.deletedCount} push subscriptions`);
      return jsonRes(200, { ok: true, deleted: result.deletedCount });
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
      const ct = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'}[ext]||'text/plain';
      res.writeHead(200, {'Content-Type': ct}); res.end(data);
    });

  } catch (e) {
    console.error('Unhandled:', e);
    jsonRes(500, { error: e.message });
  }
});

// On every server start (triggered by Render redeploy after Claude routine pushes news.json),
// ingest the file into MongoDB and send push notifications if it's newer than what we last saw.
async function ingestNewsJson() {
  const filePath = path.join(__dirname, 'news.json');
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; } // file missing — skip

  let data;
  try { data = JSON.parse(raw); } catch (e) { console.error('❌ news.json parse error:', e.message); return; }

  const { generated_at, sections } = data;
  if (!generated_at || !sections) return;

  // Check if this is newer than what we last ingested
  const stored = await db.collection('settings').findOne({ key: 'last_refresh' });
  if (stored?.value && new Date(stored.value) >= new Date(generated_at)) {
    console.log('ℹ️  news.json already ingested — skipping.');
    return;
  }

  console.log(`📥 Ingesting news.json (generated ${generated_at})…`);
  const sectionOrder = ['exec','themes','competitor','talent','policy','tech','deals','risks'];
  let totalArticles = 0;
  const succeededSections = [];

  for (const section of sectionOrder) {
    const items = sections[section];
    if (!Array.isArray(items) || !items.length) continue;
    await saveNewsSection(section, items);
    totalArticles += items.length;
    succeededSections.push(section);
  }

  // Update last_refresh to the file's timestamp
  await db.collection('settings').updateOne(
    { key: 'last_refresh' },
    { $set: { key: 'last_refresh', value: generated_at } },
    { upsert: true }
  );

  console.log(`✅ Ingested ${totalArticles} articles across ${succeededSections.length} sections.`);

  // Only notify for today's news (IST) — skip if the routine produced yesterday's or older content
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  const generatedDateIST = new Date(generated_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (generatedDateIST !== todayIST) {
    console.log(`ℹ️  news.json is from ${generatedDateIST}, today is ${todayIST} — skipping push notifications.`);
    return;
  }

  // Count only today's articles for the notification
  const todayAgeStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  let todayCount = 0;
  for (const sec of succeededSections) {
    (sections[sec] || []).forEach(item => { if (item.age === todayAgeStr) todayCount++; });
  }
  const notifyCount = todayCount || totalArticles; // fall back to total if date formats differ

  try {
    await sendSummaryPush(succeededSections, notifyCount);
    console.log(`🔔 Push notifications sent (${notifyCount} today's articles).`);
  } catch (e) {
    console.error('Push notification error:', e.message);
  }
}

connectMongo().then(async () => {
  await ingestNewsJson();
  server.listen(PORT, () => {
    console.log(`✅ GCC Intel running at http://localhost:${PORT}`);
    console.log('ℹ️  Daily news is refreshed automatically by the Claude Code routine (11 AM IST).');
  });
}).catch(err => { console.error('❌ MongoDB failed:', err.message); process.exit(1); });