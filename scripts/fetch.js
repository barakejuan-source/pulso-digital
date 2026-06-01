const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const googleTrends = require('google-trends-api');
const Parser = require('rss-parser');

const rss = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 PulsoDigital/1.0' } });

const RSS_FEEDS = [
  { name: 'El Tiempo',      url: 'https://www.eltiempo.com/rss/politica.xml' },
  { name: 'La Silla Vacía', url: 'https://www.lasillavacia.com/rss/' },
  { name: 'Infobae',        url: 'https://www.infobae.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'BBC Mundo',      url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  { name: 'France 24',      url: 'https://www.france24.com/es/rss' }
];

const OUT         = path.join(__dirname, '../docs/data.json');
const HISTORY_OUT = path.join(__dirname, '../docs/history.json');

const CANDIDATES = [
  {
    id: 'ivan_cepeda',
    name: 'Iván Cepeda',
    party: 'Pacto Histórico',
    color: '#E63946',
    keywords: ['Iván Cepeda', 'Cepeda candidato', 'Cepeda segunda vuelta'],
    exclude: ['Manuel Cepeda']
  },
  {
    id: 'abelardo_espriella',
    name: 'Abelardo de la Espriella',
    party: 'Defensores de la Patria',
    color: '#1D3557',
    keywords: ['Abelardo de la Espriella', 'Abelardo Espriella', 'Espriella segunda vuelta'],
    exclude: []
  }
];

async function fetchRSS() {
  const articles = [];
  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rss.parseURL(feed.url);
      parsed.items.forEach(item => articles.push({
        title: item.title || '',
        snippet: item.contentSnippet || '',
        link: item.link || '',
        pubDate: item.pubDate || new Date().toISOString(),
        source: feed.name
      }));
    } catch (e) { console.warn(`RSS skip (${feed.name}):`, e.message); }
  }

  const tagged = [];
  for (const article of articles) {
    const text = `${article.title} ${article.snippet}`.toLowerCase();
    for (const c of CANDIDATES) {
      if (c.exclude.some(ex => text.includes(ex.toLowerCase()))) continue;
      if (c.keywords.some(kw => text.includes(kw.toLowerCase()))) {
        if (!tagged.find(a => a.link === article.link)) {
          tagged.push({ ...article, candidateId: c.id, candidateColor: c.color });
        }
        break;
      }
    }
    // Also include general election articles
    const electionTerms = ['segunda vuelta', 'balotaje', 'elecciones 2026', 'candidato presidencial', 'campaña presidencial'];
    if (!tagged.find(a => a.link === article.link) && electionTerms.some(t => text.includes(t))) {
      tagged.push({ ...article, candidateId: null, candidateColor: '#64748b' });
    }
  }

  return tagged
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 12)
    .map(a => ({
      title: a.title,
      link: a.link,
      source: a.source,
      pubDate: a.pubDate,
      candidateId: a.candidateId,
      candidateColor: a.candidateColor
    }));
}

// Weights
const W_TRENDS    = 0.40;
const W_YOUTUBE   = 0.30;
const W_SENTIMENT = 0.30;

async function fetchTrends(previous) {
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
      scores[c.id] = Math.round(vals.reduce((a, b) => a + b, 0) / (vals.length || 1));
    });
    const max = Math.max(...Object.values(scores), 1);
    const out = {};
    Object.entries(scores).forEach(([id, v]) => { out[id] = Math.round((v / max) * 100); });
    return { scores: out, fresh: true };
  } catch (e) {
    console.warn('Trends error (usando scores anteriores):', e.message);
    const fallback = Object.fromEntries(
      CANDIDATES.map(c => {
        const prev = previous?.candidates?.find(p => p.id === c.id);
        return [c.id, prev?.trendsScore ?? 0];
      })
    );
    return { scores: fallback, fresh: false };
  }
}

function fetchYouTubeSentiment() {
  const scriptPath = path.join(__dirname, 'youtube_sentiment.py');
  try {
    const output = execSync(`python3 "${scriptPath}"`, {
      timeout: 10 * 60 * 1000, // 10 min
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit']
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('YouTube sentiment error:', e.message);
    return Object.fromEntries(CANDIDATES.map(c => [c.id, {
      views: 0, commentCount: 0,
      sentiment: { positive: 0, negative: 0, neutral: 100 }
    }]));
  }
}

// Normalize a map of {id: rawValue} to 0-100 scores
function normalize(map) {
  const max = Math.max(...Object.values(map), 1);
  const out = {};
  Object.entries(map).forEach(([id, v]) => { out[id] = Math.round((v / max) * 100); });
  return out;
}

async function main() {
  const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

  console.log('Fetching Google Trends...');
  const { scores: trends, fresh: trendsFresh } = await fetchTrends(previous);
  if (!trendsFresh) console.log('  → usando trendsScores del snapshot anterior');

  console.log('Fetching YouTube + sentiment...');
  const ytRaw = fetchYouTubeSentiment();

  // If YouTube returned no views for everyone, fall back to previous scores
  const ytTotalViews = Object.values(ytRaw).reduce((s, d) => s + (d.views || 0), 0);
  const ytFresh = ytTotalViews > 0;
  if (!ytFresh) console.log('  → YouTube bloqueado, usando scores anteriores');

  const yt = ytFresh ? ytRaw : Object.fromEntries(
    CANDIDATES.map(c => {
      const prev = previous?.candidates?.find(p => p.id === c.id);
      return [c.id, {
        views: prev?.youtubeViews || 0,
        commentCount: 0,
        sentiment: prev?.sentimentPct || { positive: 0, negative: 0, neutral: 100 }
      }];
    })
  );

  // Normalize YouTube engagement (views + comments)
  const engagementRaw = Object.fromEntries(
    CANDIDATES.map(c => {
      const d = yt[c.id] || {};
      return [c.id, (d.views || 0) + (d.commentCount || 0) * 100];
    })
  );
  const ytScores = normalize(engagementRaw);

  // Sentiment score: positive% maps to 0-100
  const sentScores = Object.fromEntries(
    CANDIDATES.map(c => {
      const s = (yt[c.id] || {}).sentiment || {};
      return [c.id, Math.round(s.positive || 0)];
    })
  );

  const candidatesData = CANDIDATES.map(c => {
    const t  = trends[c.id]   || 0;
    const ys = ytScores[c.id] || 0;
    const ss = sentScores[c.id] || 0;

    const finalScore = Math.round(t * W_TRENDS + ys * W_YOUTUBE + ss * W_SENTIMENT);

    const prev = previous?.candidates?.find(p => p.id === c.id);
    let momentum = { value: 0, direction: 'flat' };
    if (prev) {
      const delta = finalScore - prev.finalScore;
      const pct = prev.finalScore > 0 ? ((delta / prev.finalScore) * 100).toFixed(1) : 0;
      momentum = { value: parseFloat(pct), direction: delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat' };
    }

    return {
      id: c.id,
      name: c.name,
      party: c.party,
      color: c.color,
      trendsScore: t,
      youtubeScore: ys,
      sentimentScore: ss,
      sentimentPct: (yt[c.id] || {}).sentiment || { positive: 0, negative: 0, neutral: 100 },
      youtubeViews: (yt[c.id] || {}).views || 0,
      finalScore,
      momentum
    };
  });

  const total = candidatesData.reduce((s, c) => s + c.finalScore, 0) || 1;
  const withProb = candidatesData.map(c => ({
    ...c,
    probability: parseFloat(((c.finalScore / total) * 100).toFixed(1))
  }));

  console.log('Fetching RSS news...');
  const articles = await fetchRSS();
  console.log(`  → ${articles.length} artículos encontrados`);

  const snapshot = { updatedAt: new Date().toISOString(), trendsFresh, candidates: withProb, articles };
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log('Done. Saved to', OUT);

  console.log('Updating history...');
  await updateHistory(withProb);
}

// ── Historical Trends (weekly from Jan 2026) ──────────────────────────────────

async function fetchTrendsHistory() {
  try {
    const result = await googleTrends.interestOverTime({
      keyword: CANDIDATES.map(c => c.name),
      geo: 'CO',
      startTime: new Date('2026-01-01'),
      endTime: new Date(),
      granularTimeResolution: true
    });
    const timeline = JSON.parse(result).default.timelineData;
    // timeline = [{time, formattedTime, value:[n,n,n,n]}, ...]
    return timeline.map(point => {
      const date = new Date(parseInt(point.time) * 1000).toISOString().split('T')[0];
      const entry = { date };
      CANDIDATES.forEach((c, idx) => {
        entry[c.id] = parseInt(point.value[idx]) || 0;
      });
      return entry;
    });
  } catch (e) {
    console.warn('Historical Trends error:', e.message);
    return [];
  }
}

// Append current scores to history.json
function updateHistory(withProb, ytFresh, ytData) {
  const today = new Date().toISOString().split('T')[0];
  const hour  = new Date().getHours();
  const key   = `${today}T${String(hour).padStart(2,'0')}`;

  let history = fs.existsSync(HISTORY_OUT)
    ? JSON.parse(fs.readFileSync(HISTORY_OUT, 'utf8'))
    : { bootstrapped: false, points: [] };

  // Bootstrap: fetch full Trends history from Jan 2026
  if (!history.bootstrapped) {
    console.log('Bootstrapping historical Trends data from Jan 2026...');
    return fetchTrendsHistory().then(trendsHistory => {
      // Build historical points from Trends only (YouTube/Sentiment = 0 for past)
      const maxByCandidate = {};
      CANDIDATES.forEach(c => {
        maxByCandidate[c.id] = Math.max(...trendsHistory.map(p => p[c.id] || 0), 1);
      });

      const historicalPoints = trendsHistory.map(p => ({
        date: p.date,
        candidates: CANDIDATES.map(c => ({
          id: c.id,
          trends: p[c.id] || 0,
          youtube: null,
          sentiment: null
        }))
      }));

      // Append current live point
      historicalPoints.push({
        date: key,
        candidates: withProb.map(c => ({
          id: c.id,
          trends: c.trendsScore,
          youtube: c.youtubeScore,
          sentiment: c.sentimentScore
        }))
      });

      history = { bootstrapped: true, points: historicalPoints };
      fs.writeFileSync(HISTORY_OUT, JSON.stringify(history, null, 2));
      console.log(`  → History bootstrapped: ${historicalPoints.length} points`);
    });
  }

  // Subsequent runs: just append
  const existing = history.points.find(p => p.date === key);
  if (!existing) {
    history.points.push({
      date: key,
      candidates: withProb.map(c => ({
        id: c.id,
        trends: c.trendsScore,
        youtube: c.youtubeScore,
        sentiment: c.sentimentScore
      }))
    });
    fs.writeFileSync(HISTORY_OUT, JSON.stringify(history, null, 2));
    console.log(`  → History updated: ${history.points.length} total points`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
