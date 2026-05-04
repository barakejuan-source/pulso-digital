#!/usr/bin/env python3
"""
Fetch YouTube comments for each candidate and analyze sentiment with pysentimiento.
Outputs JSON to stdout.
"""
import json
import sys
import subprocess
import re

CANDIDATES = [
    {
        'id': 'ivan_cepeda',
        'name': 'Iván Cepeda',
        'queries': ['Ivan Cepeda candidato 2026', 'Iván Cepeda presidente Colombia']
    },
    {
        'id': 'abelardo_espriella',
        'name': 'Abelardo de la Espriella',
        'queries': ['Abelardo de la Espriella candidato 2026', 'Abelardo Espriella presidente Colombia']
    },
    {
        'id': 'paloma_valencia',
        'name': 'Paloma Valencia',
        'queries': ['Paloma Valencia candidata 2026', 'Paloma Valencia presidente Colombia']
    },
    {
        'id': 'sergio_fajardo',
        'name': 'Sergio Fajardo',
        'queries': ['Sergio Fajardo candidato 2026', 'Sergio Fajardo presidente Colombia']
    }
]

MAX_VIDEOS_PER_CANDIDATE = 3
MAX_COMMENTS_PER_VIDEO = 50


def search_youtube(query, max_results=3):
    """Search YouTube and return list of video IDs."""
    cmd = [
        sys.executable, '-m', 'yt_dlp',
        f'ytsearch{max_results}:{query}',
        '--dump-json',
        '--no-download',
        '--flat-playlist',
        '--quiet',
        '--no-warnings'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        video_ids = []
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            try:
                data = json.loads(line)
                if data.get('id'):
                    video_ids.append(data['id'])
            except json.JSONDecodeError:
                pass
        return video_ids
    except Exception as e:
        print(f'[youtube] search error for "{query}": {e}', file=sys.stderr)
        return []


def fetch_comments(video_id, max_comments=50):
    """Fetch comments from a YouTube video."""
    cmd = [
        sys.executable, '-m', 'yt_dlp',
        f'https://www.youtube.com/watch?v={video_id}',
        '--write-comments',
        '--skip-download',
        '--dump-json',
        '--quiet',
        '--no-warnings',
        '--extractor-args', f'youtube:max_comments={max_comments}'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            try:
                data = json.loads(line)
                comments = data.get('comments', [])
                texts = [c.get('text', '').strip() for c in comments if c.get('text', '').strip()]
                views = data.get('view_count', 0) or 0
                return texts[:max_comments], views
            except json.JSONDecodeError:
                pass
        return [], 0
    except Exception as e:
        print(f'[youtube] comments error for {video_id}: {e}', file=sys.stderr)
        return [], 0


def analyze_sentiment(texts):
    """Analyze sentiment using pysentimiento. Returns {positive, negative, neutral} counts."""
    if not texts:
        return {'positive': 0, 'negative': 0, 'neutral': 0, 'total': 0}

    try:
        from pysentimiento import create_analyzer
        analyzer = create_analyzer(task='sentiment', lang='es')

        # pysentimiento returns 'pos', 'neg', 'neu'
        counts = {'pos': 0, 'neg': 0, 'neu': 0}
        for text in texts:
            try:
                result = analyzer.predict(text[:500])
                label = result.output.lower()
                if label in counts:
                    counts[label] += 1
                else:
                    counts['neu'] += 1
            except Exception:
                counts['neu'] += 1

        total = sum(counts.values())
        return {
            'positive': counts['pos'],
            'negative': counts['neg'],
            'neutral':  counts['neu'],
            'total': total
        }

    except ImportError:
        print('[sentiment] pysentimiento not available, returning neutral', file=sys.stderr)
        return {'positive': 0, 'negative': 0, 'neutral': len(texts), 'total': len(texts)}


def process_candidate(candidate):
    all_comments = []
    total_views = 0
    video_ids_seen = set()

    for query in candidate['queries']:
        video_ids = search_youtube(query, max_results=MAX_VIDEOS_PER_CANDIDATE)
        for vid in video_ids:
            if vid in video_ids_seen:
                continue
            video_ids_seen.add(vid)
            comments, views = fetch_comments(vid, max_comments=MAX_COMMENTS_PER_VIDEO)
            all_comments.extend(comments)
            total_views += views
            print(f'  [{candidate["id"]}] video={vid} comments={len(comments)} views={views}', file=sys.stderr)

    print(f'[{candidate["id"]}] total comments={len(all_comments)} views={total_views}', file=sys.stderr)

    sentiment = analyze_sentiment(all_comments)
    total = sentiment['total'] or 1
    sentiment_pct = {
        'positive': round((sentiment['positive'] / total) * 100, 1),
        'negative': round((sentiment['negative'] / total) * 100, 1),
        'neutral':  round((sentiment['neutral']  / total) * 100, 1)
    }

    return {
        'id': candidate['id'],
        'views': total_views,
        'commentCount': len(all_comments),
        'sentiment': sentiment_pct,
        'sentimentRaw': sentiment
    }


def main():
    results = {}
    for candidate in CANDIDATES:
        print(f'\nProcessing {candidate["name"]}...', file=sys.stderr)
        try:
            data = process_candidate(candidate)
            results[candidate['id']] = data
        except Exception as e:
            print(f'Error processing {candidate["id"]}: {e}', file=sys.stderr)
            results[candidate['id']] = {
                'id': candidate['id'],
                'views': 0,
                'commentCount': 0,
                'sentiment': {'positive': 0, 'negative': 0, 'neutral': 100},
                'sentimentRaw': {'positive': 0, 'negative': 0, 'neutral': 0, 'total': 0}
            }

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
