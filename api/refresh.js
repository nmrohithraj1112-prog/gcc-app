// Claude searches the live internet for real, current news.
// Returns 1 article per section (2 for risks: 1 risk + 1 opportunity).

const SECTION_CONFIG = {
  exec: {
    name: 'Executive Snapshot',
    n: 1, riskMode: false,
    pill: 'High|Medium|Low', pc: 'p-high|p-med|p-low',
    focus: 'the single most impactful GCC, Gulf, or India AI & technology business news today',
    search: 'GCC Gulf UAE Saudi Arabia AI technology enterprise news today',
  },
  themes: {
    name: 'Key Look-out',
    n: 1, riskMode: false,
    pill: 'Accelerating|Emerging|Watch', pc: 'p-high|p-new|p-watch',
    focus: 'the most significant emerging AI or technology trend affecting GCC organisations right now',
    search: 'AI enterprise technology trend GCC Gulf 2026 agentic',
  },
  competitor: {
    name: 'Competitor Move',
    n: 1, riskMode: false,
    pill: 'Platform|Scale|Expansion|Partnership', pc: 'p-platform|p-scale|p-expansion|p-new',
    focus: 'a major move by a hyperscaler, tech giant, or GCC peer that changes competitive positioning',
    search: 'Microsoft Google Amazon Oracle SAP GCC UAE AI technology announcement 2026',
  },
  talent: {
    name: 'Talent Signal',
    n: 1, riskMode: false,
    pill: '↑ Surge|→ Stable|↓ Cool', pc: 'p-high|p-new|p-low',
    focus: 'the most important AI or tech hiring, salary, or workforce development in GCC or India',
    search: 'AI engineer jobs hiring GCC India technology talent 2026',
  },
  policy: {
    name: 'Policy Update',
    n: 1, riskMode: false,
    pill: 'Act Now|Monitor|Review', pc: 'p-risk|p-watch|p-new',
    focus: 'the most relevant policy, regulation, or government initiative affecting GCC tech organisations',
    search: 'UAE Saudi Arabia India AI regulation technology policy government 2026',
  },
  tech: {
    name: 'Tech Shift',
    n: 1, riskMode: false,
    pill: 'High|Medium', pc: 'p-high|p-watch',
    focus: 'a real platform or technology shift that directly changes how enterprise GCC organisations operate',
    search: 'enterprise AI platform shift agentic GCC technology 2026',
  },
  deals: {
    name: 'Deal / Partnership',
    n: 1, riskMode: false,
    pill: 'Partnership|Investment|JV|Acquisition', pc: 'p-new|p-watch|p-new|p-risk',
    focus: 'the most significant deal, investment, or partnership in Gulf or India AI/tech ecosystem',
    search: 'technology deal investment partnership UAE Saudi Arabia India AI 2026',
  },
  risks: {
    name: 'Risk & Opportunity',
    n: 2, riskMode: true,
    pill: 'Risk|Opp', pc: 'p-risk|p-opp',
    focus: 'one active risk AND one real opportunity for GCC AI & Tech organisations this week',
    search: 'GCC AI technology risk opportunity market 2026',
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const countNote = cfg.riskMode
    ? 'Return exactly 2 items: item 1 has pill:"Risk" pc:"p-risk", item 2 has pill:"Opp" pc:"p-opp".'
    : 'Return exactly 1 item.';

  return `You are a GCC AI & Tech intelligence analyst. Today is ${today}.

Search the internet for: "${cfg.search}"

Find the MOST RECENT real news article (published today or within the last 3 days) about: ${cfg.focus}.

${countNote}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:
{"items":[{
  "pill":"${cfg.pill}",
  "pc":"${cfg.pc}",
  "tag":"Category · DD Mon",
  "age":"actual publication date from the article",
  "title":"exact headline from the article (max 15 words)",
  "body":"4-6 sentences using real facts, numbers, and companies from the article with GCC strategic context",
  "why":"<strong>Why it matters:</strong> 1-2 sentence implication for a GCC AI/Tech leader",
  "src":"exact publication name",
  "url":"exact URL from your search results"
}]}

RULES: Only use articles you actually found via search. Never invent or guess URLs. Include real specific facts.`;
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
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
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
