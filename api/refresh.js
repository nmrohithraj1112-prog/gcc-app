// Claude searches the live internet for real, current news.
// Returns 1 article per section (2 for risks: 1 risk + 1 opportunity).

const SECTION_CONFIG = {
  exec: {
    name: 'Executive Snapshot',
    n: 2, riskMode: false,
    pill: 'High|Medium|Low', pc: 'p-high|p-med|p-low',
    focus: 'the single most impactful business news for GCC/Gulf AI & technology leaders this week — a major announcement, funding, or strategic move directly relevant to UAE or Saudi Arabia',
    search: 'UAE Saudi Arabia AI technology business news 2025 site:arabianbusiness.com OR site:thenationalnews.com OR site:zawya.com OR site:reuters.com',
  },
  themes: {
    name: 'Strategic Themes',
    n: 2, riskMode: false,
    pill: 'Accelerating|Emerging|Watch', pc: 'p-high|p-new|p-watch',
    focus: 'the most significant emerging AI or enterprise technology trend that GCC organisations must track — agentic AI, LLMs, automation, or digital transformation in Gulf markets',
    search: 'agentic AI enterprise trend Gulf UAE 2025 digital transformation technology',
  },
  competitor: {
    name: 'Market Moves',
    n: 2, riskMode: false,
    pill: 'Platform|Scale|Expansion|Partnership', pc: 'p-platform|p-scale|p-expansion|p-new',
    focus: 'a major competitive move — a hyperscaler (Microsoft, Google, Amazon, Oracle) or global tech firm announcing a product, expansion, data centre, or partnership in UAE, Saudi Arabia, or the Gulf',
    search: 'Microsoft Google AWS Oracle SAP UAE Saudi Arabia data center cloud AI launch 2025',
  },
  talent: {
    name: 'Talent Signals',
    n: 2, riskMode: false,
    pill: '↑ Surge|→ Stable|↓ Cool', pc: 'p-high|p-new|p-low',
    focus: 'the most important AI/tech hiring trend, salary benchmark, or workforce skill shift for GCC organisations — covering UAE, Saudi Arabia, or India tech talent markets',
    search: 'AI tech jobs hiring salary GCC UAE Saudi Arabia India talent 2025',
  },
  policy: {
    name: 'Policy & Regulation',
    n: 2, riskMode: false,
    pill: 'Act Now|Monitor|Review', pc: 'p-risk|p-watch|p-new',
    focus: 'the most actionable government policy, regulation, or digital-economy initiative that directly affects technology or AI operations in UAE, Saudi Arabia, or India',
    search: 'UAE TDRA Saudi SDAIA India MeitY AI regulation digital policy 2025',
  },
  tech: {
    name: 'Technology Signals',
    n: 2, riskMode: false,
    pill: 'High|Medium', pc: 'p-high|p-watch',
    focus: 'a concrete platform or technology shift — new AI model release, cloud platform update, or enterprise software change — that changes how GCC organisations will operate',
    search: 'AI model release enterprise platform update cloud GCC technology shift 2025',
  },
  deals: {
    name: 'Deals & Capital',
    n: 2, riskMode: false,
    pill: 'Partnership|Investment|JV|Acquisition', pc: 'p-new|p-watch|p-new|p-risk',
    focus: 'the most significant technology deal, M&A, joint venture, or investment announced in or affecting the Gulf, UAE, Saudi Arabia, or India AI/tech ecosystem',
    search: 'technology investment deal acquisition partnership UAE Saudi Arabia India AI 2025',
  },
  risks: {
    name: 'Risks & Opportunities',
    n: 4, riskMode: true,
    pill: 'Risk|Opp', pc: 'p-risk|p-opp',
    focus: 'one active risk (cyber, regulation, geopolitical, supply chain) AND one real opportunity for GCC AI & Tech organisations right now — both must be backed by recent news',
    search: 'GCC UAE technology risk cybersecurity opportunity market 2025',
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const countNote = cfg.riskMode
    ? `Return exactly ${cfg.n} items: first half have pill:"Risk" pc:"p-risk", second half have pill:"Opp" pc:"p-opp". Each must be a DIFFERENT news story.`
    : cfg.n > 1
      ? `Return exactly ${cfg.n} items from DIFFERENT real articles covering distinct angles. Use varied pill values from: ${cfg.pill}.`
      : 'Return exactly 1 item.';

  return `You are a GCC AI & Tech intelligence analyst. Today is ${today}.

USE YOUR WEB SEARCH TOOL NOW. Search the live internet for: "${cfg.search}"

Do multiple searches if needed. You must find: ${cfg.focus}.

Only use articles published within the last 7 days. Prioritise sources like Arabian Business, The National, Zawya, Reuters, Bloomberg, TechCrunch, CNBC, Financial Times, Gulf News.

${countNote}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:
{"items":[{
  "pill":"${cfg.pill}",
  "pc":"${cfg.pc}",
  "tag":"Category · DD Mon",
  "age":"actual publication date from the article (e.g. 3 May 2025)",
  "title":"exact or near-exact headline from the article (max 15 words)",
  "body":"4-6 sentences using real facts, numbers, and named companies from the article with GCC strategic context",
  "why":"<strong>Chairman's Lens:</strong> 1-2 sentence strategic implication for a GCC AI/Tech leader",
  "src":"exact publication name",
  "url":"exact URL from your web search results — must be a real URL you retrieved"
}]}

STRICT RULES:
- Only use articles you ACTUALLY found via web search
- Never fabricate or guess URLs — only URLs your search tool returned
- Include specific real numbers, company names, and dates from the article
- If no relevant GCC article found, search again with broader terms`;
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

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: buildPrompt(section, today) }],
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
