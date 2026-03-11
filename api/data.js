const SUBREDDITS = [
  'Polymarket',
  'Kalshi',
  'polymarket_bets',
  'polymarket_news',
  'polymarket_Traders',
  'PredictionMarkets',
  'polymarketanalysis',
  'ManifoldMarkets'
];

const UA = 'Mozilla/5.0 (compatible; RedditDashboard/1.0; +https://github.com/vipulsharmaapi)';

async function fetchJSON(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Rate limited (429)`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        // If Reddit returned HTML instead of JSON, try old.reddit.com
        if (url.includes('www.reddit.com') && attempt < retries) {
          url = url.replace('www.reddit.com', 'old.reddit.com');
          continue;
        }
        throw new Error(`Not JSON (status ${res.status}, body starts: ${text.substring(0, 100)})`);
      }
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchSubredditData(sub) {
  // Stagger the 3 requests slightly to avoid triggering rate limits
  const about = await fetchJSON(`https://www.reddit.com/r/${sub}/about.json`);
  await delay(300);
  const newPosts = await fetchJSON(`https://www.reddit.com/r/${sub}/new.json?limit=25`);
  await delay(300);
  const hotPosts = await fetchJSON(`https://www.reddit.com/r/${sub}/hot.json?limit=10`);

  const info = about.data;
  const posts = newPosts.data.children.map(p => p.data);
  const hot = hotPosts.data.children.map(p => p.data);

  const now = Date.now() / 1000;
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
  const recentPosts = posts.filter(p => p.created_utc > thirtyDaysAgo);

  const totalUpvotes = recentPosts.reduce((s, p) => s + p.score, 0);
  const totalComments = recentPosts.reduce((s, p) => s + p.num_comments, 0);

  return {
    name: sub,
    displayName: info.display_name_prefixed,
    description: info.public_description || info.title || '',
    subscribers: info.subscribers,
    activeUsers: info.accounts_active || info.active_user_count || 0,
    recentPostCount: recentPosts.length,
    recentUpvotes: totalUpvotes,
    recentComments: totalComments,
    avgScore: recentPosts.length ? (totalUpvotes / recentPosts.length).toFixed(1) : 0,
    avgComments: recentPosts.length ? (totalComments / recentPosts.length).toFixed(1) : 0,
    postsPerK: info.subscribers ? ((recentPosts.length / info.subscribers) * 1000).toFixed(1) : 0,
    upvotesPerK: info.subscribers ? ((totalUpvotes / info.subscribers) * 1000).toFixed(1) : 0,
    commentsPerK: info.subscribers ? ((totalComments / info.subscribers) * 1000).toFixed(1) : 0,
    hotPosts: hot.slice(0, 5).map(p => ({
      title: p.title,
      score: p.score,
      comments: p.num_comments,
      url: `https://reddit.com${p.permalink}`,
      created: p.created_utc,
      author: p.author,
      flair: p.link_flair_text || ''
    })),
    newPosts: recentPosts.slice(0, 5).map(p => ({
      title: p.title,
      score: p.score,
      comments: p.num_comments,
      url: `https://reddit.com${p.permalink}`,
      created: p.created_utc,
      author: p.author,
      flair: p.link_flair_text || ''
    }))
  };
}

module.exports = async function handler(req, res) {
  try {
    // Fetch subreddits in batches of 2 with delays to avoid Reddit rate limits
    const results = [];
    for (let i = 0; i < SUBREDDITS.length; i += 2) {
      const batch = SUBREDDITS.slice(i, i + 2);
      const batchResults = await Promise.all(
        batch.map(sub =>
          fetchSubredditData(sub).catch(err => ({
            name: sub,
            error: err.message,
            subscribers: 0,
            activeUsers: 0,
            recentPostCount: 0,
            recentUpvotes: 0,
            recentComments: 0,
            avgScore: 0,
            avgComments: 0,
            postsPerK: 0,
            upvotesPerK: 0,
            commentsPerK: 0,
            hotPosts: [],
            newPosts: []
          }))
        )
      );
      results.push(...batchResults);
      // Wait between batches to avoid rate limiting
      if (i + 2 < SUBREDDITS.length) {
        await delay(1500);
      }
    }

    const data = {
      subreddits: results,
      fetchedAt: new Date().toISOString()
    };

    // Cache for 5 min, serve stale for 10 min while revalidating
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
