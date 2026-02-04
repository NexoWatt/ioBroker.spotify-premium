'use strict';

/*
 * ioBroker.spotify-premium
 * Control Spotify Premium playback via Spotify Web API (Spotify Connect)
 * OAuth login (Authorization Code + PKCE) via Admin.
 */

const utils = require('@iobroker/adapter-core');
const { SpotifyClient } = require('./lib/spotifyClient');

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

let selfsigned = null;
try {
    selfsigned = require('selfsigned');
} catch {
    selfsigned = null;
}

function base64UrlEncode(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function sha256Base64Url(str) {
    const hash = crypto.createHash('sha256').update(str).digest();
    return base64UrlEncode(hash);
}

function safeUrl(url) {
    try {
        // Ensure URL is valid
        return new URL(url).toString();
    } catch {
        return '';
    }
}

class SpotifyPremiumAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'spotify-premium',
        });

        this.spotify = null;
        this.pollTimer = null;
        this.commandQueue = Promise.resolve();

        // OAuth state -> verifier (and runtime config) map
        this.oauthStates = new Map(); // state -> { codeVerifier, createdAt, clientId, redirectUri }
        this.server = null;
        this.serverInfo = null; // { protocol, port, path }
        this.serverRuntimeConfig = null; // { generateSelfSignedCert: boolean }
        this.serverRuntimeConfig = null; // { generateSelfSignedCert }

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        await this.ensureObjectTree();
        this.subscribeStates('control.*');

        // Start callback server if redirect URI configured
        if (this.config.redirectUri) {
            try {
                await this.startCallbackServer();
            } catch (e) {
                this.log.warn(`Callback server not started: ${e?.message || e}`);
            }
        }

        // Init Spotify client if refresh token exists
        if (this.config.clientId && this.config.refreshToken) {
            await this.initSpotifyClient();
        } else {
            this.log.info('Spotify not authenticated yet. Use the Admin button "MIT SPOTIFY VERBINDEN".');
        }

        if (this.spotify) {
            if (this.config.autoRefreshDevicesOnStart) {
                this.queueCommand(() => this.refreshDevices());
            }

            const intervalSec = Math.max(2, Number(this.config.pollInterval) || 5);
            this.log.info(`Polling Spotify playback state every ${intervalSec}s`);
            this.pollTimer = this.setInterval(() => {
                this.queueCommand(() => this.pollPlayback());
            }, intervalSec * 1000);

            this.queueCommand(() => this.pollPlayback());
        }
    }

    async initSpotifyClient() {
        this.spotify = new SpotifyClient({
            clientId: String(this.config.clientId),
            clientSecret: String(this.config.clientSecret || ''),
            refreshToken: String(this.config.refreshToken || ''),
            log: this.log,
        });

        try {
            await this.spotify.refreshAccessToken();
            await this.setStateAsync('info.connection', true, true);
            this.log.info('Spotify authenticated ✅');
        } catch (e) {
            await this.setStateAsync('info.connection', false, true);
            this.log.error(`Failed to authenticate with Spotify: ${e?.message || e}`);
            this.spotify = null;
        }
    }

    /** Ensure channels + states exist. */
    async ensureObjectTree() {
        await this.setObjectNotExistsAsync('playback', { type: 'channel', common: { name: 'Playback' }, native: {} });
        await this.setObjectNotExistsAsync('control', { type: 'channel', common: { name: 'Control' }, native: {} });
        await this.setObjectNotExistsAsync('devices', { type: 'channel', common: { name: 'Devices' }, native: {} });

        const playbackStates = [
            ['playback.available', { name: 'Playback available (active device)', type: 'boolean', role: 'indicator.state', read: true, write: false, def: false }],
            ['playback.isPlaying', { name: 'Is playing', type: 'boolean', role: 'media.state', read: true, write: false, def: false }],
            ['playback.track', { name: 'Track', type: 'string', role: 'media.title', read: true, write: false, def: '' }],
            ['playback.artist', { name: 'Artist', type: 'string', role: 'media.artist', read: true, write: false, def: '' }],
            ['playback.album', { name: 'Album', type: 'string', role: 'media.album', read: true, write: false, def: '' }],
            ['playback.uri', { name: 'URI', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['playback.contextUri', { name: 'Context URI', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['playback.progressMs', { name: 'Progress (ms)', type: 'number', role: 'value.time', read: true, write: false, def: 0, unit: 'ms' }],
            ['playback.durationMs', { name: 'Duration (ms)', type: 'number', role: 'value.time', read: true, write: false, def: 0, unit: 'ms' }],
            ['playback.shuffle', { name: 'Shuffle', type: 'boolean', role: 'switch', read: true, write: false, def: false }],
            ['playback.repeat', { name: 'Repeat', type: 'string', role: 'text', read: true, write: false, def: 'off' }],
            ['playback.volume', { name: 'Volume (%)', type: 'number', role: 'level.volume', read: true, write: false, def: 0, unit: '%' }],
            ['playback.deviceName', { name: 'Device name', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['playback.deviceId', { name: 'Device id', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['playback.deviceType', { name: 'Device type', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['playback.deviceIsActive', { name: 'Device is active', type: 'boolean', role: 'indicator.state', read: true, write: false, def: false }],
        ];

        for (const [id, common] of playbackStates) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        }

        await this.setObjectNotExistsAsync('devices.json', {
            type: 'state',
            common: { name: 'Available devices (JSON)', type: 'string', role: 'json', read: true, write: false, def: '[]' },
            native: {},
        });

        const controlStates = [
            ['control.play', { name: 'Play', type: 'boolean', role: 'button.play', read: true, write: true, def: false }],
            ['control.pause', { name: 'Pause', type: 'boolean', role: 'button.pause', read: true, write: true, def: false }],
            ['control.toggle', { name: 'Toggle play/pause', type: 'boolean', role: 'button', read: true, write: true, def: false }],
            ['control.next', { name: 'Next', type: 'boolean', role: 'button.next', read: true, write: true, def: false }],
            ['control.previous', { name: 'Previous', type: 'boolean', role: 'button.prev', read: true, write: true, def: false }],
            ['control.volume', { name: 'Set volume (%)', type: 'number', role: 'level.volume', read: true, write: true, def: 0, min: 0, max: 100, unit: '%' }],
            ['control.shuffle', { name: 'Set shuffle', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
            ['control.repeat', { name: 'Set repeat (off|context|track)', type: 'string', role: 'text', read: true, write: true, def: 'off' }],
            ['control.seek', { name: 'Seek to position (ms)', type: 'number', role: 'value.time', read: true, write: true, def: 0, unit: 'ms' }],
            ['control.playUri', { name: 'Play URI (track/playlist/album/artist)', type: 'string', role: 'text', read: true, write: true, def: '' }],
            ['control.addToQueue', { name: 'Add to queue (URI)', type: 'string', role: 'text', read: true, write: true, def: '' }],
            ['control.transferToDevice', { name: 'Transfer playback to deviceId', type: 'string', role: 'text', read: true, write: true, def: '' }],
            ['control.refreshDevices', { name: 'Refresh devices list', type: 'boolean', role: 'button', read: true, write: true, def: false }],
        ];

        for (const [id, common] of controlStates) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        }
    }

    /** Serialize command executions. */
    queueCommand(fn) {
        this.commandQueue = this.commandQueue
            .then(() => fn())
            .catch((e) => {
                if (this.config.logApiErrors) {
                    this.log.error(`Command failed: ${e?.stack || e}`);
                } else {
                    this.log.warn(`Command failed: ${e?.message || e}`);
                }
            });
    }

    /**
     * Merge saved config with runtime values passed from Admin via jsonData.
     * This is important because users may click "MIT SPOTIFY VERBINDEN" before pressing "Speichern".
     */
    getEffectiveConfigFromMessage(message) {
        const m = (message && typeof message === 'object') ? message : {};

        const out = {
            clientId: (typeof m.clientId === 'string' ? m.clientId : this.config.clientId) || '',
            clientSecret: (typeof m.clientSecret === 'string' ? m.clientSecret : this.config.clientSecret) || '',
            redirectUri: (typeof m.redirectUri === 'string' ? m.redirectUri : this.config.redirectUri) || '',
            callbackBindIp: (typeof m.callbackBindIp === 'string' ? m.callbackBindIp : this.config.callbackBindIp) || '0.0.0.0',
            generateSelfSignedCert: (typeof m.generateSelfSignedCert === 'boolean' ? m.generateSelfSignedCert : !!this.config.generateSelfSignedCert),
        };

        return {
            ...out,
            clientId: String(out.clientId).trim(),
            clientSecret: String(out.clientSecret).trim(),
            redirectUri: String(out.redirectUri).trim(),
            callbackBindIp: String(out.callbackBindIp).trim() || '0.0.0.0',
        };
    }

    async pollPlayback() {
        if (!this.spotify) return;

        const playback = await this.spotify.getPlaybackState();
        if (!playback) {
            await this.setStateAsync('playback.available', false, true);
            await this.setStateAsync('playback.isPlaying', false, true);
            return;
        }

        await this.setStateAsync('playback.available', true, true);
        await this.setStateAsync('playback.isPlaying', !!playback.is_playing, true);

        const item = playback.item || null;
        const track = item?.name || '';
        const artists = Array.isArray(item?.artists) ? item.artists.map((a) => a?.name).filter(Boolean).join(', ') : '';
        const album = item?.album?.name || '';
        const uri = item?.uri || '';
        const contextUri = playback?.context?.uri || '';

        await this.setStateAsync('playback.track', track, true);
        await this.setStateAsync('playback.artist', artists, true);
        await this.setStateAsync('playback.album', album, true);
        await this.setStateAsync('playback.uri', uri, true);
        await this.setStateAsync('playback.contextUri', contextUri, true);

        await this.setStateAsync('playback.progressMs', Number(playback.progress_ms) || 0, true);
        await this.setStateAsync('playback.durationMs', Number(item?.duration_ms) || 0, true);

        await this.setStateAsync('playback.shuffle', !!playback.shuffle_state, true);
        await this.setStateAsync('playback.repeat', String(playback.repeat_state || 'off'), true);

        const device = playback.device || null;
        await this.setStateAsync('playback.volume', Number(device?.volume_percent) || 0, true);
        await this.setStateAsync('playback.deviceName', String(device?.name || ''), true);
        await this.setStateAsync('playback.deviceId', String(device?.id || ''), true);
        await this.setStateAsync('playback.deviceType', String(device?.type || ''), true);
        await this.setStateAsync('playback.deviceIsActive', !!device?.is_active, true);
    }

    async refreshDevices() {
        if (!this.spotify) return;
        const devices = await this.spotify.getDevices();
        await this.setStateAsync('devices.json', JSON.stringify(devices, null, 2), true);
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        if (!this.spotify) return;

        const rel = id.startsWith(this.namespace + '.') ? id.substring(this.namespace.length + 1) : id;
        if (!rel.startsWith('control.')) return;

        const deviceId = this.config.defaultDeviceId ? String(this.config.defaultDeviceId) : undefined;

        const resetButton = async (stateId) => {
            await this.setStateAsync(stateId, false, true);
        };

        const val = state.val;

        this.queueCommand(async () => {
            switch (rel) {
                case 'control.play':
                    await this.spotify.play({ deviceId });
                    await resetButton('control.play');
                    break;
                case 'control.pause':
                    await this.spotify.pause({ deviceId });
                    await resetButton('control.pause');
                    break;
                case 'control.toggle': {
                    const isPlayingState = await this.getStateAsync('playback.isPlaying');
                    const isPlaying = !!isPlayingState?.val;
                    if (isPlaying) {
                        await this.spotify.pause({ deviceId });
                    } else {
                        await this.spotify.play({ deviceId });
                    }
                    await resetButton('control.toggle');
                    break;
                }
                case 'control.next':
                    await this.spotify.next({ deviceId });
                    await resetButton('control.next');
                    break;
                case 'control.previous':
                    await this.spotify.previous({ deviceId });
                    await resetButton('control.previous');
                    break;
                case 'control.volume': {
                    const v = Math.max(0, Math.min(100, Number(val)));
                    if (Number.isFinite(v)) {
                        await this.spotify.setVolume(v, { deviceId });
                        await this.setStateAsync('control.volume', v, true);
                    }
                    break;
                }
                case 'control.shuffle': {
                    const s = !!val;
                    await this.spotify.setShuffle(s, { deviceId });
                    await this.setStateAsync('control.shuffle', s, true);
                    break;
                }
                case 'control.repeat': {
                    const r = String(val || '').toLowerCase();
                    const allowed = new Set(['off', 'track', 'context']);
                    const rr = allowed.has(r) ? r : 'off';
                    await this.spotify.setRepeat(rr, { deviceId });
                    await this.setStateAsync('control.repeat', rr, true);
                    break;
                }
                case 'control.seek': {
                    const pos = Math.max(0, Number(val));
                    if (Number.isFinite(pos)) {
                        await this.spotify.seek(pos, { deviceId });
                        await this.setStateAsync('control.seek', pos, true);
                    }
                    break;
                }
                case 'control.playUri': {
                    const uri = String(val || '').trim();
                    if (uri) {
                        await this.spotify.playUri(uri, { deviceId });
                        await this.setStateAsync('control.playUri', '', true);
                    }
                    break;
                }
                case 'control.addToQueue': {
                    const uri = String(val || '').trim();
                    if (uri) {
                        await this.spotify.addToQueue(uri, { deviceId });
                        await this.setStateAsync('control.addToQueue', '', true);
                    }
                    break;
                }
                case 'control.transferToDevice': {
                    const target = String(val || '').trim();
                    if (target) {
                        await this.spotify.transferPlayback(target, { play: true });
                        await this.setStateAsync('control.transferToDevice', '', true);
                    }
                    break;
                }
                case 'control.refreshDevices':
                    await this.refreshDevices();
                    await resetButton('control.refreshDevices');
                    break;
                default:
                    this.log.debug(`Unhandled control state: ${rel}`);
                    break;
            }
        });
    }

    /**
     * Handle Admin sendTo messages (OAuth buttons).
     */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;

        const respond = (data) => {
            try {
                this.sendTo(obj.from, obj.command, data, obj.callback);
            } catch (e) {
                this.log.warn(`Failed to respond to message: ${e?.message || e}`);
            }
        };

        try {
            const cfg = this.getEffectiveConfigFromMessage(obj.message);
            switch (obj.command) {
                case 'oauthGetUrl': {
                    const url = await this.generateAuthUrl(cfg);
                    if (!url) return respond('Cannot generate auth URL (check clientId/redirectUri).');
                    return respond(url);
                }

                case 'oauthConnect': {
                    // ensure callback server (start based on current UI values, even if not saved)
                    await this.startCallbackServer(cfg);

                    const url = await this.generateAuthUrl(cfg);
                    if (!url) return respond({ openUrl: '', error: 'Cannot generate auth URL' });

                    // openUrl is handled by Admin jsonConfig if openUrl=true on the button
                    return respond({ openUrl: url, window: 'spotify' });
                }

                case 'oauthDisconnect': {
                    await this.clearTokens();
                    return respond({ reloadBrowser: true });
                }

                default:
                    return respond({ error: `Unknown command: ${obj.command}` });
            }
        } catch (e) {
            this.log.warn(`onMessage ${obj.command} failed: ${e?.message || e}`);
            return respond({ error: e?.message || String(e) });
        }
    }

    cleanupOldOauthStates() {
        const now = Date.now();
        for (const [state, info] of this.oauthStates.entries()) {
            if (!info?.createdAt || now - info.createdAt > 10 * 60_000) {
                this.oauthStates.delete(state);
            }
        }
    }

    async generateAuthUrl(cfgOverride) {
        const cfg = cfgOverride && typeof cfgOverride === 'object' ? cfgOverride : {};
        const clientId = String(cfg.clientId || this.config.clientId || '').trim();
        const redirectUri = safeUrl(String(cfg.redirectUri || this.config.redirectUri || '').trim());

        if (!clientId || !redirectUri) return '';

        this.cleanupOldOauthStates();

        const state = base64UrlEncode(crypto.randomBytes(16));
        const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
        const codeChallenge = sha256Base64Url(codeVerifier);

        this.oauthStates.set(state, { codeVerifier, createdAt: Date.now(), clientId, redirectUri });

        const scope = [
            'user-read-playback-state',
            'user-modify-playback-state',
            'user-read-currently-playing'
        ].join(' ');

        const url = new URL('https://accounts.spotify.com/authorize');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', state);
        url.searchParams.set('scope', scope);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('code_challenge', codeChallenge);

        return url.toString();
    }

    async startCallbackServer(cfgOverride) {
        const cfg = cfgOverride && typeof cfgOverride === 'object' ? cfgOverride : {};

        const redirectUriStr = String(cfg.redirectUri || this.config.redirectUri || '').trim();
        if (!redirectUriStr) throw new Error('redirectUri missing');

        let u;
        try {
            u = new URL(redirectUriStr);
        } catch {
            throw new Error('redirectUri is not a valid URL');
        }

        const protocol = u.protocol;
        const cbPath = u.pathname || '/callback';
        const port = Number(u.port || (protocol === 'https:' ? 443 : 80));
        const bindIp = String(cfg.callbackBindIp || this.config.callbackBindIp || '0.0.0.0');

        // If server already running but config changed, restart it
        if (this.server && this.serverInfo) {
            const same = this.serverInfo.protocol === protocol
                && this.serverInfo.port === port
                && this.serverInfo.path === cbPath
                && this.serverInfo.bindIp === bindIp;
            if (same) {
                return;
            }

            this.log.info(`Callback server config changed -> restarting (${this.serverInfo.protocol}//:${this.serverInfo.port}${this.serverInfo.path} -> ${protocol}//:${port}${cbPath})`);
            await new Promise((resolve) => {
                try {
                    this.server.close(() => resolve());
                } catch {
                    resolve();
                }
            });
            this.server = null;
            this.serverInfo = null;
        }

        this.serverRuntimeConfig = {
            generateSelfSignedCert: typeof cfg.generateSelfSignedCert === 'boolean'
                ? cfg.generateSelfSignedCert
                : !!this.config.generateSelfSignedCert,
        };

        this.serverInfo = { protocol, port, path: cbPath, bindIp };

        const requestHandler = (req, res) => {
            try {
                const reqUrl = new URL(req.url || '/', `${protocol}//${req.headers.host || 'localhost'}`);

                if (reqUrl.pathname !== cbPath) {
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(`Spotify Premium Adapter callback server is running.\nUse path: ${cbPath}`);
                    return;
                }

                const error = reqUrl.searchParams.get('error');
                const code = reqUrl.searchParams.get('code');
                const state = reqUrl.searchParams.get('state');

                if (error) {
                    this.log.warn(`OAuth error from Spotify: ${error}`);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(this.renderHtml(`❌ Spotify Login fehlgeschlagen`, `Spotify hat einen Fehler zurückgegeben: <b>${error}</b>.<br/>Du kannst dieses Fenster schließen.`));
                    return;
                }

                if (!code || !state) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(this.renderHtml('Spotify OAuth Callback', 'Warte auf Spotify Redirect...'));
                    return;
                }

                // Handle exchange async
                this.handleOAuthCallback({ code, state })
                    .then((msg) => {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(this.renderHtml('✅ Spotify verbunden', msg));
                    })
                    .catch((e) => {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(this.renderHtml('❌ Spotify Login fehlgeschlagen', `${e?.message || e}`));
                    });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Internal error: ${e?.message || e}`);
            }
        };

        if (protocol === 'https:') {
            const { key, cert } = await this.getHttpsKeyCert(u.hostname);
            this.server = https.createServer({ key, cert }, requestHandler);
        } else if (protocol === 'http:') {
            this.server = http.createServer(requestHandler);
        } else {
            throw new Error(`Unsupported protocol in redirectUri: ${protocol}`);
        }

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, bindIp, () => {
                this.server.off('error', reject);
                resolve();
            });
        });

        this.log.info(`Callback server listening on ${bindIp}:${port}${cbPath} (${protocol.replace(':', '')})`);
    }

    async getHttpsKeyCert(hostname) {
        // Persist cert/key in adapter data dir
        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        const keyPath = path.join(dataDir, 'spotify-premium.key.pem');
        const certPath = path.join(dataDir, 'spotify-premium.cert.pem');

        try {
            fs.mkdirSync(dataDir, { recursive: true });
        } catch {
            // ignore
        }

        const exists = fs.existsSync(keyPath) && fs.existsSync(certPath);
        if (exists) {
            return {
                key: fs.readFileSync(keyPath),
                cert: fs.readFileSync(certPath),
            };
        }

        const allowSelfSigned = this.serverRuntimeConfig
            ? !!this.serverRuntimeConfig.generateSelfSignedCert
            : !!this.config.generateSelfSignedCert;

        if (!allowSelfSigned) {
            throw new Error('HTTPS redirectUri configured but no certificate exists and generateSelfSignedCert is disabled');
        }

        if (!selfsigned) {
            throw new Error('Package "selfsigned" is not available to generate a certificate');
        }

        const cn = hostname || 'iobroker';
        const attrs = [{ name: 'commonName', value: cn }];

        const altNames = [];
        // DNS
        if (hostname && net.isIP(hostname) === 0) {
            altNames.push({ type: 2, value: hostname });
        }
        // IP
        if (hostname && net.isIP(hostname) !== 0) {
            altNames.push({ type: 7, ip: hostname });
        }
        // Always add localhost as DNS
        altNames.push({ type: 2, value: 'localhost' });
        const pems = selfsigned.generate(attrs, {
            keySize: 2048,
            days: 3650,
            algorithm: 'sha256',
            extensions: [
                {
                    name: 'subjectAltName',
                    altNames,
                },
            ],
        });

        fs.writeFileSync(keyPath, pems.private);
        fs.writeFileSync(certPath, pems.cert);

        this.log.warn(`Generated self-signed certificate for HTTPS callback. Browser will show a warning on first visit.`);

        return { key: pems.private, cert: pems.cert };
    }

    renderHtml(title, bodyHtml) {
        return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .box { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 18px; }
    h2 { margin-top: 0; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>${title}</h2>
    <div>${bodyHtml}</div>
    <p style="margin-top:18px;color:#666;font-size:13px;">Du kannst dieses Fenster schließen.</p>
    <script>
      // Try to close window (may be blocked by browser)
      setTimeout(() => { try { window.close(); } catch(e) {} }, 1500);
    </script>
  </div>
</body>
</html>`;
    }

    async handleOAuthCallback({ code, state }) {
        const entry = this.oauthStates.get(state);
        if (!entry) {
            throw new Error('Invalid or expired state. Please start login again from ioBroker Admin.');
        }

        const clientId = String(entry.clientId || this.config.clientId || '').trim();
        const redirectUri = safeUrl(String(entry.redirectUri || this.config.redirectUri || '').trim());
        const codeVerifier = entry.codeVerifier;

        this.oauthStates.delete(state);

        // Exchange authorization code for tokens
        const tokenUrl = 'https://accounts.spotify.com/api/token';
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: codeVerifier,
        });

        const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!res.ok) {
            const msg = data?.error_description || data?.error || text || res.statusText;
            throw new Error(`Token exchange failed (${res.status}): ${msg}`);
        }

        const refreshToken = data?.refresh_token;
        if (!refreshToken) {
            throw new Error('Spotify did not return a refresh_token. Ensure you used Authorization Code + PKCE flow and scopes are correct.');
        }

        await this.saveRefreshToken({ refreshToken, clientId, redirectUri });

        // (Re)initialize Spotify client
        await this.initSpotifyClient();

        return `Spotify ist jetzt verbunden ✅<br/>Zurück zu ioBroker Admin → Instanz-Einstellungen. Falls der Refresh-Token im Feld noch leer aussieht: Seite einmal neu laden (F5).`;
    }

    async saveRefreshToken({ refreshToken, clientId, redirectUri }) {
        const token = String(refreshToken);
        const cid = String(clientId || '').trim();
        const ruri = String(redirectUri || '').trim();

        // Update in-memory config for the running instance
        this.config.refreshToken = token;
        if (cid) this.config.clientId = cid;
        if (ruri) this.config.redirectUri = ruri;

        const id = `system.adapter.${this.namespace}`;
        const obj = await this.getForeignObjectAsync(id);
        if (!obj) throw new Error(`Cannot load instance object ${id}`);

        obj.native = obj.native || {};

        // Store plain; js-controller/admin will auto-encrypt fields listed in encryptedNative.
        obj.native.refreshToken = token;
        if (cid) obj.native.clientId = cid;
        if (ruri) obj.native.redirectUri = ruri;
        await this.setForeignObjectAsync(id, obj);

        this.log.info('Refresh token stored in instance configuration.');
    }

    async clearTokens() {
        const id = `system.adapter.${this.namespace}`;
        const obj = await this.getForeignObjectAsync(id);
        if (!obj) return;

        obj.native = obj.native || {};
        obj.native.refreshToken = '';
        await this.setForeignObjectAsync(id, obj);

        this.config.refreshToken = '';
        this.spotify = null;
        await this.setStateAsync('info.connection', false, true);

        this.log.info('Spotify connection removed (refresh token cleared).');
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) this.clearInterval(this.pollTimer);
            if (this.server) {
                try {
                    this.server.close();
                } catch {
                    // ignore
                }
                this.server = null;
            }
            this.setState('info.connection', false, true);
            callback();
        } catch {
            callback();
        }
    }
}

if (module.parent) {
    module.exports = (options) => new SpotifyPremiumAdapter(options);
} else {
    new SpotifyPremiumAdapter();
}
