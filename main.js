'use strict';

/*
 * ioBroker.spotify-premium
 * Control Spotify Premium playback via Spotify Web API (Spotify Connect)
 */

const utils = require('@iobroker/adapter-core');
const { SpotifyClient } = require('./lib/spotifyClient');

class SpotifyPremiumAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'spotify-premium',
        });

        this.spotify = null;
        this.pollTimer = null;
        this.commandQueue = Promise.resolve();

        this.on('ready', this.onReady.bind(this));
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
        if (!clientId || !clientSecret || !refreshToken) {
            this.log.warn('Adapter not configured yet (clientId/clientSecret/refreshToken missing). Please open the instance settings.');
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
