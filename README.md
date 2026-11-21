<div align="center">

# goal-meter

**Ein Live-Zielmesser für Claude Code.** Zeigt das große Ziel, jede Hauptaufgabe und Teilaufgabe, was erledigt ist, was gerade läuft, wie lange es gedauert hat und wann es fertig sein wird – in einem Pane neben deiner Session.

[![Version](https://img.shields.io/badge/version-0.7.0--de.9-6366f1.svg)](.claude-plugin/plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-d97757.svg)](https://claude.com/claude-code)

[Deutsch](README.md) · [English](README.en.md) · [ภาษาไทย](README.th.md)

<img src="docs/preview.svg" alt="goal-meter-Pane: ein Ziel, ein gestapelter Fortschrittsbalken in einer Farbe je Aufgabe, verstrichene Zeit und ETA sowie eine Aufgabenliste mit Teilaufgaben" width="820">

</div>

> **Deutsche Fassung.** Dieser Fork von [TheerasakPing/goal-meter](https://github.com/TheerasakPing/goal-meter) übersetzt alle Texte im Pane und in den Toasts ins Deutsche. Außerdem zeigt diese Fassung keine Leiste über dem Prompt und keine Statuszeile, das Pane keine Balken, Knöpfe, Modell- oder Kontingent-Anzeige, und sie bringt die Tasks aus dem Mod task-progress mit. Das Vorschaubild (`docs/preview.svg`) zeigt noch die Thai-Texte des Originals.

## Funktionen

**Fortschritt**

- **Ziel, Aufgaben und Teilaufgaben.** Oben ein Ziel, darunter die Hauptaufgaben; die Teilaufgaben der laufenden Aufgabe sind als Baum aufgeklappt.
- **Eine Farbe je Aufgabe**, in ihrer Zeile und in ihrem Abschnitt des gestapelten Fortschrittsbalkens. Erledigtes füllt den Balken, Laufendes blinkt, nicht Begonnenes bleibt grau.
- **Status auf einen Blick.** `✔` erledigt (grün), `◐` läuft (bernstein, dreht sich), `○` nicht begonnen (grau). Erledigte Teilaufgaben werden durchgestrichen.
- **Ohne Zutun.** Der Messer folgt der Aufgabenliste, die Claude ohnehin führt: in der Desktop-App dem Plan unter der Nachricht (`update_plan`), sonst `TodoWrite`, `TaskCreate` und `TaskUpdate`. Das Tool `update` braucht Claude nur ohne solche Liste, für den Titel des Ziels oder danach für Teilaufgaben: Die bleiben bei gleichnamigen Plan-Schritten erhalten, und ein im Plan erledigter Schritt hakt sie mit ab. Der Systemprompt-Abschnitt verlangt es nicht mehr zuerst, damit der Plan im Chat aktuell bleibt.

**Zeit**

- **Aktive Zeit statt Wanduhr.** Die Uhr läuft nur, während Claude an einem Turn arbeitet; eine Mittagspause verdirbt die ETA also nicht. Beides wird angezeigt: `Aktiv 12m (gesamt 40m)`.
- **ETA, die dazulernt.** Jedes erreichte Ziel speichert, wie weit die Prognose zur Halbzeit danebenlag; spätere ETAs werden mit dem Median dieses Verlaufs skaliert.
- **Frist.** `/goal-meter deadline 17:00` zeigt, ob die ETA die Frist hält oder wie viel später es wird.
- **Pause.** Die Uhr mit `/goal-meter pause` / `resume` oder dem Knopf im Pane anhalten und weiterlaufen lassen.

**Kosten und Kontingent**

- **Kosten je Ziel und je Aufgabe**, aus den Ausgaben der Session zwischen Start und Ende.
- **Kontingent-Hinweise** bei 80 % und 90 %, als Toast und Ton, einmal je Zeitraum.

**Tasks** (übernommen aus dem Mod task-progress)

- **Lange Shell-Aufrufe.** Jeder Bash-Aufruf ab 3 s bekommt im Pane unter „TASKS“ eine Zeile mit Prozent, Laufzeit und ETA aus früheren Läufen desselben Befehls.
- **Gate-Tool.** `mcp__goal-meter__gate` führt Prüfungen (Tests, Builds, Lint) als benannte Schritte aus, zählt Tests live mit und liefert Claude je Schritt Exit-Code, Dauer, Testzahlen und die letzten Ausgabezeilen. Befehle laufen vorher durch die Bash-Erlaubnisregeln.
- **Öffnet von selbst.** Das Pane öffnet sich mit jeder Session, auch ohne Ziel. Ein sichtbarer Task öffnet es einmal erneut, jedes Gate jedes Mal (nicht im Modus `status`). Kann die Oberfläche es nicht platzieren, steht der Grund als graue Zeile im Verlauf.
- Es bleiben die letzten 12 fertigen Läufe; ✔ erledigt, ✗ fehlgeschlagen, ■ abgebrochen, – übersprungen.
- **Zuklappen.** „▾ Fertig · n“ klappt fertige Tasks zu, „▾ Erledigt · n“ erledigte Aufgaben des Ziels; ein zweiter Klick klappt sie wieder auf.

**Desktop-Look** (angelehnt an das Agents-Panel von savvy-progress)

- In der Desktop-App zeichnet das Pane jede Zeile als SVG: Kopf mit gepunktetem Fortschrittsbalken und Kacheln (Aufgaben, Aktiv, Rest, Fertig um), Aufgaben mit Pixel-Krabbe in der Aufgabenfarbe, Tasks mit Terminal-Symbol, dünne Balken und Statusmarken rechts. Ohne Ziel zeigt der Kopf Laufend, Fertig und Zeit.
- Hell und dunkel folgen dem System; `prefers-reduced-motion` hält Krabben und Pixel an.
- Im Terminal bleibt die Textansicht. Nur dort startet ein Klick auf eine Aufgabe „weitermachen“: Auf dem Desktop kann ein SVG nicht in einem Knopf stecken.

**Alles andere**

- **Subagents.** Agents, die Claude startet, erscheinen im Pane, solange sie laufen.
- **Bericht und Verlauf.** `/goal-meter report` liefert eine Markdown-Zusammenfassung fürs Standup; `/goal-meter history` listet erreichte Ziele mit Zeit und Kosten.
- **Bleibt beim Chat.** Ein laufendes Ziel gehört zu der Session, in der es gesetzt wurde: Wird sie fortgesetzt, ist es wieder da; andere Chats sehen es nicht (je Session-ID im Store, die letzten 20).
- **Knöpfe.** Im Terminal-Pane bittet ein Klick auf eine Aufgabe Claude, damit weiterzumachen; Pause, Modus und Ton stellst du per Befehl ein.
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
| `/goal-meter mode status` · `panel` · `both` | `status` schaltet das Pane ab, `panel` und `both` lassen es an (Standard `both`) |
| `/goal-meter sound on` · `off` | Töne für erreichtes Ziel und Kontingent-Hinweise |
| `/goal-meter pane` | Ganzes Pane öffnen |
| `/goal-meter clear` | Ziel löschen |
| `/goal-meter help` | Befehle auflisten |

Modus und Ton-Einstellung bleiben über Sessions hinweg erhalten. Der Messer erscheint nur im Pane:

- **In einem Pane**, der ganze Messer mit allen Aufgaben und Teilaufgaben, Kosten je Aufgabe, und Agents. Kontingent, Context und Modell zeigt diese Fassung nicht; nur die Kontingent-Hinweise kommen weiter als Toast. Es öffnet sich von selbst, wenn im Modus `panel` oder `both` ein Ziel beginnt, oder jederzeit mit `/goal-meter pane`.

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

Nutzt Claude stattdessen die eingebauten Aufgaben-Tools von Claude Code, liest der Mod die Aufrufe von `TodoWrite`, `TaskCreate` und `TaskUpdate` mit und baut daraus dieselbe Liste (bei `TaskCreate`/`TaskUpdate` über die Task-ID). Ein Ziel aus dem Tool `update` hat Vorrang vor diesen Listen. Der Plan der Desktop-App (`mcp__ccd_turn__update_plan`) dagegen ersetzt die Aufgaben auch dann und behält nur den Titel: Ein voller Plan ersetzt die Liste, `advance` schließt den laufenden Schritt und startet den nächsten, `done` und `start` setzen Schritte nach Position.

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
  views.tsx          das Pane
  tasks.ts           Tasks: Bash-Zeilen, Gate-Tool, ETA-Verlauf (Store-Key runHistory)
  svg.ts             Desktop-Zeichnungen: Kopf, Zeilen, Krabbe, gepunkteter Balken
  meter.ts           reine Logik: Zusammenführen, Fortschritt, aktive Zeit, ETA, Frist, Balkenabschnitte
  quota.ts           Kontingent-Messungen, Prognose und Hinweise
  report.ts          /goal-meter report und history als Markdown
  state.ts           gemeinsame Konstanten
  palette.ts         Farben
  goal-meter.test.tsx
  tasks.test.tsx
sounds/              done.wav, alert.wav
types/index.d.ts     der Zustandsvertrag
```

Die Farben stehen in `hooks/palette.ts`. `PALETTE` oder `TASK_COLORS` ändern, um den Messer umzufärben.

Änderungen am Original holen: `git remote add upstream https://github.com/TheerasakPing/goal-meter`, dann `git fetch upstream` und `upstream/main` hereinmergen. Neue Thai-Texte danach wieder übersetzen.

Siehe [CONTRIBUTING.md](CONTRIBUTING.md), um eine Änderung einzureichen, und [CHANGELOG.md](CHANGELOG.md) für die Änderungen.

## Lizenz

[MIT](LICENSE) © TheerasakPing
