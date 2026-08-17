// Reads the Wavaudiolab intake app's Firebase Realtime Database, specifically
// the /projects path — nothing else in the database is touched. Requires the
// Realtime Database rules to grant read access to /projects specifically
// (not the whole database) — see rules.json alongside this file for the
// exact rule to add.

const DATABASE_URL = 'https://mastering-2b382-default-rtdb.europe-west1.firebasedatabase.app';

export default async function handler(req, res) {
  try {
    const r = await fetch(`${DATABASE_URL}/projects.json`);
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: 'Firebase returned HTTP ' + r.status });
    }
    if (data && data.error) {
      return res.status(403).json({ error: 'Firebase error: ' + data.error });
    }
    if (!data) {
      return res.status(200).json({ projects: [] });
    }

    const projects = Object.values(data)
      .map(p => ({
        id: p.id,
        clientName: p.clientName || 'Unknown client',
        createdAt: p.createdAt,
        trackCount: p.tracks ? Object.keys(p.tracks).length : 0
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
