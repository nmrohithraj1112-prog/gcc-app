// Claude searches the live internet for real, current GCC/Gulf AI & tech news.
// Returns 2 articles per section (4 for risks: 2 risks + 2 opportunities).

const SECTION_CONFIG = {
  exec: {
    name: 'Executive Snapshot',
    n: 2, riskMode: false,
    focus: 'the single most impactful AI or technology business announcement in UAE or Saudi Arabia this week — a major deal, government initiative, or strategic move by a leading organisation',
    search: 'UAE Saudi Arabia AI technology business announcement 2025',
    alt: 'site:arabianbusiness.com OR site:thenationalnews.com OR site:zawya.com OR site:reuters.com UAE AI tech 2025',
  },
  themes: {
    name: 'Strategic Themes',
    n: 2, riskMode: false,
    focus: 'the most significant AI or enterprise technology trend GCC organisations must act on now — agentic AI, large language models, automation, cloud adoption, or digital transformation in Gulf markets',
    search: 'agentic AI enterprise transformation Gulf UAE Saudi Arabia technology trend 2025',
    alt: 'AI automation digital transformation GCC Middle East 2025',
  },
  competitor: {
    name: 'Market Moves',
    n: 2, riskMode: false,
    focus: 'a major competitive move by a hyperscaler or global technology firm — Microsoft, Google, AWS, Oracle, SAP, or Salesforce announcing a product launch, data centre, or strategic partnership in UAE, Saudi Arabia, or the Gulf',
    search: 'Microsoft Google AWS Oracle UAE Saudi Arabia data center cloud partnership launch 2025',
    alt: 'hyperscaler technology expansion Gulf Middle East announcement 2025',
  },
  talent: {
    name: 'Talent Signals',
    n: 2, riskMode: false,
    focus: 'the most important AI and technology hiring trend, salary benchmark, or workforce transformation for GCC organisations — covering UAE, Saudi Arabia, or India tech talent markets',
    search: 'AI technology hiring salary GCC UAE Saudi Arabia India talent workforce 2025',
    alt: 'tech jobs AI skills demand Middle East India salary report 2025',
  },
  policy: {
    name: 'Policy & Regulation',
    n: 2, riskMode: false,
    focus: 'the most actionable government regulation, AI governance framework, or digital-economy policy that directly affects technology operations in UAE, Saudi Arabia, or India — include the specific authority or ministry',
    search: 'UAE TDRA AI regulation Saudi SDAIA India MeitY digital policy framework 2025',
    alt: 'AI governance regulation compliance UAE Saudi Arabia India government 2025',
  },
  tech: {
    name: 'Technology Signals',
    n: 2, riskMode: false,
    focus: 'a concrete platform shift or model release — new AI model, cloud platform capability, or enterprise software update — that changes how GCC organisations will operate or compete',
    search: 'AI model release enterprise platform update cloud technology shift GCC 2025',
    alt: 'new AI model LLM enterprise software release 2025 business impact',
  },
  deals: {
    name: 'Deals & Capital',
    n: 2, riskMode: false,
    focus: 'the most significant technology deal, M&A transaction, joint venture, or investment announced in or affecting the Gulf, UAE, Saudi Arabia, or India AI/tech ecosystem — include the deal value if reported',
    search: 'technology investment deal acquisition joint venture UAE Saudi Arabia India AI 2025',
    alt: 'tech startup funding M&A Gulf Middle East India 2025',
  },
  risks: {
    name: 'Risks & Opportunities',
    n: 4, riskMode: true,
    focus: 'two distinct items: one active risk (cyber threat, AI regulation, geopolitical disruption, or supply chain issue) AND one genuine opportunity (market opening, new capability, or strategic advantage) — both must cite a specific recent event in the GCC or India tech sector',
    search: 'GCC UAE technology cybersecurity risk threat opportunity market 2025',
    alt: 'Middle East tech risk cyber AI regulation opportunity investment 2025',
  },
};

function buildPrompt(section, today) {
  const cfg = SECTION_CONFIG[section] || SECTION_CONFIG.exec;
  const countNote = cfg.riskMode
    ? `Return exactly ${cfg.n} items: the first ${cfg.n/2} have type "Risk", the last ${cfg.n/2} have type "Opportunity". Each must cite a DIFFERENT news story.`
    : `Return exactly ${cfg.n} items from DIFFERENT real articles covering distinct angles.`;

  return `You are a GCC AI & Technology intelligence analyst. Today is ${today}.

STEP 1 — Search the live internet now. Primary query: "${cfg.search}"
STEP 2 — If results are thin or not GCC-relevant, search again: "${cfg.alt}"
Use as many searches as needed to find genuinely recent articles.

You are looking for: ${cfg.focus}

Requirements:
- Articles must be published within the last 7 days (after ${today} minus 7 days)
- Prioritise: Arabian Business, The National, Zawya, Reuters, Bloomberg, Gulf News, TechCrunch, CNBC, Financial Times, Wired, ET Tech
- Use real article URLs you actually retrieved — never fabricate or guess
- Include specific company names, figures, dates, and dollar amounts from the article

${countNote}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:
{"items":[{
  "tag":"Section Name · DD Mon YYYY",
  "age":"exact publication date (e.g. 2 May 2025)",
  "title":"exact or near-exact article headline (max 15 words)",
  "body":"4-6 sentences with real facts, named companies, specific numbers, and GCC strategic context drawn directly from the article",
  "why":"<strong>Strategic Implication:</strong> 1-2 sentences on what this means for a GCC technology or AI leader — be specific and actionable",
  "img":"direct URL to the article featured image or og:image (e.g. https://cdn.example.com/img.jpg) — empty string if not found",
  "src":"exact publication name",
  "url":"exact article URL from your search results",
  "pill":"Risk or Opp (only for risks section, otherwise omit)",
  "pc":"p-risk or p-opp (only for risks section, otherwise omit)"
}]}

STRICT RULES:
- Only use articles you ACTUALLY retrieved via web search — no invented stories
- Never fabricate URLs — only use URLs your search tool returned
- The img field must be a real image URL from the article page, or empty string
- Include specific real numbers, company names, and dates from the article
- If no relevant GCC article found after two searches, broaden to adjacent markets (India, broader Middle East)`;
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
        max_tokens: 2500,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
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
