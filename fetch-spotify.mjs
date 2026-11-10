// Fetches what's currently playing on the owner's Spotify account and writes a small public
// JSON file for the CleanFrame TV app to poll. Uses a long-lived refresh token obtained once
// through the PKCE pairing page (spotify-pair.html); no client secret involved anywhere.
import { writeFileSync } from 'node:fs';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
if (!CLIENT_ID || !REFRESH_TOKEN) throw new Error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_REFRESH_TOKEN env vars');

async function getAccessToken() {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID }).toString()
  });
  const body = await response.json();
  if (!response.ok) throw new Error('Token refresh failed: ' + (body.error_description || body.error || response.status));
  return body.access_token;
}

const accessToken = await getAccessToken();
const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing?additional_types=track', {
  headers: { Authorization: 'Bearer ' + accessToken }
});

let output;
if (response.status === 204) {
  output = { playing: false, track: null, artist: null, album: null, albumArt: null, updatedAt: new Date().toISOString() };
} else if (response.ok) {
  const body = await response.json();
  const item = body.item;
  output = item
    ? {
        playing: !!body.is_playing,
        track: item.name,
        artist: (item.artists || []).map(a => a.name).join(', '),
        album: item.album ? item.album.name : null,
        albumArt: item.album && item.album.images && item.album.images[0] ? item.album.images[0].url : null,
        updatedAt: new Date().toISOString()
      }
    : { playing: false, track: null, artist: null, album: null, albumArt: null, updatedAt: new Date().toISOString() };
} else {
  throw new Error('currently-playing failed: ' + response.status + ' ' + (await response.text()).slice(0, 300));
}

writeFileSync('spotify.json', JSON.stringify(output, null, 2) + '\n');
console.log('Wrote spotify.json:', output);
