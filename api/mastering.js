// Reads the Wavaudiolab intake app's Firebase Realtime Database.
// First pass: fetch the raw root data so we can see the actual structure,
// then refine the parsing to match. Firebase RTDB's REST API just needs a
// URL + .json suffix — no SDK, no auth needed if the DB's read rules allow it.

const DATABASE_URL = 'https://mastering-2b382-default-rtdb.europe-west1.firebasedatabase.app';

export default async function handler(req, res) {
  try {
    const r = await fetch(`${DATABASE_URL}/.json`);
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: 'Firebase returned HTTP ' + r.status, detail: data });
    }
    if (data && data.error) {
      return res.status(403).json({ error: 'Firebase error: ' + data.error });
    }

    // Return raw data for now so we can inspect the real shape.
    res.status(200).json({ raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
