// Fetches the latest MeteoSwiss radar precipitation frame (RZC product,
// updated every 5 min, free Open Government Data as of Nov 2025), parses
// the HDF5/ODIM file, projects it from Swiss LV95 to WGS84, and renders it
// as a PNG image overlay for Leaflet.
//
// This is genuinely more complex than a typical API integration - HDF5 is a
// real scientific binary format, not JSON, and there's no way to test this
// against a live file before deploying. ?debug=1 returns raw diagnostic info
// at each stage instead of the PNG, so a first-try miss can be debugged from
// real data rather than guessed at blind.

import { PNG } from 'pngjs';

const STAC_BASE = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-radar-precip';

async function findAssets(debugLog) {
  const itemsRes = await fetch(`${STAC_BASE}/items?limit=5&sortby=-datetime`);
  if (!itemsRes.ok) throw new Error('STAC items request failed: HTTP ' + itemsRes.status);
  const itemsData = await itemsRes.json();
  debugLog.stacItemCount = (itemsData.features || []).length;

  const allUrls = [];
  for (const item of (itemsData.features || [])) {
    const assets = item.assets || {};
    const keys = Object.keys(assets)
      .filter(k => /rzc/i.test(k) && /\.h5$/i.test(k))
      .sort(); // ISO-ish timestamps in filenames sort correctly as strings
    for (const k of keys) allUrls.push(assets[k].href);
  }
  // newest first, most recent ~12 frames (1h at 5-min steps)
  allUrls.reverse();
  return allUrls.slice(0, 12);
}

function readAttr(h5Group, name) {
  if (!h5Group || !h5Group.attrs || !h5Group.attrs[name]) return undefined;
  const attr = h5Group.attrs[name];
  // h5wasm attribute objects may expose the value directly via .value, or
  // (less commonly) already be the raw value/array itself - handle both.
  const v = (attr && typeof attr === 'object' && 'value' in attr) ? attr.value : attr;
  return Array.isArray(v) || (v && v.length !== undefined && typeof v !== 'string') ? v[0] : v;
}

export default async function handler(req, res) {
  const debug = req.query.debug === '1';
  const debugLog = {};

  try {
    const assets = await findAssets(debugLog);
    debugLog.assetCount = assets.length;

    // ?list=1 just returns the available frame timestamps (parsed from
    // filenames like rzc262212355v1.001.h5 -> ddhhmmss-ish) so the frontend
    // can build a slider without downloading every frame up front.
    if (req.query.list === '1') {
      const frames = assets.map((url, i) => {
        const m = url.match(/rzc(\d{9})/);
        return { index: i, code: m ? m[1] : null };
      });
      return res.status(200).json({ frames });
    }

    const frameIdx = Math.max(0, Math.min(assets.length - 1, parseInt(req.query.frame, 10) || 0));
    const assetUrl = assets[frameIdx];
    debugLog.assetUrl = assetUrl;
    debugLog.frameIdx = frameIdx;

    const fileRes = await fetch(assetUrl);
    if (!fileRes.ok) throw new Error('Radar file download failed: HTTP ' + fileRes.status);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    debugLog.fileSizeBytes = buffer.length;

    const h5wasm = await import('h5wasm/node');
    await h5wasm.ready;
    const { FS } = h5wasm;
    const tmpName = '/tmp/radar.h5';
    FS.writeFile(tmpName, new Uint8Array(buffer));
    const f = new h5wasm.File(tmpName, 'r');

    debugLog.rootKeys = f.keys();

    const dataset = f.get('dataset1');
    if (!dataset) throw new Error('No /dataset1 group found in HDF5 file (unexpected ODIM structure).');
    debugLog.dataset1Keys = dataset.keys();

    const data1 = dataset.get('data1');
    const dataArr = data1.get('data');
    const raw = dataArr.value; // typed array, shape info on .shape
    const shape = dataArr.shape;
    debugLog.shape = shape;
    debugLog.dataSample = Array.from(raw.slice(0, 10));
    let sampleMin = Infinity, sampleMax = -Infinity;
    for (let i = 0; i < raw.length; i++) { if (raw[i] < sampleMin) sampleMin = raw[i]; if (raw[i] > sampleMax) sampleMax = raw[i]; }
    debugLog.dataMin = sampleMin;
    debugLog.dataMax = sampleMax;

    // gain/offset/nodata/undetect can live on dataset1/what or data1/what
    // depending on the exact product - check both.
    const whatCandidates = [dataset.get('what'), data1.get('what')].filter(Boolean);
    let gain = 1, offset = 0, nodata = 255, undetect = 0;
    for (const w of whatCandidates) {
      gain = readAttr(w, 'gain') ?? gain;
      offset = readAttr(w, 'offset') ?? offset;
      nodata = readAttr(w, 'nodata') ?? nodata;
      undetect = readAttr(w, 'undetect') ?? undetect;
    }
    debugLog.scaling = { gain, offset, nodata, undetect };

    // Georeferencing - direct lon/lat corners, confirmed reliably present
    // in the real files (verified via ?debug=1 against a live frame).
    const where = f.get('where');
    debugLog.whereKeys = where ? where.attrs && Object.keys(where.attrs) : null;
    let bounds;
    const LL_lon = readAttr(where, 'LL_lon'), LL_lat = readAttr(where, 'LL_lat');
    const LR_lon = readAttr(where, 'LR_lon'), LR_lat = readAttr(where, 'LR_lat');
    const UL_lon = readAttr(where, 'UL_lon'), UL_lat = readAttr(where, 'UL_lat');
    const UR_lon = readAttr(where, 'UR_lon'), UR_lat = readAttr(where, 'UR_lat');
    debugLog.corners = { LL: [LL_lat, LL_lon], LR: [LR_lat, LR_lon], UL: [UL_lat, UL_lon], UR: [UR_lat, UR_lon] };
    debugLog.gridInfo = {
      xsize: readAttr(where, 'xsize'), ysize: readAttr(where, 'ysize'),
      xscale: readAttr(where, 'xscale'), yscale: readAttr(where, 'yscale')
    };
    if (LL_lon != null && UR_lon != null) {
      bounds = [[LL_lat, LL_lon], [UR_lat, UR_lon]];
    }
    debugLog.bounds = bounds;

    if (debug) {
      res.status(200).json({ ok: true, debug: debugLog });
      return;
    }

    if (!bounds) {
      throw new Error('Could not determine georeferencing bounds from file (see ?debug=1 for details).');
    }

    const [h, w] = shape;
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
      const v = raw[i];
      let r = 0, g = 0, b = 0, a = 0;
      if (v !== nodata && v !== undetect) {
        const mmh = v * gain + offset;
        if (mmh > 0.1) {
          // green -> amber -> rose intensity ramp, matching the app's palette
          const t = Math.min(1, mmh / 20);
          r = Math.round(34 + t * (225 - 34));
          g = Math.round(211 - t * (211 - 29));
          b = Math.round(153 - t * (153 - 72));
          a = Math.round(120 + t * 135);
        }
      }
      const idx = i * 4;
      png.data[idx] = r; png.data[idx+1] = g; png.data[idx+2] = b; png.data[idx+3] = a;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Radar-Bounds', JSON.stringify(bounds));
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.status(200).send(PNG.sync.write(png));
  } catch (err) {
    console.error('meteoswiss-radar failed', err);
    res.status(500).json({ error: err.message, debug: debug ? debugLog : undefined });
  }
}
