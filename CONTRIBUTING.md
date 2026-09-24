# Mitmachen / Contributing

Die Liste wird komplett automatisch erzeugt. Beitragen heißt fast immer: **ein Unternehmen hinzufügen.**

## Ohne Code

[Unternehmen vorschlagen](https://github.com/heynish/werkstudent-praktikum-jobs/issues/new?template=add-company.yml). Ein Link zur Karriereseite reicht.

## Mit einem Pull Request

1. Finde das Job-Board des Unternehmens. Unterstützt werden:

   | ATS | So sieht die Karriereseite aus | `token` |
   |---|---|---|
   | Greenhouse | `boards.greenhouse.io/<token>` oder `job-boards.greenhouse.io/<token>` | `<token>` |
   | Lever | `jobs.lever.co/<token>` | `<token>` |
   | Ashby | `jobs.ashbyhq.com/<token>` | `<token>` |
   | Personio | `<token>.jobs.personio.de` / `.com` | `<token>` |
   | SmartRecruiters | `jobs.smartrecruiters.com/<token>` | `<token>` (Groß-/Kleinschreibung beachten) |
   | Recruitee | `<token>.recruitee.com` | `<token>` |
   | Workable | `apply.workable.com/<token>` | `<token>` |
   | Teamtailor | `<token>.teamtailor.com` | `<token>` |
   | Workday | `<tenant>.<wdN>.myworkdayjobs.com/<site>` | `<tenant>\|<wdN>\|<site>` |

2. Trage es in `candidates.json` ein, z. B. `{ "name": "Beispiel GmbH", "ats": "personio", "token": "beispiel" }`.
3. Prüfen und übernehmen:

   ```bash
   node discover.mjs          # zeigt, wie viele Einstiegsjobs in DACH das Board gerade hat
   node discover.mjs --write  # übernimmt alle Treffer in seed.json
   node build.mjs             # optional: Liste lokal erzeugen
   ```

   `discover.mjs` erfindet nichts: Boards, die nicht antworten oder keine DACH-Einstiegsjobs haben, fliegen raus.

4. PR mit der Änderung an `seed.json` öffnen. `README.md`, `jobs.json`, `jobs.csv` und `lists/` bitte nicht committen, die erzeugt die tägliche Action.

## Regeln

- Nur öffentliche Job-APIs der Unternehmen selbst. Keine Job-Portale oder Aggregatoren scrapen (StepStone, Indeed, LinkedIn usw.).
- Keine Abhängigkeiten: Node 20+, nur die Standardbibliothek.

## Die Daten nutzen

`jobs.json` und `jobs.csv` sind frei nutzbar. Jede Rolle hat:

| Feld | Bedeutung |
|---|---|
| `company`, `title` | Unternehmen und Stellentitel |
| `type` | `Werkstudent`, `Praktikum`, `Absolvent` oder `Junior` |
| `city`, `location` | Normalisierte Stadt und Originalort |
| `posted`, `posted_days_ago` | Veröffentlichungsdatum (wenn das ATS es liefert) |
| `raw_url` | Die Originalausschreibung |
| `careerkit_apply_url` | Derselbe Link über eine Weiterleitung von Careerkit |
| `source` | Das ATS, aus dem die Stelle stammt |

`jobs.json` enthält außerdem `health`: wie viele Quellen abgefragt wurden und wie viele fehlgeschlagen sind.
