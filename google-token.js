// Vercel serverless function — runs server-side only. The client secret lives
// in Vercel's Environment Variables (Project Settings → Environment Variables),
// never in this file and never in the repo. The frontend calls this endpoint
// instead of talking to Google's token endpoint directly.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { grant_type, code, code_verifier, redirect_uri, refresh_token } = req.body || {};

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: grant_type
  });

  if (grant_type === 'authorization_code') {
    params.set('code', code);
    params.set('code_verifier', code_verifier);
    params.set('redirect_uri', redirect_uri);
  } else if (grant_type === 'refresh_token') {
    params.set('refresh_token', refresh_token);
  } else {
    return res.status(400).json({ error: 'invalid_grant_type' });
  }

  try {
    const googleRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await googleRes.json();
    res.status(googleRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'proxy_failed', error_description: err.message });
  }
}
