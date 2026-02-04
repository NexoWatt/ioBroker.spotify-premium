# ioBroker.spotify-premium

Ein **ioBroker Adapter**, der **Spotify Premium** über die **Spotify Web API (Spotify Connect / Player API)** steuern kann (Play/Pause/Next/Prev/Volume/Shuffle/Repeat/Seek, etc.).

> ⚠️ Hinweis: Die **Player/Connect Endpoints** funktionieren nur mit **Spotify Premium** (z.B. *Start/Resume Playback*, *Transfer Playback*, *Add to Queue*).  
> Außerdem braucht Spotify i.d.R. ein **aktives Gerät** (Spotify App/Connect Device muss laufen).

---

## Features ✅

- Playback Status lesen (aktueller Titel, Artist, Album, Progress, Device, Volume …)
- Steuerung via ioBroker States:
  - Play / Pause / Toggle
  - Next / Previous
  - Volume (0–100)
  - Shuffle, Repeat
  - Seek
  - URI abspielen (Track/Playlist/Album/Artist)
  - In Queue hinzufügen
  - Playback auf Device übertragen
  - Geräte-Liste abrufen (Spotify Connect)

---

## Voraussetzungen

- ioBroker mit Node.js **>= 18**
- Spotify **Premium** Account
- Spotify Developer App (Client ID / Client Secret + Redirect URI)

---

## Spotify Developer App anlegen

1. Im Spotify Developer Dashboard eine App erstellen
2. Unter **Edit Settings → Redirect URIs** eine Redirect URI eintragen, die **exakt** zum Adapter passt.

### Redirect URI Beispiele

**Empfohlen (HTTPS, LAN/DNS):**
```
https://iobroker.lan:8888/callback
```

**Nur wenn Browser direkt auf dem ioBroker-Host läuft (Loopback):**
```
http://127.0.0.1:8888/callback
```

> Hintergrund: Spotify hat die Anforderungen an Redirect URIs verschärft (HTTP ist nur noch für Loopback-Adressen praktikabel). Für typische Heimnetz-Setups ist **HTTPS** der sichere Weg.

---

## Login / Verbindung herstellen (wie “andere Hersteller”) 🔗

1. Adapter installieren & Instanz anlegen
2. In den Instanz-Einstellungen eintragen:
   - **Client ID**
   - **Client Secret**
   - **Redirect URI**
   - optional: Bind-IP (meist `0.0.0.0`)
   - optional: **Self-Signed Zertifikat erzeugen** (wenn Redirect URI `https://...` ist und du kein eigenes Zertifikat nutzt)
3. Instanz starten (muss **online** sein)
4. Button **„Mit Spotify verbinden“** klicken
5. Im Browser bei Spotify anmelden und Zugriff bestätigen
6. Im Callback-Fenster erscheint **„✅ Spotify verbunden“** → Fenster schließen

> 💡 Danach bitte die Konfig-Seite einmal **neu laden (F5)**, bevor du „Speichern“ klickst, damit kein altes (leeres) Token versehentlich überschrieben wird.

---

## Optional: Refresh Token per Script holen (CLI)

Wenn du den Login nicht über die Admin-Oberfläche machen willst, gibt es weiterhin ein Helper-Script:

```
tools/getRefreshToken.js
```

Beispiel:
```bash
cd /opt/iobroker/node_modules/iobroker.spotify-premium
node tools/getRefreshToken.js --clientId "<CLIENT_ID>" --clientSecret "<CLIENT_SECRET>" --redirectUri "https://iobroker.lan:8888/callback"
```

---

## States / Datenpunkte

### Playback (read-only)
- `spotify-premium.0.playback.isPlaying`
- `spotify-premium.0.playback.track`
- `spotify-premium.0.playback.artist`
- `spotify-premium.0.playback.album`
- `spotify-premium.0.playback.progressMs`
- `spotify-premium.0.playback.durationMs`
- `spotify-premium.0.playback.deviceId`
- `spotify-premium.0.playback.deviceName`
- `spotify-premium.0.playback.deviceType`
- `spotify-premium.0.playback.volumePercent`
- `spotify-premium.0.playback.shuffle`
- `spotify-premium.0.playback.repeat`

### Control (write)
- `spotify-premium.0.control.play` (button)
- `spotify-premium.0.control.pause` (button)
- `spotify-premium.0.control.toggle` (button)
- `spotify-premium.0.control.next` (button)
- `spotify-premium.0.control.previous` (button)
- `spotify-premium.0.control.volume` (0–100)
- `spotify-premium.0.control.shuffle` (true/false)
- `spotify-premium.0.control.repeat` (off/track/context)
- `spotify-premium.0.control.seek` (ms)
- `spotify-premium.0.control.playUri` (spotify:track:..., spotify:playlist:..., ...)
- `spotify-premium.0.control.addToQueue` (spotify:track:..., ...)
- `spotify-premium.0.control.transferToDevice` (deviceId)
- `spotify-premium.0.control.refreshDevices` (button)

---

## Lizenz

MIT
