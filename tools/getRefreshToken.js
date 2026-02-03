#!/usr/bin/env node
'use strict';

/**
 * tools/getRefreshToken.js
 *
 * One-time helper to obtain a Spotify refresh token using Authorization Code Flow.
 *
 * Docs:
 * - Authorization Code Flow: https://developer.spotify.com/documentation/web-api/tutorials/code-flow
 * - Refreshing tokens: https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
 *
 * Usage:
 *   node tools/getRefreshToken.js --clientId <id> --clientSecret <secret> --redirectUri http://<host>:8888/callback
 *
 * IMPORTANT:
 * - The redirectUri must be whitelisted in your Spotify Developer Dashboard app settings.
 * - The browser will be redirected to the redirectUri. Use your ioBroker host (or reachable hostname/IP),
 *   NOT "localhost", unless you run this script on the same machine you use for the browser.
 */

const http = require('node:http');
const crypto = require('node:crypto');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.substring(2);
        const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
        out[key] = val;
        if (val !== 'true') i++;
    }
    return out;
}

function toBase64(str) {
    return Buffer.from(str, 'utf8').toString('base64');
}

function htmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const auth = toBase64(`${clientId}:${clientSecret}`);

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }

    if (!res.ok) {
        const msg = data?.error_description || data?.error || text || res.statusText;
        throw new Error(`Token exchange failed (${res.status}): ${msg}`);
    }
    return data;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const clientId = args.clientId || process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = args.clientSecret || process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = args.redirectUri || process.env.SPOTIFY_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        console.error('Missing parameters. Provide --clientId, --clientSecret, --redirectUri (or env vars SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_REDIRECT_URI).');
        process.exit(2);
    }

    const scopes = (args.scopes || 'user-read-playback-state user-modify-playback-state user-read-currently-playing').trim();
    const state = crypto.randomBytes(12).toString('hex');

    const redirect = new URL(redirectUri);
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
    const hostname = redirect.hostname;
    const pathname = redirect.pathname || '/callback';

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    console.log('\n=== Spotify Refresh Token Helper ===\n');
    console.log('1) Open this URL in your browser and login/authorize:\n');
    console.log(authUrl.toString() + '\n');
    console.log(`2) Waiting for redirect on ${redirectUri}\n`);

    const server = http.createServer(async (req, res) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (reqUrl.pathname !== pathname) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = reqUrl.searchParams.get('code');
            const st = reqUrl.searchParams.get('state');
            const err = reqUrl.searchParams.get('error');

            if (err) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${err}`);
                console.error(`Authorization error: ${err}`);
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing "code" query parameter.');
                console.error('Missing code in callback.');
                return;
            }

            if (st !== state) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('State mismatch. Aborting.');
                console.error('State mismatch. Aborting.');
                return;
            }

            const tokenData = await exchangeCode({ clientId, clientSecret, code, redirectUri });

            const refreshToken = tokenData.refresh_token || '';
            const accessToken = tokenData.access_token || '';
            const expiresIn = tokenData.expires_in || 0;

            console.log('\n✅ SUCCESS\n');
            console.log('Refresh Token (copy into ioBroker adapter settings):\n');
            console.log(refreshToken + '\n');

            const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Spotify Token</title></head>
<body style="font-family: sans-serif; padding: 24px;">
  <h2>✅ Spotify Token erhalten</h2>
  <p><b>Refresh Token</b> (in den ioBroker Adapter kopieren):</p>
  <pre style="padding: 12px; background: #f5f5f5; white-space: pre-wrap; word-break: break-all;">${htmlEscape(refreshToken)}</pre>
  <p>Access Token (nur zur Info, läuft ab):</p>
  <pre style="padding: 12px; background: #f5f5f5; white-space: pre-wrap; word-break: break-all;">${htmlEscape(accessToken)}</pre>
  <p>expires_in: ${htmlEscape(expiresIn)}</p>
  <p>Du kannst dieses Fenster jetzt schließen.</p>
</body>
</html>`;

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);

            // close server after response
            setTimeout(() => server.close(() => process.exit(0)), 200);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error. See console output.');
            console.error(e);
        }
    });

    server.listen(port, () => {
        console.log(`HTTP server listening on port ${port} (host: ${hostname}, path: ${pathname})`);
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
