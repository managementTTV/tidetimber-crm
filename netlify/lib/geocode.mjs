// ============================================================
//  Free geocoder for map pins (no Google).
//  1. AddressNC: NC OneMap's statewide 911 address points (public, no key).
//  2. US Census Geocoder: backup for SC addresses and NC misses (public, no key).
//  A pin is only returned when the match is unambiguous; otherwise null.
//  Google geocodes may not be stored for more than 30 days (Maps ToS
//  §3.2.3(b)), so the CRM keeps only these coordinates.
// ============================================================

const ADDRESSNC = 'https://services.nconemap.gov/secure/rest/services/AddressNC/NC1Map_Addresses/FeatureServer/0/query';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

// Pat's buy box, used when an address has no city or ZIP.
const BUYBOX_COUNTIES = ['MECKLENBURG', 'GASTON', 'CABARRUS', 'UNION', 'IREDELL', 'LINCOLN', 'CATAWBA', 'CLEVELAND', 'ROWAN', 'STANLY'];

const DIRS = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST', NE: 'NORTHEAST', NW: 'NORTHWEST', SE: 'SOUTHEAST', SW: 'SOUTHWEST' };
for (const v of Object.values(DIRS)) DIRS[v] = v;

const TYPES = {
  ST: 'STREET', STR: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', RD: 'ROAD', DR: 'DRIVE', LN: 'LANE', CT: 'COURT',
  CIR: 'CIRCLE', CR: 'CIRCLE', BLVD: 'BOULEVARD', BV: 'BOULEVARD', PL: 'PLACE', PKWY: 'PARKWAY', PY: 'PARKWAY',
  HWY: 'HIGHWAY', TER: 'TERRACE', TR: 'TERRACE', TRL: 'TRAIL', WY: 'WAY', SQ: 'SQUARE', XING: 'CROSSING',
  PT: 'POINT', CV: 'COVE', ALY: 'ALLEY', EXT: 'EXTENSION', CRES: 'CRESCENT', LP: 'LOOP', RDG: 'RIDGE',
  RUN: 'RUN', PATH: 'PATH', ROW: 'ROW', WAY: 'WAY', LOOP: 'LOOP', GRN: 'GREEN', HTS: 'HEIGHTS', MNR: 'MANOR',
  VW: 'VIEW', BND: 'BEND', CRK: 'CREEK', GLN: 'GLEN', HL: 'HILL', HOLW: 'HOLLOW', LNDG: 'LANDING', PASS: 'PASS',
  PIKE: 'PIKE', PLZ: 'PLAZA', SPGS: 'SPRINGS', TRCE: 'TRACE', WALK: 'WALK', CMNS: 'COMMONS', CTR: 'CENTER',
};
for (const v of Object.values(TYPES)) TYPES[v] = v;

// AddressNC and Census both spell numbered streets as 4TH, not FOURTH.
const ORDINALS = { FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH', SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH', ELEVENTH: '11TH', TWELFTH: '12TH' };
const normName = (n) => n.split(' ').map(t => ORDINALS[t] || t).join(' ');

const UNIT_RE = /\s*(?:#|\b(?:APT|APARTMENT|UNIT|STE|SUITE|LOT|BLDG|BUILDING|RM)\b\.?)\s*[A-Z0-9-]*\s*$/;
const clean = (s) => String(s || '').toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// "2612 Elon St, Charlotte, NC 28208" → { number, predir, name, type, posdir, city, zip, state }
export function parseAddress(raw) {
  const parts = clean(raw).split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let line = parts[0].replace(UNIT_RE, '');
  const m = line.match(/^(\d+)(?:-?[A-Z])?\s+(.+)$/);
  if (!m) return null;
  const rest = parts.slice(1).join(' ');
  const zip = (rest.match(/\b(2[7-9]\d{3})(?:-\d{4})?\b/) || [])[1] || '';
  const state = /\b(SC|SOUTH CAROLINA)\b/.test(rest) || /^29/.test(zip) ? 'SC' : 'NC';
  const cityPart = parts.length > 1 ? parts[1].replace(/\b(NC|SC|NORTH CAROLINA|SOUTH CAROLINA)\b/g, '').replace(/\b\d{5}(-\d{4})?\b/g, '').trim() : '';
  const tokens = m[2].split(' ');
  let predir = '', type = '', posdir = '';
  if (tokens.length > 1 && DIRS[tokens[tokens.length - 1]] && TYPES[tokens[tokens.length - 2]]) posdir = DIRS[tokens.pop()];
  if (tokens.length > 1 && TYPES[tokens[tokens.length - 1]]) type = TYPES[tokens.pop()];
  if (tokens.length > 1 && DIRS[tokens[0]]) predir = DIRS[tokens.shift()];
  const name = normName(tokens.join(' ').replace(/[^A-Z0-9 '&-]/g, '').trim());
  if (!name) return null;
  return { number: m[1], predir, name, type, posdir, city: cityPart, zip, state };
}

const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0015 && Math.abs(a.lng - b.lng) < 0.0015;   // ~150 m

// Pick the AddressNC point(s) that agree with every part the address gave.
// Units of one building share a spot; points far apart mean "ambiguous".
export function pickAddressNC(p, features) {
  const hits = features.map(f => f.attributes || f).filter(a =>
    clean(a.st_name) === p.name &&
    (!p.type || !a.st_postyp || clean(a.st_postyp) === p.type) &&
    (!p.predir || clean(a.st_predir) === p.predir) &&
    (!p.posdir || clean(a.st_posdir) === p.posdir) &&
    typeof a.ddlat === 'number' && typeof a.ddlong === 'number');
  if (!hits.length) return null;
  const first = { lat: hits[0].ddlat, lng: hits[0].ddlong };
  if (!hits.every(a => near(first, { lat: a.ddlat, lng: a.ddlong }))) return null;
  return { lat: +first.lat.toFixed(6), lng: +first.lng.toFixed(6), source: 'addressnc', county: clean(hits[0].county) };
}

async function getJson(fetchImpl, url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function addressNC(p, fetchImpl) {
  const where = [`add_number=${sqlStr(p.number)}`, `st_name=${sqlStr(p.name)}`];
  if (p.zip) where.push(`post_code=${sqlStr(p.zip)}`);
  else if (p.city) where.push(`(post_comm=${sqlStr(p.city)} OR inc_muni=${sqlStr(p.city)})`);
  else where.push(`county IN (${BUYBOX_COUNTIES.map(sqlStr).join(',')})`);
  const url = ADDRESSNC + '?' + new URLSearchParams({
    where: where.join(' AND '),
    outFields: 'st_predir,st_name,st_postyp,st_posdir,county,ddlat,ddlong',
    returnGeometry: 'false', resultRecordCount: '50', f: 'json',
  });
  const d = await getJson(fetchImpl, url, 4000);
  return d && Array.isArray(d.features) ? pickAddressNC(p, d.features) : null;
}

async function census(raw, p, fetchImpl) {
  if (!p.city && !p.zip) return null;   // a bare street could be in any town: no guessing
  const q = /\b(NC|SC|NORTH CAROLINA|SOUTH CAROLINA)\b/i.test(raw) ? raw : raw + ', NC';
  const url = CENSUS + '?' + new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'json' });
  const d = await getJson(fetchImpl, url, 5000);
  const hits = d && d.result && d.result.addressMatches;
  if (!Array.isArray(hits) || hits.length !== 1) return null;
  const h = hits[0];
  const c = h.addressComponents || {};
  const street = clean(c.streetName).split(' ').filter(t => !DIRS[t]).join(' ');
  if (normName(street) !== p.name) return null;                   // the street must be the one typed
  if (p.zip && c.zip && c.zip !== p.zip) return null;
  const { x, y } = h.coordinates || {};
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { lat: +y.toFixed(6), lng: +x.toFixed(6), source: 'census' };
}

export async function geocode(raw, fetchImpl = fetch) {
  const p = parseAddress(raw);
  if (!p) return null;
  if (p.state === 'NC') {
    const hit = await addressNC(p, fetchImpl);
    if (hit) return hit;
  }
  return census(String(raw), p, fetchImpl);
}
