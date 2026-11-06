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
│   └── autolock.service.ts  # Inaktivitäts-Timer
├── ui/                      # Präsentation – kennt Services nur über App-Controller
│   ├── dom.ts               # XSS-sicherer Hyperscript-Builder (nur textContent)
│   ├── icons.ts             # Tree-shaken Lucide-Registry
│   ├── modal.ts / toast.ts / theme.ts / format.ts
│   └── components/          # lock-screen, smart-input, shipment-card, shipment-detail,
│                            # timeline, skeleton, empty-state, settings-modal, …
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

Einmalig erforderlich: **Repository → Settings → Pages → Build and deployment → Source: „GitHub Actions“**.

Da Vite mit `base: './'` baut, funktioniert die App ohne weitere Konfiguration unter `https://<user>.github.io/<repo>/`.

## Lizenz

Privates Projekt – alle Rechte vorbehalten.
