# 📦 Pakettracker

Ein privates **Zero-Knowledge Paket-Tracking-Dashboard** als Single-Page-App.
Alle Daten (Sendungsnummern, E-Mails, Carrier, Notizen, Status-Verlauf) werden **im Browser** mit
AES-256-GCM verschlüsselt und ausschließlich als Ciphertext im `localStorage` abgelegt.
Kein Konto, kein Backend, keine Telemetrie.

**Stack:** Vite · TypeScript (strict) · Tailwind CSS v4 · Lucide Icons · Vitest · GitHub Actions → GitHub Pages

---

## Features

| Bereich | Umsetzung |
| --- | --- |
| 🔐 Zero-Knowledge | PBKDF2-SHA-256 (600 000 Iterationen) → nicht-extrahierbarer AES-256-GCM-Key, frischer IV pro Speichervorgang |
| ✨ Smart Input | Erkennt live E-Mail, URL (inkl. Extraktion der Nummer aus Carrier-Links) und Tracking-IDs von **DHL, UPS, DPD, Hermes** – mit Prüfziffern (UPS 1Z, UPU S10) & Confidence-Ranking bei mehrdeutigen Formaten |
| 🧭 Tracking-View | Vertikale Timeline (nach Tagen gruppiert) + 4-Stufen-Fortschrittsanzeige, Deeplinks zum offiziellen Carrier-Tracking, manuelle Statuspflege als Fallback |
| 💎 UX | Dark Mode (Zinc) als Default + Light Mode, Glassmorphism, Skeleton-Loader, Toasts, Empty-States, Tastatur-Shortcuts (`/`, `Strg+K`, `Strg+Shift+L`), Fokus-Trap in Dialogen, `prefers-reduced-motion` |
| 📬 Gmail-Import | Liest Versand-Mails (nur `gmail.readonly`, direkt im Browser): Eindeutige Treffer werden automatisch eingefügt, unsichere als Vorschläge angezeigt, Folge-Mails („wird heute zugestellt“) ergänzen die Timeline |
| 💾 Backup | Export/Import der **verschlüsselten** JSON-Datei, Merge oder Replace, Re-Encryption mit dem aktuellen Schlüssel |
| 🛡 Hardening | Strikte CSP, kein `innerHTML`, Auto-Lock bei Inaktivität, Rollback bei Schreibfehlern, Multi-Tab-Sync |

## Quickstart

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Unit-Tests (Crypto, Vault, Detection, Timeline)
npm run build      # Typecheck + Production-Build nach ./dist
npm run preview    # Production-Build lokal testen (inkl. CSP)
```

> Die Web Crypto API ist nur in sicheren Kontexten verfügbar (HTTPS oder `localhost`).

## Architektur

```
src/
├── core/                    # Domain: Typen, Fehlerklassen, IDs – keine Abhängigkeiten
│   ├── types.ts
│   ├── errors.ts
│   └── id.ts
├── services/                # Reine Logik, UI-frei & unit-getestet
│   ├── crypto.service.ts    # Web Crypto: PBKDF2 → AES-GCM, Base64, AAD
│   ├── storage.service.ts   # localStorage: Envelope-Schema, Validierung, Backup-Dateien
│   ├── vault.service.ts     # Session (Key im RAM), create/unlock/lock/update/import/export
│   ├── detection.service.ts # Smart-Input: Regex-Regeln, Prüfziffern, URL-Parsing
│   ├── carriers.ts          # Carrier-Metadaten & sichere Deeplinks
│   ├── tracking.service.ts  # API-Layer: Provider-Pattern (Remote-Proxy | Lokal), Timeline
│   ├── gmail.service.ts     # Gmail: OAuth-Token (GIS, nur RAM), REST, MIME-Parsing
│   ├── mail-extract.service.ts # Mail → Sendungsnummern (Kontext-Scoring, HTML→Text, Status)
│   ├── inbox.service.ts     # Scan-Orchestrierung: Dedupe, Auto-Add, Vorschläge
│   └── autolock.service.ts  # Inaktivitäts-Timer
├── ui/                      # Präsentation – kennt Services nur über App-Controller
│   ├── dom.ts               # XSS-sicherer Hyperscript-Builder (nur textContent)
│   ├── icons.ts             # Tree-shaken Lucide-Registry
│   ├── modal.ts / toast.ts / theme.ts / format.ts
│   └── components/          # lock-screen, smart-input, shipment-card, shipment-detail,
│                            # timeline, skeleton, empty-state, settings-modal, inbox-panel, …
├── app.ts                   # Controller: verbindet Services & Views, State, Routing
├── main.ts                  # Bootstrap
└── styles.css               # Tailwind v4 + semantische Design-Tokens (Dark/Light)
```

**Datenfluss:** `UI-Event → App (Controller) → VaultService.update() → CryptoService.encrypt() → Round-Trip-Verifikation → StorageService.save()`

Die Schichten sind strikt getrennt: `services/` importiert nie aus `ui/`, der `StorageService` sieht niemals Klartext,
und der `CryptoService` ist zustandslos.

## Sicherheitsmodell

```
Master-Passwort ──NFC──▶ PBKDF2-HMAC-SHA-256 (600k, 128-bit Salt) ──▶ AES-256-GCM Key (non-extractable, nur RAM)
                                                                          │
VaultData (JSON) ─────────────────────────────────────────────────────────┴─▶ AES-GCM(IV=96-bit random, AAD=Header)
                                                                                     │
localStorage["pakettracker.vault.v1"] = { v, kdf:{iterations, salt}, cipher:{iv}, ct } ◀┘
```

- **Falsches Passwort:** GCM-Authentifizierung schlägt fehl → `WrongPasswordError`. Es wird **nichts geschrieben**; Daten können nicht korrumpiert werden.
  Nach 3 Fehlversuchen greift ein clientseitiger Backoff.
- **Integrität:** Der Envelope-Header (Version, KDF-Parameter, Salt) ist als *Additional Authenticated Data* gebunden –
  manipulierte Iterationszahlen (Downgrade) führen zum Abbruch. Iterationen < 100 000 werden beim Laden/Import abgelehnt.
- **Schreibsicherheit:** Jeder neue Ciphertext wird vor dem Speichern testweise entschlüsselt; der vorherige Stand bleibt als
  `…previous`-Slot erhalten. Schreibvorgänge werden serialisiert; bei Fehlern wird der In-Memory-State zurückgerollt.
- **Session:** Der Schlüssel existiert nur im Arbeitsspeicher und wird beim Sperren/Auto-Lock verworfen. Das Passwort selbst wird nie gespeichert.
- **XSS/Injection:** Kein `innerHTML`; alle Nutzerdaten via `textContent`. URL-Attribute werden auf `https/http/mailto/blob` beschränkt.
  Production-Build mit strikter CSP (`default-src 'none'; script-src 'self'; …`).
- **Privacy:** Ohne konfigurierte API verlässt keine Sendungsnummer das Gerät – außer der Nutzer öffnet aktiv den Carrier-Deeplink
  (`rel="noopener noreferrer"`, `no-referrer`).
- **Unverschlüsselt** gespeichert wird nur die Theme-Präferenz (`pakettracker.theme`).

> ⚠️ Zero-Knowledge heißt: Ein vergessenes Master-Passwort kann **nicht** wiederhergestellt werden. Regelmäßig Backups exportieren!

## Gmail-Integration (optional)

Die App kann dein Gmail-Postfach **nur lesend** nach Versand-Mails durchsuchen und gefundene Sendungsnummern übernehmen.

**So funktioniert es:**
1. **Verbinden:** Per Klick auf „Gmail verbinden“ wird ein Google-Popup geöffnet (OAuth 2.0, Scope `gmail.readonly`).
2. **Token:** Das Access-Token liegt nur im Arbeitsspeicher (≈ 1 h), wird beim Sperren verworfen und nie gespeichert.
3. **Suche:** Gesucht wird nur nach Mails von Paketdiensten und großen Shops bzw. mit Versand-Stichworten im Betreff. Beim ersten Scan sind das die letzten 30 Tage, danach nur Neues.
4. **Bewertung:** Jeder Fund wird nach Kontext bewertet: Carrier-Link, Absender-Domain, Stichworte, Prüfziffern. Bestell-, Kunden- und Telefonnummern werden ignoriert.
   - **Sicher** (z. B. UPS `1Z…` mit gültiger Prüfziffer, DHL `JJD…`/`00340…`, Carrier-Links): wird automatisch eingefügt.
   - **Unsicher:** erscheint als Vorschlag zum Übernehmen oder Verwerfen. Verworfene Nummern kommen nie wieder.
5. **Bekannte Sendungen:** Mails zu bereits vorhandenen Sendungen (z. B. „wird heute zugestellt“) ergänzen deren Timeline.
6. **Speicherung:** Funde, Vorschläge und der Scan-Verlauf liegen verschlüsselt im Tresor.
7. **Auto-Scan:** läuft im eingestellten Intervall, solange die App geöffnet ist. Nach dem Entsperren verbindet sich die App automatisch neu. Läuft das Token ab, reicht ein Klick auf „Verbinden & scannen“, da Browser Popups nur nach einem Klick erlauben.

> Das Google-Skript (`accounts.google.com/gsi/client`) wird erst geladen, wenn du die Funktion nutzt. Die CSP erlaubt
> ausschließlich die nötigen Google-Endpunkte und nur, wenn eine Client-ID konfiguriert ist.

### Einrichtung (einmalig, Google Cloud Console)

1. Projekt anlegen und die **Gmail API** aktivieren (*APIs und Dienste → Bibliothek*).
2. *Google Auth Platform* einrichten:
   - **Zielgruppe:** Extern, Status **Testen**. Dein Gmail-Konto unter **Testnutzer** eintragen.
   - **Datenzugriff:** den Scope `https://www.googleapis.com/auth/gmail.readonly` hinzufügen.
3. *Clients → Client erstellen* mit Typ **Webanwendung**:
   - **Autorisierte JavaScript-Quellen:** `https://<user>.github.io` und `http://localhost:5173`
   - **Weiterleitungs-URIs:** keine
4. Die **Client-ID** in [`.env`](.env) als `VITE_GOOGLE_CLIENT_ID` eintragen. Sie ist öffentlich und darf committet werden.
   **Den Clientschlüssel nicht verwenden** und am besten löschen: Er wird nicht gebraucht.

> Gmail API, Testnutzer, Scope und Client müssen im **selben** Google-Cloud-Projekt liegen. Sonst meldet die App
> „Die Gmail API ist im Google-Cloud-Projekt dieser Client-ID nicht aktiviert“.
> Im Testmodus zeigt Google beim Login „App nicht überprüft“. Das ist für die private Nutzung normal (*Erweitert → Weiter*).

## Optionale Live-Tracking-API

Carrier-APIs benötigen geheime Keys und erlauben meist kein CORS – diese gehören **nie** ins Frontend.
Stattdessen kann ein eigener Proxy (z. B. Cloudflare Worker) angebunden werden:

```bash
VITE_TRACKING_API_URL=https://tracking-proxy.example.com npm run build
```

Erwartete Schnittstelle: `GET {BASE}/track?carrier=dhl&number=…` →

```json
{
  "status": "in_transit",
  "estimatedDelivery": "Mo., 10. Nov.",
  "events": [{ "status": "in_transit", "at": "2026-11-06T08:12:00Z", "title": "Im Paketzentrum", "location": "Köln" }]
}
```

`status` ∈ `pre_transit | in_transit | out_for_delivery | delivered | exception`. Die CSP erlaubt automatisch genau diese Origin.
Antworten werden validiert, verschlüsselt im Tresor gecacht (10 min) und bei Fehlern fällt die App transparent auf den lokalen Modus zurück.
Im GitHub-Workflow wird die Variable aus *Settings → Secrets and variables → Actions → Variables* gelesen.

## Deployment (GitHub Pages)

Der Workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) läuft bei jedem Push auf `main`:
`npm ci → npm test → npm run build → upload-pages-artifact → deploy-pages`.

Einmalig erforderlich: **Repository → Settings → Pages → Build and deployment → Source: „GitHub Actions“**. Danach den Workflow einmal manuell starten (**Actions → Deploy to GitHub Pages → Run workflow**), denn das Umstellen selbst löst keinen Build aus.

Da Vite mit `base: './'` baut, funktioniert die App ohne weitere Konfiguration unter `https://<user>.github.io/<repo>/`.

### Fehlerbehebung: Seite bleibt grau oder leer

| Symptom | Ursache | Lösung |
| --- | --- | --- |
| Graue Seite mit dem Hinweis „Die App konnte nicht gestartet werden“ | Pages liefert den **Quellcode** aus (Source „Deploy from a branch“); `/src/main.ts` kann der Browser nicht ausführen | Source auf **„GitHub Actions“** stellen und den Workflow erneut ausführen (siehe unten) |
| Workflow schlägt bei `Configure GitHub Pages` fehl | Pages war beim Lauf noch nicht für Actions aktiviert | Source umstellen, dann **Actions → Deploy to GitHub Pages → Re-run all jobs** |
| Nach dem Umstellen weiterhin alte Version | Das Umstellen der Source startet **keinen** neuen Build | Workflow manuell starten (**Run workflow**) oder neuen Commit auf `main` pushen |
| Nach erfolgreichem Deploy immer noch grau | Browser- oder CDN-Cache | Hart neu laden (Strg+Shift+R) |

Nach jedem Deployment prüft der Schritt **Verify live deployment**, ob die Live-URL wirklich den Vite-Build ausliefert, und schlägt sonst mit einem Hinweis fehl.

## Lizenz

Privates Projekt – alle Rechte vorbehalten.
