<div align="center">

# goal-meter

**Ein Live-Zielmesser für Claude Code.** Zeigt das große Ziel, jede Hauptaufgabe und Teilaufgabe, was erledigt ist, was gerade läuft, wie lange es gedauert hat und wann es fertig sein wird – in einem Pane neben deiner Session.

[![Version](https://img.shields.io/badge/version-0.6.0--de.3-6366f1.svg)](.claude-plugin/plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-d97757.svg)](https://claude.com/claude-code)

[Deutsch](README.md) · [English](README.en.md) · [ภาษาไทย](README.th.md)

<img src="docs/preview.svg" alt="goal-meter-Pane: ein Ziel, ein gestapelter Fortschrittsbalken in einer Farbe je Aufgabe, verstrichene Zeit und ETA sowie eine Aufgabenliste mit Teilaufgaben" width="820">

</div>

> **Deutsche Fassung.** Dieser Fork von [TheerasakPing/goal-meter](https://github.com/TheerasakPing/goal-meter) übersetzt alle Texte im Pane, in der Leiste über dem Prompt, in der Statuszeile und in den Toasts ins Deutsche. Funktionen und Logik sind unverändert. Das Vorschaubild (`docs/preview.svg`) zeigt noch die Thai-Texte des Originals.

## Funktionen

**Fortschritt**

- **Ziel, Aufgaben und Teilaufgaben.** Oben ein Ziel, darunter die Hauptaufgaben; die Teilaufgaben der laufenden Aufgabe sind als Baum aufgeklappt.
- **Eine Farbe je Aufgabe**, in ihrer Zeile und in ihrem Abschnitt des gestapelten Fortschrittsbalkens. Erledigtes füllt den Balken, Laufendes blinkt, nicht Begonnenes bleibt grau.
- **Status auf einen Blick.** `✔` erledigt (grün), `◐` läuft (bernstein, dreht sich), `○` nicht begonnen (grau). Erledigte Teilaufgaben werden durchgestrichen.
- **Ohne Zutun.** Claude hält den Messer über das Tool `update` aktuell. Nutzt Claude stattdessen die eingebaute Aufgabenliste von Claude Code (`TodoWrite`, `TaskCreate`, `TaskUpdate`), folgt der Messer dieser Liste von selbst.

**Zeit**

- **Aktive Zeit statt Wanduhr.** Die Uhr läuft nur, während Claude an einem Turn arbeitet; eine Mittagspause verdirbt die ETA also nicht. Beides wird angezeigt: `Aktiv 12m (gesamt 40m)`.
- **ETA, die dazulernt.** Jedes erreichte Ziel speichert, wie weit die Prognose zur Halbzeit danebenlag; spätere ETAs werden mit dem Median dieses Verlaufs skaliert.
- **Frist.** `/goal-meter deadline 17:00` zeigt, ob die ETA die Frist hält oder wie viel später es wird.
- **Pause.** Die Uhr mit `/goal-meter pause` / `resume` oder dem Knopf im Pane anhalten und weiterlaufen lassen.

**Kosten und Kontingent**

- **Kosten je Ziel und je Aufgabe**, aus den Ausgaben der Session zwischen Start und Ende.
- **Nutzungskontingent.** Dein 5-Stunden- und Wochenlimit bei Claude in einer Zeile, mit verbrauchtem Anteil und Zeit bis zum Zurücksetzen.
- **Kontingent-Prognose.** Aus dem Anstieg jedes Fensters in diesem Zeitraum: `5 Std. leer um 15:40`. Eine rote Warnung erscheint, wenn ein Fenster leer wäre, bevor das Ziel erreicht ist.
- **Kontingent-Hinweise** bei 80 % und 90 %, als Toast und Ton, einmal je Zeitraum.

**Alles andere**

- **Subagents.** Agents, die Claude startet, erscheinen im Pane, solange sie laufen, und ihre Anzahl in der Leiste.
- **Bericht und Verlauf.** `/goal-meter report` liefert eine Markdown-Zusammenfassung fürs Standup; `/goal-meter history` listet erreichte Ziele mit Zeit und Kosten.
- **Bleibt erhalten.** Ein laufendes Ziel wird in eine neue Session übernommen.
- **Knöpfe.** Im Pane bittet ein Klick auf eine Aufgabe Claude, damit weiterzumachen; Pause, Modus und Ton stellst du per Befehl ein.
- **Töne**, wenn ein Ziel erreicht ist und wenn ein Kontingent-Hinweis kommt (`/goal-meter sound off` schaltet sie stumm).

## Installation

Am Prompt einer Claude-Code-Session im Terminal:

```
/plugin install goal-meter --marketplace TheCodingHood/goal-meter
```

Mit `y` den Marketplace hinzufügen, dann einen Scope wählen (`user` empfohlen). Der Mod ist sofort aktiv.

Oder ohne Session, im Terminal:

```bash
claude plugin marketplace add TheCodingHood/goal-meter
claude plugin install goal-meter@goal-meter --scope user
```

Ist bereits das Original installiert, vorher entfernen – beide Marketplaces heißen `goal-meter`:

```bash
claude plugin uninstall goal-meter@goal-meter
claude plugin marketplace remove goal-meter
```

**Aktualisieren** auf die neueste Version, im Terminal:

```bash
claude plugin marketplace update goal-meter
claude plugin update goal-meter@goal-meter
```

Der erste Befehl holt die neue Versionsliste, der zweite aktualisiert den installierten Mod. Danach eine neue Session starten.

> Der Befehl `/plugin` funktioniert in einer Terminal-Session. Ein im Scope `user` installierter Mod lädt auch im Code-Tab der Desktop-App.

## Wo es läuft

| Wo | Läuft |
| --- | --- |
| Claude Code im Terminal | ✅ Installieren und nutzen |
| Claude Desktop, Tab **Code** | ✅ Im Terminal im Scope `user` installieren; lädt dort ebenfalls |
| Claude Code in VS Code, mobil | Sollte laufen (nicht getestet) |
| Chat auf claude.ai, Chat in der Claude-App | ❌ Dort gibt es keine Mods |

Das Nutzungskontingent braucht ein Claude-Abo (Pro oder Max) und erscheint nach der ersten Antwort von Claude in einer Session. Gebaut gegen die Early-Access-Mod-API von Claude Code 2.1.295.

## Nutzung

Gib Claude eine beliebige Aufgabe mit mehreren Schritten. Der Messer füllt sich, während Claude arbeitet.

| Befehl | Wirkung |
| --- | --- |
| `/goal-meter` | Messer anzeigen |
| `/goal-meter <Ziel>` | Selbst ein Ziel setzen |
| `/goal-meter pause` · `resume` | Uhr für die aktive Zeit anhalten oder weiterlaufen lassen |
| `/goal-meter deadline 17:00` | Frist setzen (`off` entfernt sie) |
| `/goal-meter report` | Markdown-Zusammenfassung des Ziels |
| `/goal-meter history` | Bisher erreichte Ziele |
| `/goal-meter mode status` · `panel` · `both` | Wo der Messer erscheint (Standard `both`) |
| `/goal-meter sound on` · `off` | Töne für erreichtes Ziel und Kontingent-Hinweise |
| `/goal-meter hide` | Leiste über dem Prompt ausblenden (die Statuszeile bleibt) |
| `/goal-meter pane` | Ganzes Pane öffnen |
| `/goal-meter clear` | Ziel löschen |
| `/goal-meter help` | Befehle auflisten |

Modus und Ton-Einstellung bleiben über Sessions hinweg erhalten. Der Messer erscheint an bis zu drei Stellen:

- **Über dem Prompt**, als zweizeilige Leiste: Ziel, gestapelter Fortschrittsbalken, ETA, laufende Aufgabe, laufende Agents, Frist und Kontingent, dazu eine rote Zeile, wenn ein Kontingent vorher leer wäre.
- **In der Statuszeile**, eine Zeile Text: `Goal 52% (5/11) · ◐ Build the API · ETA 14:52 | 5 Std. 47% · Woche 24%`.
- **In einem Pane**, der ganze Messer mit allen Aufgaben und Teilaufgaben, Kosten je Aufgabe, und Agents. Kontingent und Context zeigt das Pane in dieser Fassung nicht; dafür gibt es Leiste und Statuszeile. Es öffnet sich von selbst, wenn im Modus `panel` oder `both` ein Ziel beginnt, oder jederzeit mit `/goal-meter pane`.

Im Pane bittet ein Klick auf eine Aufgabe Claude, damit weiterzumachen.

## So funktioniert es

Der Mod registriert ein Tool, `mcp__goal-meter__update`, und ergänzt den System-Prompt um einen kurzen Hinweis: Claude soll es aufrufen, sobald eine Aufgabe beginnt oder endet. Jeder Aufruf schickt die vollständige Liste:

```json
{
  "goal": "Login-Flow ausliefern",
  "tasks": [
    { "title": "Screens entwerfen", "status": "done" },
    {
      "title": "API bauen",
      "status": "in_progress",
      "subtasks": [
        { "title": "POST /login", "status": "done" },
        { "title": "Session-Tokens", "status": "in_progress" },
        { "title": "Rate Limiting", "status": "pending" }
      ]
    },
    { "title": "End-to-End testen", "status": "pending" }
  ]
}
```

Nutzt Claude stattdessen die eingebauten Aufgaben-Tools von Claude Code, liest der Mod die Aufrufe von `TodoWrite`, `TaskCreate` und `TaskUpdate` mit und baut daraus dieselbe Liste (bei `TaskCreate`/`TaskUpdate` über die Task-ID). Ein Ziel aus dem Tool `update` hat Vorrang: Die eingebaute Liste überschreibt es nie.

- **Zeiten** erfasst der Mod, nicht Claude. Die Uhr einer Aufgabe startet, wenn sie zum ersten Mal als laufend gesehen wird, und stoppt, wenn sie zum ersten Mal als erledigt gesehen wird.
- **Aktive Zeit** läuft von `turn.start` bis `turn.complete` der Hauptunterhaltung, und nicht während einer Pause.
- **Fortschritt** zählt Blatt-Einheiten: jede Teilaufgabe, oder die Aufgabe selbst, wenn sie keine hat. Erledigt zählt 1, laufend ½.
- **ETA** ist `aktive Zeit × (1 − Fortschritt) ÷ Fortschritt × Faktor`. Der Faktor ist der Median von `tatsächlich ÷ vorhergesagt` über erreichte Ziele (jeweils zur Halbzeit vorhergesagt), begrenzt auf 0,5 bis 2, und 1, bis zwei Ziele erfasst sind.
- **Kosten** einer Aufgabe sind die Kosten der Session bei ihrem Ende minus die Kosten bei ihrem Start.
- **Kontingent** stammt aus den Rate-Limit-Fenstern, die die letzte API-Antwort gemeldet hat (`$.session.usage()`). Es erscheint also erst, nachdem Claude mindestens einmal geantwortet hat, und nur mit einem Claude-Abo. Die Prognose braucht mindestens zwei Messungen im Abstand von 2 Minuten im selben Zeitraum.

Ziel, Modus, Ton-Einstellung und Verlauf liegen in `$.store` und überstehen damit eine neue Session; alles andere lebt nur in der Session.

## Entwicklung

```bash
git clone https://github.com/TheCodingHood/goal-meter
cd goal-meter
claude --plugin-dir .          # Claude Code mit dem Mod aus diesem Ordner starten
claude plugin validate .       # Manifest und Hooks-Modul prüfen
claude plugin test .           # hooks/*.test.tsx ausführen
```

```
.claude-plugin/
  plugin.json        Manifest
  marketplace.json   macht dieses Repo mit /plugin install installierbar
hooks/
  hooks.json         verweist auf register.tsx
  register.tsx       Events, Tools, der Befehl, Zustand und die Hooks der beiden Ansichten
  views.tsx          die Leiste über dem Prompt und das Pane
  meter.ts           reine Logik: Zusammenführen, Fortschritt, aktive Zeit, ETA, Frist, Balkenabschnitte
  quota.ts           Kontingent-Messungen, Prognose und Hinweise
  report.ts          /goal-meter report und history als Markdown
  state.ts           gemeinsame Konstanten
  palette.ts         Farben
  goal-meter.test.tsx
sounds/              done.wav, alert.wav
types/index.d.ts     der Zustandsvertrag
```

Die Farben stehen in `hooks/palette.ts`. `PALETTE` oder `TASK_COLORS` ändern, um den Messer umzufärben.

Änderungen am Original holen: `git remote add upstream https://github.com/TheerasakPing/goal-meter`, dann `git fetch upstream` und `upstream/main` hereinmergen. Neue Thai-Texte danach wieder übersetzen.

Siehe [CONTRIBUTING.md](CONTRIBUTING.md), um eine Änderung einzureichen, und [CHANGELOG.md](CHANGELOG.md) für die Änderungen.

## Lizenz

[MIT](LICENSE) © TheerasakPing
