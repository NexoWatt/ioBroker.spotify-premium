'use strict';

/*
 * ioBroker.spotify-premium
 * Control Spotify Premium playback via Spotify Web API (Spotify Connect)
 */

const utils = require('@iobroker/adapter-core');
const { SpotifyClient } = require('./lib/spotifyClient');

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const net = require('node:net');

class SpotifyPremiumAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'spotify-premium',
        });

        this.spotify = null;
        this.pollTimer = null;
        this.commandQueue = Promise.resolve();

        // OAuth helper web server (callback receiver)
        this.oauthServer = null;
        this.oauthServerInfo = null;
        this.oauthFlow = null;

        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Reset connection indicator
        await this.setStateAsync('info.connection', false, true);

        // Create object tree
        await this.ensureObjectTree();

        // Subscribe to control states
        this.subscribeStates('control.*');

        // Basic config check
        const { clientId, clientSecret, refreshToken, redirectUri } = this.config;

        if (!clientId || !clientSecret || !redirectUri) {
            this.log.warn(
                'Adapter not configured yet (clientId/clientSecret/redirectUri missing). Please open the instance settings and configure the Spotify app credentials.'
            );
            return;
        }

        if (!refreshToken) {
            this.log.warn(
                'Not connected to Spotify yet (refreshToken missing). Open the instance settings and click "Mit Spotify verbinden".'
            );
            return;
        }

        this.spotify = new SpotifyClient({
            clientId: String(clientId),
            clientSecret: String(clientSecret),
            refreshToken: String(refreshToken),
            redirectUri: String(redirectUri || ''),
            log: this.log,
        });

        try {
            await this.spotify.refreshAccessToken();
            await this.setStateAsync('info.connection', true, true);
        } catch (e) {
            this.log.error(`Failed to authenticate with Spotify: ${e?.message || e}`);
            await this.setStateAsync('info.connection', false, true);
            return;
        }

        // Optional: refresh device list on start
        if (this.config.autoRefreshDevicesOnStart) {
            this.queueCommand(() => this.refreshDevices());
        }

        // Start polling playback state
        const intervalSec = Math.max(2, Number(this.config.pollInterval) || 5);
        this.log.info(`Polling Spotify playback state every ${intervalSec}s`);
        this.pollTimer = this.setInterval(() => {
            this.queueCommand(() => this.pollPlayback());
        }, intervalSec * 1000);

        // Initial poll
        this.queueCommand(() => this.pollPlayback());
    }

    /**
     * Ensure channels + states exist.
     */
    async ensureObjectTree() {
        // Channels
        await this.setObjectNotExistsAsync('playback', {
            type: 'channel',
            common: { name: 'Playback' },
            native: {},
        });

        await this.setObjectNotExistsAsync('control', {
            type: 'channel',
            common: { name: 'Control' },
            native: {},
        });

        await this.setObjectNotExistsAsync('devices', {
            type: 'channel',
            common: { name: 'Devices' },
            native: {},
        });

        // Playback states (read-only)
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
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common,
                native: {},
            });
        }

        // Devices
        await this.setObjectNotExistsAsync('devices.json', {
            type: 'state',
            common: {
                name: 'Available devices (JSON)',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
            },
            native: {},
        });

        // Control states
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
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    /**
     * Serialize command executions to avoid race conditions / hitting rate limits.
     */
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
     * Poll playback state from Spotify and update ioBroker states.
     */
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
        const jsonStr = JSON.stringify(devices, null, 2);
        await this.setStateAsync('devices.json', jsonStr, true);
    }

    /**
     * Handle admin UI sendTo requests (JSON config).
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (!obj || !obj.command) return;

        const command = obj.command;
        const message = obj.message || {};
        const reply = (payload) =>
            obj.callback && this.sendTo(obj.from, obj.command, payload, obj.callback);

        try {
            switch (command) {
                case 'oauthStart':
                    reply(await this.oauthStart(message));
                    break;

                case 'oauthStatus':
                    reply(await this.oauthStatus());
                    break;

                case 'oauthDisconnect':
                    reply(await this.oauthDisconnect());
                    break;

                case 'listDevices':
                    reply(await this.listDevices());
                    break;

                default:
                    // Ignore unknown commands
                    break;
            }
        } catch (e) {
            const errText = e && e.message ? e.message : String(e);
            this.log.error(`onMessage(${command}) failed: ${errText}`);
            if (command === 'oauthStatus') {
                reply({ text: `❌ Fehler: ${errText}`, icon: 'no-connection' });
            } else if (command === 'listDevices') {
                reply([]);
            } else {
                reply({ error: errText });
            }
        }
    }

    /**
     * Creates an authorization URL and returns it to the admin UI.
     * It also starts an HTTP/HTTPS callback server that receives the Spotify redirect.
     * @param {Record<string, any>} msg
     */
    async oauthStart(msg) {
        const clientId = String(msg.clientId ?? this.config.clientId ?? '').trim();
        const clientSecret = String(msg.clientSecret ?? this.config.clientSecret ?? '').trim();
        const redirectUri = String(msg.redirectUri ?? this.config.redirectUri ?? '').trim();
        const bind = String(msg.bind ?? this.config.bind ?? '0.0.0.0').trim() || '0.0.0.0';
        const useSelfSignedCert =
            typeof msg.useSelfSignedCert === 'boolean'
                ? msg.useSelfSignedCert
                : !!this.config.useSelfSignedCert;

        if (!clientId || !clientSecret) {
            throw new Error('Bitte Spotify Client ID und Client Secret eintragen und speichern.');
        }
        if (!redirectUri) {
            throw new Error('Bitte Redirect URI (Callback URL) eintragen und speichern.');
        }

        let redirect;
        try {
            redirect = new URL(redirectUri);
        } catch (e) {
            throw new Error(`Redirect URI ist ungültig: ${redirectUri}`);
        }

        const protocol = (redirect.protocol || '').replace(':', '');
        if (protocol !== 'http' && protocol !== 'https') {
            throw new Error('Redirect URI muss mit http:// oder https:// beginnen.');
        }

        const port = redirect.port ? Number(redirect.port) : protocol === 'https' ? 443 : 80;
        if (!Number.isFinite(port) || port <= 0) {
            throw new Error('Redirect URI muss einen gültigen Port enthalten (z.B. :8888).');
        }
        if (port < 1024) {
            this.log.warn(
                `Redirect URI nutzt einen privilegierten Port (${port}). Das funktioniert meist nur mit Root/Capabilities oder Reverse Proxy. Empfehlung: >1024 (z.B. 8888).`
            );
        }

        // Ensure callback server is running before opening the auth URL
        await this.ensureOAuthServer({
            protocol,
            port,
            bind,
            callbackPath: redirect.pathname || '/',
            hostnameForCert: redirect.hostname,
            useSelfSignedCert,
        });

        // Create state (CSRF protection)
        const state = crypto.randomBytes(16).toString('hex');
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
        this.oauthFlow = {
            state,
            expiresAt,
            clientId,
            clientSecret,
            redirectUri: redirect.toString(),
            callbackPath: redirect.pathname || '/',
        };

        // Scopes needed for playback control
        const scopes = [
            'user-read-playback-state',
            'user-read-currently-playing',
            'user-modify-playback-state',
        ];

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirect.toString(),
            scope: scopes.join(' '),
            state,
            show_dialog: 'true',
        });

        const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

        return { openUrl: authUrl };
    }

    /**
     * Returns a human readable status for the JSON config UI.
     */
    async oauthStatus() {
        const clientId = String(this.config.clientId || '').trim();
        const clientSecret = String(this.config.clientSecret || '').trim();
        const redirectUri = String(this.config.redirectUri || '').trim();
        const refreshToken = String(this.config.refreshToken || '').trim();

        if (!clientId || !clientSecret) {
            return {
                text: '⚠️ Nicht konfiguriert: Client ID / Client Secret fehlen',
                icon: 'no-connection',
                style: { color: 'orange' },
            };
        }
        if (!redirectUri) {
            return {
                text: '⚠️ Nicht konfiguriert: Redirect URI fehlt',
                icon: 'no-connection',
                style: { color: 'orange' },
            };
        }
        if (!refreshToken) {
            return {
                text: '❌ Nicht verbunden (kein Refresh-Token). Bitte "Mit Spotify verbinden" klicken.',
                icon: 'no-connection',
                style: { color: 'red' },
            };
        }

        // Try to validate the token by refreshing access token once
        try {
            await this.ensureSpotifyClient();
            await this.spotify.refreshAccessToken();
            return { text: '✅ Verbunden', icon: 'connection', style: { color: 'green' } };
        } catch (e) {
            const errText = e && e.message ? e.message : String(e);
            return {
                text: `❌ Token ungültig oder abgelaufen: ${errText}`,
                icon: 'no-connection',
                style: { color: 'red' },
            };
        }
    }

    /**
     * Clears the stored refresh token.
     */
    async oauthDisconnect() {
        // Clear in memory
        this.config.refreshToken = '';
        this.spotify = null;
        this.setState('info.connection', false, true);

        // Persist (encryptedNative will handle encryption)
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
            native: { refreshToken: '' },
        });

        return { native: { refreshToken: '' } };
    }

    /**
     * Returns Spotify Connect devices for selectSendTo.
     */
    async listDevices() {
        try {
            await this.ensureSpotifyClient();
            await this.spotify.refreshAccessToken();
            const devices = await this.spotify.getDevices();

            const items = (devices || []).map((d) => ({
                label: `${d.name} (${d.type}${d.is_active ? ', active' : ''})`,
                value: d.id,
            }));

            if (!items.length) {
                return [{ label: 'Keine Geräte gefunden (Spotify App öffnen?)', value: '' }];
            }

            return items;
        } catch (e) {
            if (this.log && this.log.debug) {
                const errText = e && e.message ? e.message : String(e);
                this.log.debug(`listDevices failed: ${errText}`);
            }
            return [{ label: 'Nicht verbunden / keine Berechtigung', value: '' }];
        }
    }

    async ensureSpotifyClient() {
        if (this.spotify) return;

        const { clientId, clientSecret, refreshToken } = this.config;
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('Adapter ist nicht verbunden oder nicht konfiguriert.');
        }

        this.spotify = new SpotifyClient({
            clientId,
            clientSecret,
            refreshToken,
            redirectUri: this.config.redirectUri,
            logApiErrors: !!this.config.logApiErrors,
            log: this.log,
        });
    }

    /**
     * Starts (or restarts) a small callback server for the OAuth redirect.
     * @param {{protocol:'http'|'https', port:number, bind:string, callbackPath:string, hostnameForCert?:string, useSelfSignedCert:boolean}} opts
     */
    async ensureOAuthServer(opts) {
        const desired = {
            protocol: opts.protocol,
            port: opts.port,
            bind: opts.bind,
            callbackPath: opts.callbackPath || '/callback',
        };

        // If already running with same config, keep it
        if (
            this.oauthServer &&
            this.oauthServerInfo &&
            this.oauthServerInfo.protocol === desired.protocol &&
            this.oauthServerInfo.port === desired.port &&
            this.oauthServerInfo.bind === desired.bind &&
            this.oauthServerInfo.callbackPath === desired.callbackPath
        ) {
            return;
        }

        // Close previous server
        if (this.oauthServer) {
            try {
                this.oauthServer.close();
            } catch (e) {
                // ignore
            }
            this.oauthServer = null;
            this.oauthServerInfo = null;
        }

        const handler = (req, res) => {
            this.handleOAuthRequest(req, res).catch((e) => {
                const errText = e && e.message ? e.message : String(e);
                this.log.error(`OAuth server request failed: ${errText}`);
                try {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Internal error');
                } catch (e2) {
                    // ignore
                }
            });
        };

        if (desired.protocol === 'https') {
            if (!opts.useSelfSignedCert) {
                throw new Error(
                    'Redirect URI nutzt https, aber Self-Signed Zertifikat ist deaktiviert. Bitte aktivieren oder ein Reverse Proxy mit gültigem Zertifikat verwenden.'
                );
            }

            // Generate a self-signed certificate (browser will show a warning)
            const selfsigned = require('selfsigned');
            const commonName = opts.hostnameForCert || 'localhost';
            const attrs = [{ name: 'commonName', value: commonName }];

            // SubjectAltName: include hostname as DNS, plus loopback IPs and (if possible) hostname as IP.
            const altNames = [{ type: 2, value: commonName }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }];

            // If hostname is an IPv4/IPv6 literal, include it as IP SAN
            if (commonName && net.isIP(commonName)) {
                altNames.push({ type: 7, ip: commonName });
            }

            const pems = await selfsigned.generate(attrs, {
                algorithm: 'sha256',
                extensions: [
                    { name: 'basicConstraints', cA: false, critical: true },
                    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
                    { name: 'extKeyUsage', serverAuth: true },
                    { name: 'subjectAltName', altNames },
                ],
            });

            this.oauthServer = https.createServer({ key: pems.private, cert: pems.cert }, handler);
        } else {
            this.oauthServer = http.createServer(handler);
        }

        await new Promise((resolve, reject) => {
            this.oauthServer.once('error', (err) => reject(err));
            this.oauthServer.listen(desired.port, desired.bind, () => resolve());
        });

        this.oauthServerInfo = desired;
        this.log.info(
            `OAuth callback server listening on ${desired.protocol}://${desired.bind}:${desired.port}${desired.callbackPath}`
        );
    }

    /**
     * Generic request handler for the OAuth callback server.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async handleOAuthRequest(req, res) {
        const method = (req.method || 'GET').toUpperCase();
        const reqUrl = new URL(req.url || '/', 'http://localhost');

        if (method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Method Not Allowed');
            return;
        }

        const callbackPath = this.oauthServerInfo?.callbackPath || '/callback';

        if (reqUrl.pathname === callbackPath) {
            await this.handleOAuthCallback(reqUrl, res);
            return;
        }

        // Default page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
            `<html><body style="font-family: sans-serif;">
            <h2>ioBroker Spotify Premium - OAuth Callback Server</h2>
            <p>Dieser Server wird nur für den Spotify Login benötigt.</p>
            <p>Callback Path: <code>${callbackPath}</code></p>
            </body></html>`
        );
    }

    async handleOAuthCallback(reqUrl, res) {
        const error = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Spotify Login fehlgeschlagen</h2>
                <p>Error: <code>${this.escapeHtml(error)}</code></p>
                <p>Du kannst dieses Fenster schließen.</p>
                </body></html>`
            );
            return;
        }

        if (!code || !state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Ungültiger Callback</h2>
                <p>Es fehlen Parameter (code/state).</p>
                </body></html>`
            );
            return;
        }

        if (!this.oauthFlow || !this.oauthFlow.state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Login-Session nicht gefunden</h2>
                <p>Bitte den Login erneut über ioBroker starten.</p>
                </body></html>`
            );
            return;
        }

        if (Date.now() > (this.oauthFlow.expiresAt || 0)) {
            this.oauthFlow = null;
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Login-Session abgelaufen</h2>
                <p>Bitte den Login erneut starten.</p>
                </body></html>`
            );
            return;
        }

        if (state !== this.oauthFlow.state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Security Check fehlgeschlagen</h2>
                <p>State passt nicht. Bitte den Login erneut starten.</p>
                </body></html>`
            );
            return;
        }

        try {
            const tokenData = await this.exchangeAuthorizationCode(code);

            const newRefresh = tokenData.refresh_token || this.config.refreshToken;
            if (!newRefresh) {
                throw new Error(
                    'Spotify hat kein refresh_token geliefert. Bitte Zugriff entfernen und erneut verbinden.'
                );
            }

            // Persist refresh token
            this.config.refreshToken = newRefresh;

            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { refreshToken: newRefresh },
            });

            // Prepare Spotify client & start polling (optional)
            this.spotify = new SpotifyClient({
                clientId: this.oauthFlow.clientId,
                clientSecret: this.oauthFlow.clientSecret,
                refreshToken: newRefresh,
                redirectUri: this.oauthFlow.redirectUri,
                logApiErrors: !!this.config.logApiErrors,
                log: this.log,
            });

            // Verify token
            await this.spotify.refreshAccessToken();
            this.setState('info.connection', true, true);

            // Start polling if not running
            if (!this.pollTimer) {
                const intervalSec = Math.max(2, Number(this.config.pollInterval) || 5);
                this.log.info(`Polling Spotify playback state every ${intervalSec}s`);
                this.pollTimer = this.setInterval(() => {
                    this.queueCommand(() => this.pollPlayback());
                }, intervalSec * 1000);
            }

            if (this.config.autoRefreshDevicesOnStart) {
                this.queueCommand(() => this.refreshDevices());
            }

            this.oauthFlow = null;

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>✅ Spotify verbunden</h2>
                <p>Du kannst dieses Fenster schließen.</p>
                <p><b>Hinweis:</b> Bitte die ioBroker Admin Konfig-Seite des Adapters einmal neu laden (F5), bevor du speicherst.</p>
                </body></html>`
            );
        } catch (e) {
            const errText = e && e.message ? e.message : String(e);
            this.log.error(`OAuth callback failed: ${errText}`);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<html><body style="font-family: sans-serif;">
                <h2>❌ Fehler beim Token-Austausch</h2>
                <p>${this.escapeHtml(errText)}</p>
                <p>Du kannst dieses Fenster schließen und es erneut versuchen.</p>
                </body></html>`
            );
        }
    }

    async exchangeAuthorizationCode(code) {
        if (!this.oauthFlow) throw new Error('OAuth flow not initialized');

        const tokenUrl = 'https://accounts.spotify.com/api/token';
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.oauthFlow.redirectUri,
        });

        const basic = Buffer.from(
            `${this.oauthFlow.clientId}:${this.oauthFlow.clientSecret}`,
            'utf8'
        ).toString('base64');

        const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = null;
        }

        if (!res.ok) {
            const err = data?.error_description || data?.error || text || res.statusText;
            throw new Error(`Spotify token error: ${err}`);
        }

        if (!data || !data.access_token) {
            throw new Error('Unexpected token response from Spotify.');
        }

        return data;
    }

    escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }


    /**
     * Handle state changes (controls).
     */
    async onStateChange(id, state) {
        if (!state || state.ack) return;
        if (!this.spotify) return;

        // Convert full ID -> relative path within this adapter instance
        const rel = id.startsWith(this.namespace + '.') ? id.substring(this.namespace.length + 1) : id;
        if (!rel.startsWith('control.')) return;

        const deviceId = this.config.defaultDeviceId ? String(this.config.defaultDeviceId) : undefined;

        const resetButton = async (stateId) => {
            // Reset "button" states back to false so they can be triggered again
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

    onUnload(callback) {
        try {
            if (this.pollTimer) this.clearInterval(this.pollTimer);

            if (this.oauthServer) {
                try {
                    this.oauthServer.close();
                } catch (e) {
                    // ignore
                }
                this.oauthServer = null;
                this.oauthServerInfo = null;
                this.oauthFlow = null;
            }

            this.setState('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (module.parent) {
    module.exports = (options) => new SpotifyPremiumAdapter(options);
} else {
    new SpotifyPremiumAdapter();
}
