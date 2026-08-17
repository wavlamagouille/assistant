// Reads the Wavaudiolab intake app's Firebase Realtime Database: /projects
// (submitted mastering jobs) and /inquiries (quote requests). Rather than
// requiring a change to your Firebase rules, this signs in anonymously first
// (the same mechanism your intake app almost certainly already uses to let
// clients submit without an account) and reads using that session —
// respecting your existing rules exactly as they are.

const DATABASE_URL = 'https://mastering-2b382-default-rtdb.europe-west1.firebasedatabase.app';
const FIREBASE_API_KEY = 'AIzaSyCasdb4heqoq7_740fJqy_x03BZmKt1WoQ'; // Firebase's public web API key, not a secret

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAuthToken(){
  if(cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true })
  });
  const data = await r.json();
  if(!r.ok) throw new Error((data.error && data.error.message) || 'Anonymous sign-in failed');
  cachedToken = data.idToken;
  cachedTokenExpiry = Date.now() + (Number(data.expiresIn || 3600) * 1000) - 60000;
  return cachedToken;
}

async function fetchPath(path, token){
  const r = await fetch(`${DATABASE_URL}/${path}.json?auth=${token}`);
  const data = await r.json();
  if (!r.ok) throw new Error('Firebase returned HTTP ' + r.status + ' for /' + path);
  if (data && data.error) throw new Error('Firebase error on /' + path + ': ' + data.error);
  return data || {};
}

// Mirrors the intake app's own trackStatus()/projectStatus() logic exactly
// (status was never a stored field — it's computed from each track's flags).
function trackStatus(t){
  if(t.approval) return 'approved';
  if(t.needsRevision) return 'revisions';
  if(t.versions && t.versions.length) return 'delivered';
  if(t.needsMixFix) return 'mix_fixes';
  if(t.mixApproved) return 'ready';
  return 'new';
}

function computeProjectStatus(p){
  if(p.payment && p.payment.status === 'paid') return 'paid';
  const tracks = Object.values(p.tracks || {});
  if(!tracks.length) return 'new';
  const statuses = tracks.map(trackStatus);
  if(statuses.every(s => s === 'approved')) return 'approved';
  if(statuses.some(s => s === 'revisions')) return 'revisions';
  if(statuses.some(s => s === 'delivered')) return 'delivered';
  if(statuses.some(s => s === 'mix_fixes')) return 'mix_fixes';
  if(statuses.some(s => s === 'ready')) return 'ready';
  return 'new';
}

export default async function handler(req, res) {
  try {
    const token = await getAuthToken();
    const [projectsData, inquiriesData] = await Promise.all([
      fetchPath('projects', token),
      fetchPath('inquiries', token)
    ]);

    const projects = Object.values(projectsData)
      .map(p => ({
        type: 'job',
        id: p.id,
        clientName: p.clientName || 'Unknown client',
        clientEmail: p.clientEmail || '',
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        status: computeProjectStatus(p),
        trackCount: p.tracks ? Object.keys(p.tracks).length : 0,
        brief: p.brief || null,
        tracks: p.tracks || null
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const inquiries = Object.values(inquiriesData)
      .map(q => ({
        type: 'quote',
        id: q.id,
        clientName: q.clientName || 'Unknown client',
        clientEmail: q.clientEmail || '',
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
        status: q.status || 'new',
        genre: q.genre || '',
        budget: q.budget || '',
        deadline: q.deadline || '',
        details: q.details || '',
        service: q.service || null,
        archived: !!q.archived
      }))
      .filter(q => !q.archived)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ projects, inquiries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
