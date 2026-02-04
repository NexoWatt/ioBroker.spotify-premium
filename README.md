# ioBroker.spotify-premium

Control **Spotify Premium** playback (Spotify Connect) via the **Spotify Web API**.

## Features
- OAuth login via Admin (Authorization Code + PKCE)
- Poll current playback state
- Control playback: play/pause/toggle/next/prev/volume/shuffle/repeat/seek/playUri/addToQueue/transfer

## Spotify requirements
- Spotify Premium is required for certain playback-control endpoints.
- You must create a Spotify Developer App (Client ID, optional Client Secret) and whitelist your Redirect URI.

**Redirect URI requirements** (Spotify):
- Use **HTTPS** unless using a loopback IP literal like `http://127.0.0.1:PORT`
- `localhost` is **not allowed**

## Setup (recommended)
1. Create a Spotify developer app and add Redirect URI, e.g. `https://<iobroker-ip>:8888/callback`
2. Configure adapter instance: Client ID + Redirect URI (Secret optional)
3. Start instance
4. In instance config click **MIT SPOTIFY VERBINDEN** and login

If you use HTTPS with self-signed cert: open the callback URL once manually to accept the cert in the browser.

## Notes
This is a generated adapter repo meant as a starting point.
