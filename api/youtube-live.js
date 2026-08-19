// Looks up the currently-live video ID for a given YouTube channel via the
// official YouTube Data API v3. This is the reliable path — embedding a
// specific video ID directly works consistently, unlike YouTube's
// channel-based live-lookup embed trick, which is documented as unreliable
// and confirmed unreliable in testing here.
//
// Accepts EITHER a channelId (exact) OR a channelName (searched, then
// resolved to a channel ID) - so nobody has to hunt down raw channel IDs.

export default async function handler(req, res) {
  const { channelId, channelName } = req.query;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set in Vercel Environment Variables.' });
  }
  if (!channelId && !channelName) {
    return res.status(400).json({ error: 'Missing channelId or channelName parameter.' });
  }

  try {
    let resolvedChannelId = channelId;
    let resolvedChannelName = null;

    if (!resolvedChannelId) {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelName)}&type=channel&maxResults=1&key=${apiKey}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      if (!searchRes.ok) {
        return res.status(searchRes.status).json({ error: (searchData.error && searchData.error.message) || 'Channel search failed.' });
      }
      if (!searchData.items || !searchData.items.length) {
        return res.status(200).json({ videoId: null, message: 'No channel found matching "' + channelName + '".' });
      }
      resolvedChannelId = searchData.items[0].id.channelId;
      resolvedChannelName = searchData.items[0].snippet.title;
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(resolvedChannelId)}&eventType=live&type=video&maxResults=1&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: (data.error && data.error.message) || 'YouTube API request failed.' });
    }
    if (!data.items || !data.items.length) {
      return res.status(200).json({
        videoId: null,
        channelId: resolvedChannelId,
        resolvedChannelName,
        message: 'No live broadcast found for ' + (resolvedChannelName || 'this channel') + ' right now.'
      });
    }

    const item = data.items[0];
    res.status(200).json({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      channelId: resolvedChannelId,
      resolvedChannelName
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

