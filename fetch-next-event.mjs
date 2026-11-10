// Fetches the next upcoming iCloud calendar event and writes a small public JSON file
// for the CleanFrame TV app to poll. Runs server-side (GitHub Actions) specifically
// because Apple's CalDAV servers send no CORS headers, so a browser (the TV included)
// can never read these responses directly.
import { writeFileSync } from 'node:fs';
import ical from 'node-ical';

const EMAIL = process.env.ICLOUD_EMAIL;
const PASSWORD = process.env.ICLOUD_APP_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD env vars');

const AUTH = 'Basic ' + Buffer.from(EMAIL + ':' + PASSWORD).toString('base64');

async function dav(url, method, body, depth) {
  const headers = { 'Content-Type': 'application/xml', Authorization: AUTH };
  if (depth !== undefined) headers.Depth = String(depth);
  const response = await fetch(url, { method, headers, body });
  if (!response.ok && response.status !== 207) {
    throw new Error(method + ' ' + url + ' failed: ' + response.status + ' ' + (await response.text()).slice(0, 300));
  }
  return response.text();
}

function extract(xml, tag) {
  const matches = [...xml.matchAll(new RegExp('<' + tag + '[^>]*>([^<]*)</' + tag + '>', 'g'))];
  return matches.map(m => m[1]);
}
// Finds the <href> nested specifically inside the named wrapper element, not any sibling href
// (PROPFIND responses repeat <href> for the resource itself and again for each prop value).
function hrefInside(xml, wrapperTag) {
  const wrapper = xml.match(new RegExp('<' + wrapperTag + '[^>]*>([\\s\\S]*?)</' + wrapperTag + '>'));
  if (!wrapper) return null;
  return extract(wrapper[1], 'href')[0] || null;
}

// Step 1: discover the principal URL.
const principalXml = await dav('https://caldav.icloud.com/', 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/></A:prop></A:propfind>', 0);
const principalPath = hrefInside(principalXml, 'current-user-principal');
if (!principalPath) throw new Error('Could not discover principal URL');

// Step 2: discover the sharded calendar-home-set URL.
const homeXml = await dav('https://caldav.icloud.com' + principalPath, 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><C:calendar-home-set/></A:prop></A:propfind>', 0);
const homeUrl = hrefInside(homeXml, 'calendar-home-set');
if (!homeUrl) throw new Error('Could not discover calendar-home-set');

// Step 3: list calendars under the home collection, skip system/non-event collections.
const listXml = await dav(homeUrl, 'PROPFIND',
  '<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><A:displayname/><A:resourcetype/></A:prop></A:propfind>', 1);
const SKIP = new Set(['inbox', 'outbox', 'notification', '']);
const calendarPaths = [...listXml.matchAll(/<response[^>]*>([\s\S]*?)<\/response>/g)]
  .map(m => m[1])
  .filter(block => /<calendar\s*\/?>/.test(block) || /<calendar xmlns/.test(block))
  .map(block => extract(block, 'href')[0])
  .filter(href => href && !SKIP.has(href.replace(/\/$/, '').split('/').pop()));

// Step 4: query each calendar for events in the next 30 days.
const now = new Date();
const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const fmt = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
const events = [];
for (const path of calendarPaths) {
  const url = new URL(path, homeUrl).toString();
  const body = `<?xml version="1.0"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="${fmt(now)}" end="${fmt(horizon)}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
  let xml;
  try { xml = await dav(url, 'REPORT', body, 1); } catch (err) { console.error('Skipping calendar ' + path + ': ' + err.message); continue; }
  const icsBlocks = [...xml.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/g)].map(m =>
    m[1].replace('<![CDATA[', '').replace(']]>', '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  for (const ics of icsBlocks) {
    const parsed = ical.sync.parseICS(ics);
    for (const key of Object.keys(parsed)) {
      const item = parsed[key];
      if (item.type !== 'VEVENT') continue;
      if (item.rrule) {
        const next = item.rrule.after(now, true);
        if (next) {
          const duration = (item.end?.getTime() ?? item.start.getTime()) - item.start.getTime();
          events.push({ summary: item.summary || 'Untitled', start: next, end: new Date(next.getTime() + duration) });
        }
      } else if (item.start && item.start >= now && item.start <= horizon) {
        events.push({ summary: item.summary || 'Untitled', start: item.start, end: item.end || item.start });
      }
    }
  }
}
events.sort((a, b) => a.start - b.start);
const next = events[0];

const output = next
  ? { summary: String(next.summary).slice(0, 120), start: next.start.toISOString(), end: next.end.toISOString(), updatedAt: new Date().toISOString() }
  : { summary: null, start: null, end: null, updatedAt: new Date().toISOString() };

writeFileSync('next-event.json', JSON.stringify(output, null, 2) + '\n');
console.log('Wrote next-event.json:', output);
