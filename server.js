const express = require('express');
const path = require('path');
const fs = require('fs');
const googleTrends = require('google-trends-api');
const Parser = require('rss-parser');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refresh every 6 hours

const CANDIDATES = [
  {
    id: 'ivan_cepeda',
    name: 'Iván Cepeda',
    party: 'Pacto Histórico',
    color: '#E63946',
    keywords: ['Iván Cepeda', 'Cepeda candidato'],
    exclude: ['Manuel Cepeda']
  },
  {
    id: 'abelardo_espriella',
    name: 'Abelardo de la Espriella',
    party: 'Defensores de la Patria',
    color: '#1D3557',
    keywords: ['Abelardo de la Espriella', 'Abelardo Espriella'],
    exclude: []
  },
  {
    id: 'paloma_valencia',
    name: 'Paloma Valencia',
    party: 'Centro Democrático',
    color: '#457B9D',
    keywords: ['Paloma Valencia', 'Senadora Paloma'],
    exclude: []
  },
  {
    id: 'sergio_fajardo',
    name: 'Sergio Fajardo',
    party: 'Coalición Centro Esperanza',
    color: '#2A9D8F',
    keywords: ['Sergio Fajardo', 'Fajardo candidato'],
    exclude: ['Mafe Fajardo', 'Daniel Fajardo']
  }
];

const RSS_FEEDS = [
  { name: 'Semana',          url: 'https://www.semana.com/rss/' },
  { name: 'El Espectador',   url: 'https://www.elespectador.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'El Tiempo',       url: 'https://www.eltiempo.com/rss/politica.xml' },
  { name: 'Blu Radio',       url: 'https://www.bluradio.com/rss.xml' },
  { name: 'La Silla Vacía',  url: 'https://www.lasillavacia.com/rss/' }
];

const rssParser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 PulsoDigital/1.0' }
});

// ── Google Trends ──────────────────────────────────────────────────────────────

async function fetchTrends() {
  try {
    const result = await googleTrends.interestOverTime({
      keyword: CANDIDATES.map(c => c.name),
      geo: 'CO',
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      endTime: new Date()
    });

    const timeline = JSON.parse(result).default.timelineData;
    const scores = {};

    CANDIDATES.forEach((c, idx) => {
      const vals = timeline.map(p => parseInt(p.value[idx]) || 0);
      const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      scores[c.id] = Math.round(avg);
    });

    const max = Math.max(...Object.values(scores), 1);
    const normalized = {};
    Object.entries(scores).forEach(([id, v]) => {
      normalized[id] = Math.round((v / max) * 100);
    });

    return normalized;
  } catch (err) {
    console.error('Trends error:', err.message);
    return Object.fromEntries(CANDIDATES.map(c => [c.id, 0]));
  }
}

// ── RSS feeds ──────────────────────────────────────────────────────────────────

async function fetchRSS() {
  const allArticles = [];

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      parsed.items.forEach(item => {
        allArticles.push({
          title: item.title || '',
          snippet: item.contentSnippet || item.content || '',
          link: item.link || '',
          pubDate: item.pubDate || new Date().toISOString(),
          source: feed.name
        });
      });
    } catch (err) {
      console.warn(`RSS skip (${feed.name}): ${err.message}`);
    }
  }

  const mentions = Object.fromEntries(CANDIDATES.map(c => [c.id, 0]));
  const tagged = [];

  for (const article of allArticles) {
    const text = `${article.title} ${article.snippet}`.toLowerCase();

    for (const c of CANDIDATES) {
      if (c.exclude.some(ex => text.includes(ex.toLowerCase()))) continue;
      if (c.keywords.some(kw => text.includes(kw.toLowerCase()))) {
        mentions[c.id]++;
        tagged.push({ ...article, candidate_id: c.id });
      }
    }
  }

  const max = Math.max(...Object.values(mentions), 1);
  const scores = {};
  Object.entries(mentions).forEach(([id, v]) => {
    scores[id] = Math.round((v / max) * 100);
  });

  const recent = tagged
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 30);

  return { scores, mentions, articles: recent };
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function buildSnapshot(trendsScores, previous) {
  const candidatesData = CANDIDATES.map(c => {
    const trends = trendsScores[c.id] || 0;
    const finalScore = trends; // 100% Google Trends

    const prev = previous?.candidates?.find(p => p.id === c.id);
    let momentum = { value: 0, direction: 'flat' };
    if (prev) {
      const delta = finalScore - prev.finalScore;
      const pct   = prev.finalScore > 0 ? ((delta / prev.finalScore) * 100).toFixed(1) : 0;
      momentum = {
        value: parseFloat(pct),
        direction: delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat'
      };
    }

    return {
      id: c.id,
      name: c.name,
      party: c.party,
      color: c.color,
      trendsScore: trends,
      finalScore,
      momentum
    };
  });

  const total = candidatesData.reduce((s, c) => s + c.finalScore, 0) || 1;
  const withProb = candidatesData.map(c => ({
    ...c,
    probability: parseFloat(((c.finalScore / total) * 100).toFixed(1))
  }));

  return {
    updatedAt: new Date().toISOString(),
    candidates: withProb,
    articles: mediaResult.articles
  };
}

// ── Data refresh ───────────────────────────────────────────────────────────────

async function refresh() {
  console.log(`[${new Date().toLocaleTimeString()}] Fetching data...`);

  const previous = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    : null;

  const trends = await fetchTrends();
  const snapshot = buildSnapshot(trends, previous);

  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`[${new Date().toLocaleTimeString()}] Done. Data saved to data.json`);
  return snapshot;
}

function needsRefresh() {
  if (!fs.existsSync(DATA_FILE)) return true;
  const stat = fs.statSync(DATA_FILE);
  return Date.now() - stat.mtimeMs > CACHE_TTL_MS;
}

// ── Express routes ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    if (needsRefresh()) await refresh();
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    const data = await refresh();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

if (process.argv.includes('--fetch-once')) {
  refresh().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  app.listen(PORT, async () => {
    console.log(`Pulso Digital running at http://localhost:${PORT}`);
    if (needsRefresh()) await refresh();
    // auto-refresh every 6 hours
    setInterval(refresh, CACHE_TTL_MS);
  });
}
