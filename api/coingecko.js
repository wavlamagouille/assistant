// Proxies CoinGecko Demo API requests so the key stays server-side (Vercel
// env var) instead of being committed to the repo. CoinGecko's own docs
// explicitly recommend this pattern: "store the API key securely in your
// own backend and use a proxy to insert the key into the request URL."

const ALLOWED_ENDPOINTS = new Set(['coins/markets', 'search']);

export default async function handler(req, res) {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'COINGECKO_API_KEY is not set in Vercel Environment Variables.' });
  }

  const { endpoint, ...params } = req.query;
  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: 'Missing or unsupported endpoint parameter.' });
  }

  try {
    const qs = new URLSearchParams({ ...params, x_cg_demo_api_key: apiKey }).toString();
    const url = `https://api.coingecko.com/api/v3/${endpoint}?${qs}`;
    const cgRes = await fetch(url);
    const data = await cgRes.json();
    res.status(cgRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

