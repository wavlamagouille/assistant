// Proxies OpenWeatherMap's radar forecast tiles so the API key stays
// server-side (Vercel env var) instead of being committed to the repo -
// GitHub's secret scanner flags OpenWeatherMap keys specifically if
// embedded directly in frontend code.

export default async function handler(req, res) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENWEATHER_API_KEY is not set in Vercel Environment Variables.' });
  }

  const { z, x, y, tm } = req.query;
  if (!z || !x || !y || !tm) {
    return res.status(400).json({ error: 'Missing z, x, y, or tm parameter.' });
  }

  try {
    const url = `https://maps.openweathermap.org/maps/2.0/radar/forecast/${z}/${x}/${y}?appid=${apiKey}&tm=${tm}`;
    const tileRes = await fetch(url);
    if (!tileRes.ok) {
      return res.status(tileRes.status).json({ error: 'OpenWeatherMap returned HTTP ' + tileRes.status });
    }
    const buffer = await tileRes.arrayBuffer();
    res.setHeader('Content-Type', tileRes.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

