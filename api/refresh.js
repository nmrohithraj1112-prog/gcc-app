// Fetches REAL articles from RSS feeds, then uses Claude to analyse & categorise them.
// Claude never invents news or URLs — it only annotates articles we provide.

const RSS_SOURCES = {
  ai_tech: [
    { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
    { url: 'https://venturebeat.com/feed/', name: 'VentureBeat' },
    { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
    { url: 'https://www.wired.com/feed/rss', name: 'Wired' },
    { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica' },
  ],
  business: [
    { url: 'https://feeds.reuters.com/reuters/technologyNews', name: 'Reuters Tech' },
    { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters Business' },
  ],
  gulf: [
    { url: 'https://www.arabianbusiness.com/rss/all', name: 'Arabian Business' },
    { url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/', name: 'The National' },
    { url: 'https://saudigazette.com.sa/feed/', name: 'Saudi Gazette' },
  ],
  india: [
    { url: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', name: 'ET Tech' },
    { url: 'https://www.livemint.com/rss/technology', name: 'Mint Tech' },
  ],
};

const SECTION_FEEDS = {
  exec:       ['ai_tech', 'business', 'gulf', 'india'],
  themes:     ['ai_tech', 'business', 'gulf'],
  competitor: ['ai_tech', 'gulf', 'business', 'india'],
  talent:     ['india', 'gulf', 'business'],
  policy:     ['gulf', 'business', 'india'],
  tech:       ['ai_tech', 'business'],
  deals:      ['gulf', 'business', 'ai_tech'],
  risks:      ['gulf', 'business', 'ai_tech', 'india'],
};

function parseXML(xml, feedName) {
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const blk = m[2];
    const pick = (tag) => {
      const t = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cd = blk.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>`));
      if (cd) return cd[1].trim();
      const nm = blk.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`));
      return nm ? nm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    };
    // Extract URL (RSS <link> text, Atom <link href>, or <guid>)
    let url = '';
    const hrefM = blk.match(/<link[^>]+href="([^"]+)"/);
    if (hrefM) url = hrefM[1];
    if (!url) {
      const linkText = pick('link');
      if (/^https?:\/\//.test(linkText)) url = linkText;
    }
    if (!url) {
      const guidM = blk.match(/<guid[^>]*>(https?:\/\/[^\s<]+)<\/guid>/);
      if (guidM) url = guidM[1];
    }
    url = url.trim().split(/\s/)[0];
    const title = pick('title')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '');
    if (!title || !url || !url.startsWith('http')) continue;
    const desc = (pick('description') || pick('summary') || pick('content'))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    out.push({
      title: title.slice(0, 200),
      url,
      desc,
      pubDate: pick('pubDate') || pick('published') || pick('updated') || '',
      src: feedName,
    });
  }
  return out;
}

async function gatherArticles(section) {
  const keys = SECTION_FEEDS[section] || ['ai_tech', 'business'];
  // Deduplicate feeds across groups
  const feedMap = new Map();
  for (const k of keys) {
    for (const f of (RSS_SOURCES[k] || [])) feedMap.set(f.url, f);
  }
  const feeds = [...feedMap.values()];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // last 48 h
  const seen = new Set();
  const articles = [];

  await Promise.allSettled(feeds.map(async ({ url, name }) => {
    try {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': 'GCCIntel/1.0 RSS reader', Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      });
      clearTimeout(tid);
      if (!r.ok) return;
      const xml = await r.text();
      for (const a of parseXML(xml, name)) {
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        const ts = a.pubDate ? new Date(a.pubDate).getTime() : Date.now();
        if (!isNaN(ts) && ts < cutoff) continue;
        articles.push(a);
      }
    } catch { /* skip failed feed */ }
  }));

  return articles
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, 30);
}

function buildPrompt(section, articles, today) {
  const CFG = {
    exec: {
      name: 'Executive Snapshot', n: 5,
      pills: 'High|Medium|Low', pcs: 'p-high|p-med|p-low',
      focus: 'the most important AI & Tech news relevant to GCC orgs today',
    },
    themes: {
      name: 'Key Look-outs', n: 4,
      pills: 'Accelerating|Emerging|Watch|Risk', pcs: 'p-high|p-new|p-watch|p-risk',
      focus: 'emerging strategic patterns in AI & Tech that GCC leaders must watch',
    },
    competitor: {
      name: 'Competitor Moves', n: 5,
      pills: 'Platform|Scale|Expansion|Partnership|Investment', pcs: 'p-platform|p-scale|p-expansion|p-new|p-watch',
      focus: 'moves by tech companies, GCC peers, or hyperscalers that affect competitive positioning',
    },
    talent: {
      name: 'Talent Signals', n: 5,
      pills: '↑ Surge|→ Stable|↓ Cool', pcs: 'p-high|p-new|p-low',
      focus: 'hiring trends, salary signals, and workforce changes in GCC & India AI/Tech',
    },
    policy: {
      name: 'Policy & Regulatory', n: 4,
      pills: 'Act Now|Monitor|Review|No Action', pcs: 'p-risk|p-watch|p-new|p-low',
      focus: 'policy or regulatory changes affecting GCC/Gulf/India tech organisations',
    },
    tech: {
      name: 'Tech & Innovation', n: 4,
      pills: 'High|Medium', pcs: 'p-high|p-watch',
      focus: 'platform or technology shifts that directly change how GCCs operate',
    },
    deals: {
      name: 'Deals & Partnerships', n: 4,
      pills: 'Partnership|Investment|JV|MoU|Acquisition', pcs: 'p-new|p-watch|p-new|p-new|p-risk',
      focus: 'deals, investments, and partnerships shaping the GCC AI/Tech ecosystem',
    },
    risks: {
      name: 'Risks & Opportunities', n: 6,
      pills: 'Risk (items 1-3) | Opp (items 4-6)', pcs: 'p-risk (items 1-3) | p-opp (items 4-6)',
      focus: 'top risks and top opportunities facing GCC AI & Tech orgs this week',
    },
  };

  const cfg = CFG[section] || CFG.exec;
  const riskNote = section === 'risks'
    ? 'Items 1-3 must have pill:"Risk" and pc:"p-risk". Items 4-6 must have pill:"Opp" and pc:"p-opp".'
    : '';

  const list = articles.length
    ? articles.map((a, i) =>
        `[${i + 1}] SRC: ${a.src} | DATE: ${a.pubDate}\nURL: ${a.url}\nHEADLINE: ${a.title}\nSUMMARY: ${a.desc}`
      ).join('\n---\n')
    : '[No RSS articles fetched — no items to return]';

  return `You are a GCC AI & Tech intelligence analyst. Today is ${today}.

REAL NEWS ARTICLES from RSS feeds (last 48 hours):
${list}

TASK: For the "${cfg.name}" section, pick the ${cfg.n} articles most relevant to ${cfg.focus}. ${riskNote}

STRICT RULES:
1. ONLY use articles from the numbered list — never invent or modify content
2. Use the EXACT URL shown — never guess or create URLs
3. If fewer than ${cfg.n} relevant articles exist, return only what is available
4. Do NOT include articles that have no relevance to AI, tech, enterprise, GCC, Gulf, or India

Return ONLY a raw JSON object (no markdown, no backticks):
{"items":[{"pill":"${cfg.pills}","pc":"${cfg.pcs}","tag":"Category · DD Mon","age":"article publication date","title":"headline ≤15 words (can paraphrase for clarity)","body":"4-6 sentences combining the article content with GCC strategic context","why":"<strong>Why it matters:</strong> 1-2 sentence implication for a GCC AI/Tech org","src":"source name from the article","url":"EXACT URL from the article list above"}]}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { section } = req.body;
  if (!section) return res.status(400).json({ error: 'Missing section' });

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Step 1 — gather real RSS articles
  const articles = await gatherArticles(section);

  // Step 2 — build grounded prompt
  const prompt = buildPrompt(section, articles, today);

  // Step 3 — call Claude (claude-sonnet-4-6: fast, accurate analysis)
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return res.status(500).json({ error: `Anthropic API ${apiRes.status}`, detail: err });
    }

    const data = await apiRes.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'No JSON in response', raw: text.slice(0, 400) });

    return res.status(200).json(JSON.parse(match[0]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
