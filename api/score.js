// 這支程式跑在 Vercel 的伺服器端(瀏覽器看不到資料庫的連線資訊)
// 負責讀取/累加「總點擊數」和「排行榜」，資料實際存在 Upstash Redis 裡
// Vercel Marketplace 裝好 Upstash 整合後，會自動幫專案注入連線用的環境變數，
// Redis.fromEnv() 會自動去讀那些變數，不用自己手動指定變數名稱

const { Redis } = require('@upstash/redis');

const TOTAL_KEY = 'pocat:total';
const BOARD_KEY = 'pocat:leaderboard';
const MAX_NAME_LEN = 14;
const MAX_COUNT_PER_REQUEST = 1000; // 防止單次請求亂塞誇張數字

let redis = null;
function getClient() {
  if (!redis) {
    redis = Redis.fromEnv();
  }
  return redis;
}

async function readState(client) {
  const [total, board] = await Promise.all([
    client.get(TOTAL_KEY),
    client.hgetall(BOARD_KEY),
  ]);
  const leaderboard = {};
  if (board) {
    for (const name in board) {
      leaderboard[name] = parseInt(board[name], 10) || 0;
    }
  }
  return { totalClicks: parseInt(total, 10) || 0, leaderboard: leaderboard };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const client = getClient();

    if (req.method === 'GET') {
      const state = await readState(client);
      res.status(200).json(state);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};

      let name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) name = '匿名訪客';
      name = name.slice(0, MAX_NAME_LEN);

      let count = parseInt(body.count, 10);
      if (!Number.isFinite(count) || count <= 0) {
        const state = await readState(client);
        res.status(200).json(state);
        return;
      }
      count = Math.min(count, MAX_COUNT_PER_REQUEST);

      // incrby / hincrby 是 Redis 的原子操作，多人同時點也不會互相蓋掉
      await Promise.all([
        client.incrby(TOTAL_KEY, count),
        client.hincrby(BOARD_KEY, name, count),
      ]);

      const state = await readState(client);
      res.status(200).json(state);
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('score api error:', err);
    res.status(500).json({ error: 'server error', detail: String(err && err.message || err) });
  }
};
