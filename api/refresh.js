// Claude searches the live internet for real, current GCC (Global Capability Center) news.
// Returns 10 articles per section (10 for risks: 5 risks + 5 opportunities).

const SECTION_CONFIG = {
  exec: {
    name: 'Executive Snapshot',
    n: 10, riskMode: false,
    focus: 'the single most impactful news for Global Capability Center (GCC) leaders this week — a major GCC industry announcement, new GCC setup by a Fortune 500 company in India, NASSCOM GCC report, or a strategic shift in the India technology ecosystem that GCC heads must know about',
    search: '"Global Capability Center" OR "GCC India" announcement setup 2025',
    alt: 'NASSCOM GCC India technology hub Fortune 500 India setup expansion 2025',
  },
  themes: {
    name: 'Strategic Themes',
    n: 10, riskMode: false,
    focus: 'the most significant AI or technology trend reshaping how Global Capability Centers operate — GenAI adoption, agentic AI, automation displacing roles, platform modernisation, or a new operating model GCC leaders are piloting in India',
    search: 'GenAI AI adoption Global Capability Center India enterprise technology 2025',
    alt: 'agentic AI automation GCC India operations transformation digital 2025',
  },
  competitor: {
    name: 'Market Moves',
    n: 10, riskMode: false,
    focus: 'a major move by a hyperscaler or global technology vendor — Microsoft, Google Cloud, AWS, Oracle, or SAP — launching a new India cloud region, AI service, or strategic programme specifically for Global Capability Centers or the India enterprise market',
    search: 'Microsoft Google AWS Oracle India cloud AI GCC enterprise launch 2025',
    alt: 'hyperscaler technology vendor India GCC programme announcement 2025',
  },
  talent: {
    name: 'Talent Signals',
    n: 10, riskMode: false,
    focus: 'the most important hiring trend, salary benchmark, or workforce shift for Global Capability Centers in India — covering AI/ML talent demand, GCC attrition data, salary benchmarks for senior engineers or AI specialists, or upskilling programmes',
    search: 'India tech talent GCC hiring salary AI ML workforce 2025',
    alt: 'NASSCOM India IT salary benchmark GCC attrition hiring trend 2025',
  },
  policy: {
    name: 'Policy & Regulation',
    n: 10, riskMode: false,
    focus: 'the most actionable government regulation or policy change affecting Global Capability Centers in India — India DPDPA data protection rules, SEZ/IT park policy, US H-1B visa changes, India budget IT incentives, or cross-border data transfer regulations',
    search: 'India DPDPA data protection SEZ IT regulation GCC compliance 2025',
    alt: 'US H-1B visa India IT policy GCC compliance regulation 2025',
  },
  tech: {
    name: 'Technology Signals',
    n: 10, riskMode: false,
    focus: 'a concrete AI platform, tool, or technology capability that Global Capability Centers in India are actively adopting or evaluating — GitHub Copilot enterprise rollout, a new GenAI coding tool, cloud AI services, or enterprise software with embedded AI that changes GCC productivity',
    search: 'AI platform tool enterprise India GCC GenAI productivity adoption 2025',
    alt: 'GitHub Copilot enterprise AI coding tool cloud platform India GCC 2025',
  },
  deals: {
    name: 'Deals & Capital',
    n: 10, riskMode: false,
    focus: 'the most significant deal affecting the Global Capability Center ecosystem — a new GCC established by a Fortune 500 company in India, a major expansion of an existing GCC, private equity investment in India tech services, or an acquisition of an India-based technology firm',
    search: '"Global Capability Center" India new setup expansion investment deal 2025',
    alt: 'Fortune 500 GCC India Bangalore Hyderabad Pune Chennai investment 2025',
  },
  risks: {
    name: 'Risks & Opportunities',
    n: 10, riskMode: true,
    focus: 'two distinct items: one active risk facing Global Capability Centers in India (AI-driven job displacement, US visa/offshoring restrictions, DPDPA compliance burden, or cybersecurity threat) AND one real opportunity (new GCC sectors like semiconductor/gaming/healthcare, India government GCC incentives, or an AI capability that creates competitive advantage) — both must cite a specific recent news event',
    search: '"Global Capability Center" India risk opportunity AI jobs 2025',
    alt: 'GCC India H-1B offshoring AI automation risk opportunity investment 2025',
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const countNote = cfg.riskMode
    ? `Return exactly ${cfg.n} items: the first ${cfg.n / 2} must have pill:"Risk" pc:"p-risk", the last ${cfg.n / 2} must have pill:"Opp" pc:"p-opp". Every item must cite a DIFFERENT news story — do multiple searches to find enough.`
    : `Return exactly ${cfg.n} items from DIFFERENT real articles. Do multiple searches to find enough — vary your search queries to cover different angles.`;

  return `You are an intelligence analyst covering the Global Capability Center (GCC) industry — the offshore and nearshore technology operations established by multinational companies, primarily in India (Bangalore, Hyderabad, Pune, Chennai, Mumbai). Today is ${today}.

CONTEXT: "GCC" in this brief means Global Capability Center, NOT Gulf Cooperation Council. Focus entirely on the India-based GCC ecosystem, India tech sector, and global technology trends affecting GCC operations.

STEP 1 — Search the live internet now. Primary query: "${cfg.search}"
STEP 2 — If results are thin or off-topic, search again with: "${cfg.alt}"
Run as many searches as needed to find genuinely recent, relevant articles.

You are looking for: ${cfg.focus}

Requirements:
- Articles published within the last 7 days only
- Prioritise: NASSCOM.in, Economic Times Tech, Mint, Business Standard, The Hindu BusinessLine, MoneyControl, LiveMint, Reuters, Bloomberg, TechCrunch, Forbes India, YourStory, Inc42
- Only use URLs you actually retrieved via search — never fabricate
- Include specific company names, city locations, dollar/rupee figures, and dates

${countNote}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:
{"items":[{
  "tag":"Section Name · DD Mon YYYY",
  "age":"exact publication date from the article (e.g. 2 May 2025)",
  "title":"exact or near-exact article headline (max 15 words)",
  "body":"2-3 sentences maximum — real facts, named companies, key numbers, and GCC strategic context from the article. Keep it tight and scannable.",
  "why":"<strong>Strategic Implication:</strong> 1-2 sentences on what this means specifically for a Global Capability Center leader — be concrete and actionable",
  "src":"exact publication name (e.g. Economic Times)",
  "url":"exact article URL from your search results",
  "pill":"Risk or Opp — only for risks section, omit for all other sections",
  "pc":"p-risk or p-opp — only for risks section, omit for all other sections"
}]}

STRICT RULES:
- Only use articles you ACTUALLY found via web search — no invented stories
- Never fabricate URLs — only use URLs your search tool returned
- Include specific real numbers, company names, city names, and dates
- "GCC" in your response means Global Capability Center, never Gulf Cooperation Council
- If no relevant article found after two searches, broaden to India IT/tech sector news`;
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
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
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
