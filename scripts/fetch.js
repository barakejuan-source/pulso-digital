const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const googleTrends = require('google-trends-api');

const OUT = path.join(__dirname, '../docs/data.json');

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

  const snapshot = { updatedAt: new Date().toISOString(), trendsFresh, candidates: withProb };
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log('Done. Saved to', OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
