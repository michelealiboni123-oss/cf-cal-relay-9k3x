// Fetches upcoming iCloud calendar events and writes a small public JSON file for the
// CleanFrame TV app to poll. Runs server-side (GitHub Actions) specifically because Apple's
// CalDAV servers send no CORS headers, so a browser (the TV included) can never read these
// responses directly. Outputs a flat, sorted event list; day-grouping and "Today"/"Tomorrow"
// labels are computed client-side against the viewer's live clock, not baked in here.
import { writeFileSync } from 'node:fs';
import ical from 'node-ical';

const EMAIL = process.env.ICLOUD_EMAIL;
const PASSWORD = process.env.ICLOUD_APP_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD env vars');

const AUTH_HEADER = 'Basic ' + Buffer.from(EMAIL + ':' + PASSWORD).toString('base64');
const WINDOW_DAYS = 6;
const MAX_EVENTS = 40;

async function dav(url, method, body, depth) {
  const headers = { 'Content-Type': 'application/xml', Authorization: AUTH_HEADER };
  if (depth !== undefined) headers.Depth = String(depth);
  const response = await fetch(url, { method, headers, body });
  if (!response.ok && response.status !== 207) {
    throw new Error(method + ' ' + url + ' failed: ' + response.status + ' ' + (await response.text()).slice(0, 300));
  }
  return response.text();
}
function extractTag(xml, tag) {
  return [...xml.matchAll(new RegExp('<' + tag + '[^>]*>([^<]*)</' + tag + '>', 'g'))].map(m => m[1]);
}
function hrefInside(xml, wrapperTag) {
  const wrapper = xml.match(new RegExp('<' + wrapperTag + '[^>]*>([\\s\\S]*?)</' + wrapperTag + '>'));
  return wrapper ? (extractTag(wrapper[1], 'href')[0] || null) : null;
}
function textOf(value) {
  if (value == null) return null;
  if (typeof value === 'object' && 'val' in value) return String(value.val);
  return String(value);
}
function dateOnlyString(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(ymd, delta) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const principalXml = await dav('https://caldav.icloud.com/', 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/></A:prop></A:propfind>', 0);
const principalPath = hrefInside(principalXml, 'current-user-principal');
if (!principalPath) throw new Error('Could not discover principal URL');
const homeXml = await dav('https://caldav.icloud.com' + principalPath, 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><C:calendar-home-set/></A:prop></A:propfind>', 0);
const homeUrl = hrefInside(homeXml, 'calendar-home-set');
if (!homeUrl) throw new Error('Could not discover calendar-home-set');

const listXml = await dav(homeUrl, 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><A:displayname/><A:resourcetype/></A:prop></A:propfind>', 1);
const SKIP = new Set(['inbox', 'outbox', 'notification', '']);
const calendarPaths = [...listXml.matchAll(/<response[^>]*>([\s\S]*?)<\/response>/g)]
  .map(m => m[1])
  .filter(block => /<calendar\s*\/?>/.test(block) || /<calendar xmlns/.test(block))
  .map(block => extractTag(block, 'href')[0])
  .filter(href => href && !SKIP.has(href.replace(/\/$/, '').split('/').pop()));

const now = new Date();
const horizon = new Date(now.getTime() + WINDOW_DAYS * 86400000);
const fmt = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
const events = [];

function exdateSet(item) {
  if (!item.exdate) return null;
  const set = new Set();
  for (const key of Object.keys(item.exdate)) set.add(new Date(key).getTime());
  return set;
}

for (const path of calendarPaths) {
  const url = new URL(path, homeUrl).toString();
  const body = '<?xml version="1.0"?>\n' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n' +
    '  <D:prop><D:getetag/><C:calendar-data/></D:prop>\n' +
    '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">\n' +
    '    <C:time-range start="' + fmt(now) + '" end="' + fmt(horizon) + '"/>\n' +
    '  </C:comp-filter></C:comp-filter></C:filter>\n' +
    '</C:calendar-query>';
  let xml;
  try { xml = await dav(url, 'REPORT', body, 1); } catch (err) { console.error('Skipping calendar ' + path + ': ' + err.message); continue; }
  const icsBlocks = [...xml.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/g)].map(m =>
    m[1].replace('<![CDATA[', '').replace(']]>', '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  for (const ics of icsBlocks) {
    const parsed = ical.sync.parseICS(ics);
    for (const key of Object.keys(parsed)) {
      const item = parsed[key];
      if (item.type !== 'VEVENT') continue;
      const summary = textOf(item.summary) || 'Untitled';
      const location = textOf(item.location);
      const allDay = item.datetype === 'date';

      if (item.rrule) {
        const excluded = exdateSet(item);
        const duration = (item.end?.getTime() ?? item.start.getTime()) - item.start.getTime();
        const occurrences = item.rrule.between(now, horizon, true);
        for (const occ of occurrences) {
          if (excluded && excluded.has(occ.getTime())) continue;
          const start = occ, end = new Date(occ.getTime() + duration);
          if (allDay) events.push({ summary, location, allDay: true, startDate: dateOnlyString(start), endDate: addDays(dateOnlyString(end), -1) });
          else events.push({ summary, location, allDay: false, start: start.toISOString(), end: end.toISOString() });
        }
      } else if (allDay) {
        events.push({ summary, location, allDay: true, startDate: dateOnlyString(item.start), endDate: addDays(dateOnlyString(item.end || item.start), -1) });
      } else if (item.start && item.start <= horizon && (item.end || item.start) >= now) {
        events.push({ summary, location, allDay: false, start: item.start.toISOString(), end: (item.end || item.start).toISOString() });
      }
    }
  }
}

events.sort((a, b) => {
  const ak = a.allDay ? a.startDate + 'T00:00:00.000Z' : a.start;
  const bk = b.allDay ? b.startDate + 'T00:00:00.000Z' : b.start;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
});

const output = { events: events.slice(0, MAX_EVENTS), updatedAt: new Date().toISOString() };
writeFileSync('events.json', JSON.stringify(output, null, 2) + '\n');
console.log('Wrote events.json: ' + events.length + ' event(s)');
