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
  - Geräte-Liste abrufen

---

## Voraussetzungen

- ioBroker mit Node.js **>= 18** (aktuelle Adapter-Tooling und Templates setzen i.d.R. mindestens Node 18 voraus).
- Spotify **Premium** Account
- Spotify Developer App (Client ID / Client Secret + Redirect URI)

---

## Spotify App anlegen (Developer Dashboard)

1. Im Spotify Developer Dashboard eine App erstellen
2. **Redirect URI** in der App hinterlegen, z.B.:

```
http://<DEIN-IOBROKER-HOST>:8888/callback
```

Wichtig: Das muss **exakt** mit der Redirect URI im Script/Adapter übereinstimmen.

---

## Refresh Token holen (einmalig)

Im Repo ist ein Helper-Script enthalten:

```
tools/getRefreshToken.js
```

### Beispiel

Auf dem ioBroker Host im Adapter-Ordner:

```bash
cd /opt/iobroker/node_modules/iobroker.spotify-premium
node tools/getRefreshToken.js --clientId "<CLIENT_ID>" --clientSecret "<CLIENT_SECRET>" --redirectUri "http://<DEIN-IOBROKER-HOST>:8888/callback"
```

Das Script druckt eine URL aus → **im Browser öffnen**, einloggen, bestätigen.  
Danach bekommst du im Terminal und im Browser den **Refresh Token** angezeigt.

➡️ Diesen Refresh Token trägst du dann in den Adapter-Einstellungen ein.

---

## Adapter konfigurieren (ioBroker Admin)

In den Instanz-Einstellungen eintragen:

- **Client ID**
- **Client Secret**
- **Redirect URI**
- **Refresh Token**
- optional: **Default Device ID**
- Polling Intervall (Sekunden)

---

## States / Datenpunkte

### Playback (read-only)
- `spotify-premium.0.playback.isPlaying`
- `spotify-premium.0.playback.track`
- `spotify-premium.0.playback.artist`
- `spotify-premium.0.playback.album`
- `spotify-premium.0.playback.progressMs`
- `spotify-premium.0.playback.durationMs`
- `spotify-premium.0.playback.volume`
- `spotify-premium.0.playback.deviceName`
- `spotify-premium.0.playback.deviceId`
- …

### Control (write)
- `spotify-premium.0.control.play` (true → Trigger)
- `spotify-premium.0.control.pause`
- `spotify-premium.0.control.toggle`
- `spotify-premium.0.control.next`
- `spotify-premium.0.control.previous`
- `spotify-premium.0.control.volume` (0–100)
- `spotify-premium.0.control.shuffle` (true/false)
- `spotify-premium.0.control.repeat` ("off" | "context" | "track")
- `spotify-premium.0.control.seek` (ms)
- `spotify-premium.0.control.playUri` (z.B. `spotify:track:...` oder `spotify:playlist:...`)
- `spotify-premium.0.control.addToQueue` (URI)
- `spotify-premium.0.control.transferToDevice` (deviceId)
- `spotify-premium.0.control.refreshDevices` (true → Trigger)

### Devices
- `spotify-premium.0.devices.json` enthält die verfügbaren Geräte als JSON.

---

## Installation (Repo ZIP / GitHub / lokal)

### Variante A: GitHub (typisch)
1. Repo auf GitHub anlegen (Ordnername: `ioBroker.spotify-premium`)
2. Code pushen
3. Im ioBroker Admin bei **Adapter** die **Octocat/GitHub-Installation** nutzen (Achtung: GitHub-Versionen können „unter Entwicklung“ sein und du musst die Instanz ggf. manuell anlegen).

### Variante B: Lokal (ohne GitHub)
1. Ordner `ioBroker.spotify-premium` nach `/opt/iobroker/node_modules/iobroker.spotify-premium` kopieren
2. im Ordner `npm install`
3. `iobroker upload spotify-premium`
4. Adapter-Instanz im Admin anlegen und konfigurieren

---

## Lizenz
MIT
