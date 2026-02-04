# ioBroker.spotify-premium

Steuere **Spotify Premium** (Spotify Connect) über ioBroker via **Spotify Web API**.

> Hinweis: Dieser Adapter **steuert** Spotify (Play/Pause/Next/Device/Volume …).  
> Er ist **kein** eigener Audio-Player. Wenn du ioBroker als *eigene* Spotify-Connect-Quelle nutzen willst, brauchst du zusätzlich einen Player (z.B. einen Browser mit **Web Playback SDK** oder ein externes Spotify-Connect-Gerät).

## Features
- OAuth Login (Authorization Code + PKCE)
- Polling: aktueller Playback-Status / Track / Gerät / Lautstärke
- Steuerung: play/pause/toggle/next/prev/volume/shuffle/repeat/seek/playUri/addToQueue/transfer

## Spotify Voraussetzungen
- Spotify Premium (für einige Playback-Features notwendig)
- Spotify Developer App (Client ID; Client Secret optional)

**Redirect-URI Regeln (Spotify):**
- Nutze **HTTPS**, außer bei Loopback-IP literal wie `http://127.0.0.1:PORT`
- `localhost` ist nicht erlaubt

## Setup
1. Spotify Developer Dashboard → App anlegen → **Redirect URI** hinzufügen, z.B.  
   `https://<iobroker-ip>:8888/callback`
2. Adapter konfigurieren:
   - **Client ID**
   - **Redirect URI**
   - optional **Client Secret** (nicht nötig bei PKCE)
3. **Speichern** und Adapter neu starten
4. In der Instanz-Konfiguration auf **MIT SPOTIFY VERBINDEN** klicken  
   → es öffnet sich deine **Redirect-URI** in einem neuen Tab  
   → der Adapter startet automatisch den Spotify Login (kein Popup-Blocker-Problem)

### HTTPS / Self-Signed Zertifikat
Wenn du HTTPS nutzt und kein eigenes Zertifikat hast, kann der Adapter eins generieren.  
Beim ersten Öffnen der Redirect-URL zeigt der Browser eine Warnung. Einmal akzeptieren → danach passt es.

### Optional: Web Playback SDK / Streaming Scope
Wenn du später einen Browser-Webplayer (Spotify **Web Playback SDK**) nutzen willst, aktiviere in der Config:
- **Web Playback SDK / Streaming Scope (optional)**

Hinweis: Das Web Playback SDK ist „client-side only“ und läuft im Browser:
https://developer.spotify.com/documentation/web-playback-sdk

Scopes:
https://developer.spotify.com/documentation/web-api/concepts/scopes

## Troubleshooting
### „Mit Spotify verbinden“ öffnet nichts
Der neue Flow öffnet die **Redirect-URI** (Callback-URL) – kein Popup.  
Wenn gar nichts passiert:
- Prüfe, ob Redirect-URI korrekt ist und der Adapter läuft
- Öffne die Redirect-URI testweise direkt im Browser

### Spotify Login klappt, aber danach ist kein Token da
- Nach dem Login die Admin-Seite einmal neu laden (F5)
- In die Logs schauen (Adapter-Log)

---
Generated starter adapter.
