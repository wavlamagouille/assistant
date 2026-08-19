// Looks up the currently-live video ID for a given YouTube channel via the
// official YouTube Data API v3. This is the reliable path — embedding a
// specific video ID directly works consistently, unlike YouTube's
// channel-based live-lookup embed trick, which is documented as unreliable
// and confirmed unreliable in testing here.

export default async function handler(req, res) {
  const { channelId } = req.query;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set in Vercel Environment Variables.' });
  }
  if (!channelId) {
    return res.status(400).json({ error: 'Missing channelId parameter.' });
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&maxResults=1&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: (data.error && data.error.message) || 'YouTube API request failed.' });
    }
    if (!data.items || !data.items.length) {
      return res.status(200).json({ videoId: null, message: 'No live broadcast found for this channel right now.' });
    }

    const item = data.items[0];
    res.status(200).json({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

