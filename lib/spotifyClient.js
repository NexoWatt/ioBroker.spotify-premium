'use strict';

/**
 * Minimal Spotify Web API client (no external dependencies).
 * Supports refresh token grant for:
 *  - Authorization Code flow (client_id + client_secret via Basic auth)
 *  - Authorization Code + PKCE (client_id in body, no client_secret)
 */

const { setTimeout: delay } = require('node:timers/promises');

function toBase64(str) {
    return Buffer.from(str, 'utf8').toString('base64');
}

function buildUrl(base, path, query) {
    const url = new URL(path, base);
    if (query && typeof query === 'object') {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null || v === '') continue;
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}

class SpotifyClient {
    /**
     * @param {{clientId:string, clientSecret?:string, refreshToken:string, log?: any}} opts
     */
    constructor(opts) {
        this.clientId = opts.clientId;
        this.clientSecret = opts.clientSecret || '';
        this.refreshToken = opts.refreshToken;
        this.log = opts.log || console;

        this.accessToken = '';
        this.expiresAt = 0; // epoch ms
        this.refreshInFlight = null;
    }

    setRefreshToken(refreshToken) {
        this.refreshToken = String(refreshToken || '');
    }

    isAccessTokenValid() {
        return this.accessToken && Date.now() < (this.expiresAt - 60_000);
    }

    async ensureAccessToken() {
        if (this.isAccessTokenValid()) return;

        if (!this.refreshInFlight) {
            this.refreshInFlight = this.refreshAccessToken()
                .catch((e) => {
                    throw e;
                })
                .finally(() => {
                    this.refreshInFlight = null;
                });
        }
        await this.refreshInFlight;
    }

    /**
     * Refresh access token.
     * - For PKCE refresh tokens: client_id is required in body
     * - For Authorization Code (confidential client): Basic auth header is used
     */
    async refreshAccessToken() {
        const tokenUrl = 'https://accounts.spotify.com/api/token';

        if (!this.refreshToken) {
            throw new Error('No refreshToken configured');
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken,
        });

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
        };

        if (this.clientSecret) {
            const auth = toBase64(`${this.clientId}:${this.clientSecret}`);
            headers['Authorization'] = `Basic ${auth}`;
        } else {
            body.set('client_id', this.clientId);
        }

        const res = await fetch(tokenUrl, {
            method: 'POST',
            headers,
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
            throw new Error(`Spotify token refresh failed (${res.status}): ${msg}`);
        }

        this.accessToken = data.access_token;
        const expiresInSec = Number(data.expires_in) || 3600;
        this.expiresAt = Date.now() + expiresInSec * 1000;

        // refresh_token might be omitted on refresh. Keep the existing one.
        if (data.refresh_token) {
            this.refreshToken = data.refresh_token;
        }

        this.log?.debug?.(`Spotify access token refreshed (expires in ${expiresInSec}s)`);
    }

    /**
     * Perform a Web API request.
     */
    async api(method, path, opts = {}) {
        await this.ensureAccessToken();

        const url = buildUrl('https://api.spotify.com/v1/', path.replace(/^\//, ''), opts.query);

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
        };

        let body = undefined;
        if (opts.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.body);
        }

        const res = await fetch(url, { method, headers, body });

        if (res.status === 401) {
            await this.refreshAccessToken();
            return this.api(method, path, opts);
        }

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after') || '1');
            this.log?.warn?.(`Spotify rate limited (429). Retrying after ${retryAfter}s`);
            await delay(Math.max(1, retryAfter) * 1000);
            return this.api(method, path, opts);
        }

        if (res.status === 204) {
            return null;
        }

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }

        if (!res.ok) {
            const msg = data?.error?.message || data?.error_description || text || res.statusText;
            const err = new Error(`Spotify API error (${res.status}) ${method} ${path}: ${msg}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }

        return data;
    }

    // Convenience wrappers
    async getPlaybackState() {
        return this.api('GET', '/me/player');
    }

    async getDevices() {
        const data = await this.api('GET', '/me/player/devices');
        return data?.devices || [];
    }

    async play({ deviceId } = {}) {
        const query = deviceId ? { device_id: deviceId } : undefined;
        await this.api('PUT', '/me/player/play', { query });
    }

    async pause({ deviceId } = {}) {
        const query = deviceId ? { device_id: deviceId } : undefined;
        await this.api('PUT', '/me/player/pause', { query });
    }

    async next({ deviceId } = {}) {
        const query = deviceId ? { device_id: deviceId } : undefined;
        await this.api('POST', '/me/player/next', { query });
    }

    async previous({ deviceId } = {}) {
        const query = deviceId ? { device_id: deviceId } : undefined;
        await this.api('POST', '/me/player/previous', { query });
    }

    async setVolume(volumePercent, { deviceId } = {}) {
        const v = Math.max(0, Math.min(100, Number(volumePercent)));
        const query = { volume_percent: v };
        if (deviceId) query.device_id = deviceId;
        await this.api('PUT', '/me/player/volume', { query });
    }

    async setShuffle(enabled, { deviceId } = {}) {
        const query = { state: enabled ? 'true' : 'false' };
        if (deviceId) query.device_id = deviceId;
        await this.api('PUT', '/me/player/shuffle', { query });
    }

    async setRepeat(state, { deviceId } = {}) {
        const query = { state: String(state || 'off') };
        if (deviceId) query.device_id = deviceId;
        await this.api('PUT', '/me/player/repeat', { query });
    }

    async seek(positionMs, { deviceId } = {}) {
        const query = { position_ms: Math.max(0, Number(positionMs) || 0) };
        if (deviceId) query.device_id = deviceId;
        await this.api('PUT', '/me/player/seek', { query });
    }

    async addToQueue(uri, { deviceId } = {}) {
        const query = { uri: String(uri) };
        if (deviceId) query.device_id = deviceId;
        await this.api('POST', '/me/player/queue', { query });
    }

    async transferPlayback(deviceId, { play = true } = {}) {
        const body = {
            device_ids: [String(deviceId)],
            play: !!play,
        };
        await this.api('PUT', '/me/player', { body });
    }

    async playUri(uri, { deviceId } = {}) {
        const clean = String(uri).trim();
        const query = deviceId ? { device_id: deviceId } : undefined;

        const body = clean.includes(':track:') ? { uris: [clean] } : { context_uri: clean };

        await this.api('PUT', '/me/player/play', { query, body });
    }
}

module.exports = { SpotifyClient };
