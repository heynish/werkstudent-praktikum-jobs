#!/usr/bin/env node
// Werkstudent / Praktikum / Absolventen job list: generator.
//
// Pulls early-career roles from the public job-board APIs of the companies in
// seed.json (Greenhouse, Lever, Ashby, Personio, SmartRecruiters, Recruitee,
// Workable, Teamtailor, Workday) plus Adzuna for AT/CH, keeps DACH roles,
// classifies and dedups them, and writes:
//   jobs.json   full dataset (read by careerkit.me and the three filtered repos)
//   jobs.csv    the same, for spreadsheets
//   README.md   the browsable list
//   lists/*.md  one full page per city and per role type
//
// Health guard: if too many boards fail, or the list suddenly shrinks, nothing is
// written and the run exits 1, so the Action goes red instead of quietly
// publishing a broken list. Set ALLOW_SHRINK=1 to accept a deliberate drop.
//
// Zero dependencies (Node 20+). Run: node build.mjs

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ADAPTERS, SUPPORTED_ATS, getJson, pool, sleep } from "./adapters.mjs";
import { classifyCity, classifyType, isDach } from "./classify.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = "heynish/werkstudent-praktikum-jobs";
const REPO_URL = `https://github.com/${REPO}`;

// Careerkit links.
const INSTALL_URL = "https://careerkit.me/de?utm_source=github&utm_campaign=werkstudent-praktikum-jobs";
const APPLY_BASE = "https://careerkit.me/api/apply"; // tracked 302 to the real posting

// Health thresholds.
const MAX_FAILED_SHARE = 0.25; // more than this share of boards failing = broken run
const MAX_SHRINK = 0.4; // losing more than this share of roles vs the last run = broken run
const ALLOW_SHRINK = process.env.ALLOW_SHRINK === "1";

// README size: GitHub stops rendering very large READMEs, so the front page shows
// the newest roles per city and links to the full per-city page.
const README_NEW_ROWS = 40;
const README_ROWS_PER_CITY = 15;
const NEW_DAYS = 7;

const TYPE_ORDER = ["Werkstudent", "Praktikum", "Absolvent", "Junior"];
const TYPE_LABEL = {
  Werkstudent: "Werkstudent (Working Student)",
  Praktikum: "Praktikum (Internship)",
  Absolvent: "Absolvent (Graduate)",
  Junior: "Junior / Trainee",
};

// ---- Adzuna (extra AT + CH coverage) --------------------------------------
// Keys come from repo secrets, never hardcoded: this repo is public. Without
// keys the source is skipped (local runs), which is not an error.
const ADZUNA_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_KEY = process.env.ADZUNA_APP_KEY;
const ADZUNA_TARGETS = [
  { country: "at", cities: ["Wien", "Graz", "Linz"] },
  { country: "ch", cities: ["Zurich", "Geneva", "Basel"] },
];
const ADZUNA_QUERIES = ["Praktikum", "Werkstudent", "Trainee", "Absolvent"];

async function adzunaQuery(country, city, what) {
  const u = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&what=${encodeURIComponent(what)}&where=${encodeURIComponent(city)}&results_per_page=50&content-type=application/json`;
  const d = await getJson(u);
  return (d.results || [])
    .filter((r) => r.title && r.redirect_url)
    .map((r) => ({
      company: ((r.company || {}).display_name || "").trim(),
      title: (r.title || "").trim(),
      location: (r.location || {}).display_name || city,
      url: r.redirect_url,
      posted: r.created || null,
      dach: true,
      ats: "adzuna",
    }));
}

// ---- helpers ---------------------------------------------------------------

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const trackedApplyUrl = (r) =>
  `${APPLY_BASE}?${new URLSearchParams({ src: "github-dach", company: slug(r.company), url: r.url || "" })}`;
function daysAgo(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}
const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
const byRecent = (a, b) => (a.posted_days_ago ?? 9999) - (b.posted_days_ago ?? 9999) || a.company.localeCompare(b.company);

async function previousCount() {
  try {
    return JSON.parse(await readFile(join(DIR, "jobs.json"), "utf8")).count || 0;
  } catch {
    return 0;
  }
}

// ---- pipeline --------------------------------------------------------------

async function fetchAll(companies) {
  // Personio rate-limits by IP: one board at a time, with a pause. Everything
  // else runs 8 at a time.
  const isPersonio = (c) => c.ats === "personio";
  const fetchOne = (c) => {
    const adapter = ADAPTERS[c.ats];
    if (!adapter) return Promise.reject(new Error(`unknown ats "${c.ats}" (supported: ${SUPPORTED_ATS.join(", ")})`));
    return adapter(c).then((rows) => rows.map((r) => ({ ...r, ats: c.ats })));
  };
  const personio = companies.filter(isPersonio);
  const others = companies.filter((c) => !isPersonio(c));
  const [pRes, oRes] = await Promise.all([
    pool(personio, 1, async (c) => {
      try {
        return await fetchOne(c);
      } finally {
        await sleep(700);
      }
    }),
    pool(others, 8, fetchOne),
  ]);
  return [...personio.map((c, i) => [c, pRes[i]]), ...others.map((c, i) => [c, oRes[i]])];
}

async function run() {
  const seed = JSON.parse(await readFile(join(DIR, "seed.json"), "utf8"));
  const companies = seed.companies || [];
  const failed = [];
  const raw = [];
  const perAts = {};

  for (const [c, s] of await fetchAll(companies)) {
    const stat = (perAts[c.ats] ||= { boards: 0, failed: 0 });
    stat.boards++;
    if (s.status === "fulfilled") raw.push(...s.value);
    else {
      stat.failed++;
      failed.push(`${c.name} (${c.ats}/${c.token}): ${s.reason.message}`);
    }
  }

  if (ADZUNA_ID && ADZUNA_KEY) {
    const tasks = ADZUNA_TARGETS.flatMap((t) => t.cities.flatMap((city) => ADZUNA_QUERIES.map((what) => [t.country, city, what])));
    const res = await pool(tasks, 4, ([country, city, what]) => adzunaQuery(country, city, what));
    const stat = (perAts.adzuna = { boards: tasks.length, failed: 0 });
    res.forEach((s, i) => {
      if (s.status === "fulfilled") raw.push(...s.value);
      else (stat.failed++, failed.push(`Adzuna ${tasks[i].join("/")}: ${s.reason.message}`));
    });
  }

  const roles = [];
  for (const r of raw) {
    if (!r.title || !r.url) continue;
    const location = (r.location || "").replace(/\s+/g, " ").trim();
    const match = `${location} ${r.hint || ""}`;
    if (!r.dach && !isDach(match)) continue;
    const type = classifyType(r.title);
    if (!type) continue;
    roles.push({
      company: (r.company || "").trim(),
      title: r.title.replace(/\s+/g, " ").trim(),
      type,
      city: classifyCity(match),
      location,
      posted: r.posted,
      posted_days_ago: daysAgo(r.posted),
      raw_url: r.url,
      careerkit_apply_url: trackedApplyUrl(r),
      source: r.ats,
    });
  }

  const seen = new Set();
  const deduped = roles
    .sort(byRecent)
    .filter((r) => {
      const k = `${slug(r.company)}|${slug(r.title)}|${r.city}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.city.localeCompare(b.city) || a.type.localeCompare(b.type) || a.company.localeCompare(b.company));

  // ---- health guard ----
  const boards = Object.values(perAts).reduce((s, x) => s + x.boards, 0);
  const failedShare = boards ? failed.length / boards : 0;
  const prev = await previousCount();
  const problems = [];
  if (failedShare > MAX_FAILED_SHARE)
    problems.push(`${failed.length}/${boards} sources failed (${Math.round(failedShare * 100)}%, limit ${MAX_FAILED_SHARE * 100}%)`);
  if (!ALLOW_SHRINK && prev >= 100 && deduped.length < prev * (1 - MAX_SHRINK))
    problems.push(`roles dropped from ${prev} to ${deduped.length} (more than ${MAX_SHRINK * 100}%); set ALLOW_SHRINK=1 if intended`);

  console.log(`Sources: ${boards}  failed: ${failed.length}  roles: ${deduped.length} (last run: ${prev})`);
  console.log("by ats:", perAts);
  console.log("by city:", tally(deduped, "city"));
  console.log("by type:", tally(deduped, "type"));
  if (failed.length) console.log("failed sources:\n  " + failed.join("\n  "));
  if (problems.length) {
    console.error("\nHEALTH CHECK FAILED, nothing written:\n  " + problems.join("\n  "));
    process.exit(1);
  }

  // ---- write ----
  const generatedAt = new Date().toISOString();
  const companyCount = new Set(deduped.map((r) => r.company)).size;
  await writeFile(
    join(DIR, "jobs.json"),
    JSON.stringify(
      {
        generated_at: generatedAt,
        count: deduped.length,
        companies: companyCount,
        source: `public company job-board APIs (${Object.keys(perAts).join(", ")})`,
        health: { sources: boards, sources_failed: failed.length, by_ats: perAts },
        roles: deduped,
      },
      null,
      2,
    ),
  );
  await writeFile(join(DIR, "jobs.csv"), renderCsv(deduped));

  // lists/ is fully generated: clear stale pages (a city can drop to zero).
  await mkdir(join(DIR, "lists"), { recursive: true });
  for (const f of await readdir(join(DIR, "lists"))) if (f.endsWith(".md")) await rm(join(DIR, "lists", f));
  const date = generatedAt.slice(0, 10);
  for (const city of new Set(deduped.map((r) => r.city))) {
    const rows = deduped.filter((r) => r.city === city).sort(byRecent);
    await writeFile(join(DIR, "lists", `${slug(city)}.md`), renderListPage(city === OTHER ? "Einstiegsjobs an weiteren Orten in DACH" : `Einstiegsjobs in ${city}`, city === OTHER ? "Early-career jobs in other DACH towns" : `Early-career jobs in ${city}`, rows, date, { showCity: false }));
  }
  for (const type of TYPE_ORDER) {
    const rows = deduped.filter((r) => r.type === type).sort(byRecent);
    if (rows.length)
      await writeFile(join(DIR, "lists", `${slug(type)}.md`), renderListPage(`${TYPE_LABEL[type]} Jobs in DACH`, `${type} roles in Germany, Austria and Switzerland`, rows, date, { showCity: true }));
  }
  await writeFile(join(DIR, "README.md"), renderReadme(deduped, companyCount, companies.length, date));
}

// ---- render ----------------------------------------------------------------

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
// "Other DACH" is the data label for towns without their own bucket; readers see
// the town itself ("Reutlingen") and the section is called "Weitere Orte".
const OTHER = "Other DACH";
const cityLabel = (c) => (c === OTHER ? "Weitere Orte" : c);
const COUNTRY_ONLY = /^(DE|DEU|AT|AUT|CH|CHE|germany|deutschland|austria|österreich|switzerland|schweiz)$/i;
const town = (r) =>
  (r.location.split(/,| - |\/|\(/).map((p) => p.trim()).find((p) => p && !COUNTRY_ONLY.test(p)) || r.location).slice(0, 40);
const place = (r) => (r.city === OTHER ? town(r) : r.city);
const age = (r) => (r.posted_days_ago == null ? "" : r.posted_days_ago === 0 ? "heute" : `${r.posted_days_ago}d`);
const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

function renderCsv(rows) {
  const cols = ["company", "title", "type", "city", "location", "posted", "raw_url", "careerkit_apply_url"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

function table(rows, { showCity }) {
  // A section of "Weitere Orte" needs the town column even when grouped by city.
  showCity ||= rows.some((r) => r.city === OTHER);
  const L = [];
  L.push(showCity ? `| Rolle | Unternehmen | Ort | Typ | Alter | |` : `| Rolle | Unternehmen | Typ | Alter | |`);
  L.push(showCity ? `|---|---|---|---|---|---|` : `|---|---|---|---|---|`);
  for (const r of rows) {
    const cells = [`[${cell(r.title)}](${r.raw_url})`, `**${cell(r.company)}**`];
    if (showCity) cells.push(cell(place(r)));
    cells.push(r.type, age(r), `[Bewerben](${r.careerkit_apply_url})`);
    L.push(`| ${cells.join(" | ")} |`);
  }
  return L;
}

function renderListPage(titleDe, titleEn, rows, date, opts) {
  const L = [];
  L.push(`# ${titleDe}`);
  L.push("");
  L.push(`${titleEn}. **${rows.length} offene Stellen**, aktualisiert ${date}, neueste zuerst.`);
  L.push("");
  L.push(`[Zur Übersicht](../README.md) · [Alle Städte und Typen](../README.md#-finden) · [Careerkit: Lebenslauf passend zur Stelle](${INSTALL_URL})`);
  L.push("");
  L.push(...table(rows, opts));
  L.push("");
  L.push(`<sub>Automatisch generiert aus öffentlichen Job-APIs der Unternehmen. Quelle: [${REPO}](${REPO_URL}).</sub>`);
  return L.join("\n") + "\n";
}

function badge(label, message, color) {
  const esc = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__"));
  return `![${label}: ${message}](https://img.shields.io/badge/${esc(label)}-${esc(message)}-${color})`;
}

function renderReadme(roles, companyCount, seedCount, date) {
  const byCity = tally(roles, "city");
  const byType = tally(roles, "type");
  const cities = Object.keys(byCity).sort((a, b) => (a === OTHER) - (b === OTHER) || byCity[b] - byCity[a] || a.localeCompare(b));
  const fresh = roles.filter((r) => r.posted_days_ago != null && r.posted_days_ago <= NEW_DAYS).sort(byRecent);

  const L = [];
  L.push(`# Werkstudent, Praktikum & Absolventen Jobs in DACH`);
  L.push("");
  L.push(`${badge("offene Stellen", roles.length, "4c7a2e")} ${badge("Unternehmen", companyCount, "4c7a2e")} ${badge("aktualisiert", date, "blue")} ${badge("Update", "täglich", "blue")}`);
  L.push("");
  L.push(`Aktuelle Einstiegsjobs (Werkstudent, Praktikum, Absolvent, Junior) in Deutschland, Österreich und der Schweiz, direkt von den Karriereseiten der Unternehmen. Jeden Morgen automatisch aktualisiert.`);
  L.push("");
  L.push(`*English: a daily-updated list of working-student, internship, graduate and junior roles across Germany, Austria and Switzerland, pulled straight from company career pages. English-only roles: see [english-jobs-germany](https://github.com/heynish/english-jobs-germany).*`);
  L.push("");

  L.push(`## 🔎 Finden`);
  L.push("");
  L.push(`**Nach Typ:** ${TYPE_ORDER.filter((t) => byType[t]).map((t) => `[${t} (${byType[t]})](lists/${slug(t)}.md)`).join(" · ")}`);
  L.push("");
  L.push(`**Nach Stadt:** ${cities.map((c) => `[${cityLabel(c)} (${byCity[c]})](lists/${slug(c)}.md)`).join(" · ")}`);
  L.push("");
  L.push(`**Neu diese Woche:** [${fresh.length} Stellen](#-neu-diese-woche) · **Daten:** [jobs.json](jobs.json) · [jobs.csv](jobs.csv) (Excel / Google Sheets)`);
  L.push("");
  L.push(`> **Tipp:** Oben rechts auf **Watch** klicken, oder den [RSS-Feed](${REPO_URL}/commits/main.atom) abonnieren, um jeden Tag neue Stellen zu sehen. Mit \`Strg+F\` / \`Cmd+F\` findest du Unternehmen oder Stichworte (z. B. „Marketing", „Data").`);
  L.push("");

  L.push(`## ✍️ Schneller bewerben`);
  L.push("");
  L.push(`Mit der [Careerkit Extension](${INSTALL_URL}) passt du deinen Lebenslauf in Sekunden an jede Stelle an und prüfst ihn gegen ATS-Filter. Der Link **Bewerben** in jeder Zeile führt direkt zur Originalausschreibung.`);
  L.push("");
  L.push(`⭐ Nützlich? Ein Star hilft anderen Studierenden, die Liste zu finden.`);
  L.push("");

  L.push(`## 🆕 Neu diese Woche`);
  L.push("");
  if (fresh.length) {
    L.push(...table(fresh.slice(0, README_NEW_ROWS), { showCity: true }));
    if (fresh.length > README_NEW_ROWS) L.push("", `_…und ${fresh.length - README_NEW_ROWS} weitere, siehe die Seiten nach Stadt oder Typ oben._`);
  } else L.push(`_Diese Woche noch keine neuen Stellen._`);
  L.push("");

  L.push(`## 📍 Nach Stadt`);
  L.push("");
  for (const city of cities) {
    const rows = roles.filter((r) => r.city === city).sort(byRecent);
    L.push(`### ${cityLabel(city)} (${rows.length})`);
    L.push("");
    L.push(...table(rows.slice(0, README_ROWS_PER_CITY), { showCity: false }));
    L.push("");
    if (rows.length > README_ROWS_PER_CITY)
      L.push(`[Alle ${rows.length} Stellen ${city === OTHER ? "an weiteren Orten" : `in ${city}`} ansehen](lists/${slug(city)}.md)`, "");
  }

  L.push(`---`);
  L.push("");
  L.push(`## Spezialisierte Listen`);
  L.push("");
  L.push(`Täglich aus dieser Liste gefiltert:`);
  L.push("");
  L.push(`- 🎓 [**Studentenjobs (Werkstudent + Praktikum)**](https://github.com/heynish/studenten-jobs-dach): für Studierende`);
  L.push(`- 🌍 [**English-speaking jobs in Germany**](https://github.com/heynish/english-jobs-germany): no German required`);
  L.push(`- 💻 [**Absolventen- & Berufseinsteiger-Tech-Jobs**](https://github.com/heynish/absolventen-tech-jobs-dach): Informatik, Software, Data`);
  L.push("");
  L.push(`## Ein Unternehmen fehlt?`);
  L.push("");
  L.push(`[Unternehmen vorschlagen](${REPO_URL}/issues/new?template=add-company.yml) (Formular, kein Code nötig), oder direkt einen PR gegen [\`seed.json\`](seed.json) öffnen. Unterstützt werden öffentliche Job-Boards auf: ${SUPPORTED_ATS.map((a) => a[0].toUpperCase() + a.slice(1)).join(", ")}. Details in [CONTRIBUTING.md](CONTRIBUTING.md).`);
  L.push("");
  L.push(`## Wie es funktioniert`);
  L.push("");
  L.push(`- Jeden Morgen fragt eine GitHub Action die öffentlichen Job-APIs von über ${Math.floor(seedCount / 10) * 10} Unternehmen ab. Keine Job-Portale, kein Scraping von StepStone oder Indeed.`);
  L.push(`- Behalten werden Stellen in Deutschland, Österreich und der Schweiz, deren Titel eine Einstiegsrolle ist (Werkstudent, Praktikum/Intern, Absolvent/Graduate, Junior/Trainee).`);
  L.push(`- Fällt eine Quelle aus oder schrumpft die Liste plötzlich, wird nichts veröffentlicht und der Lauf schlägt sichtbar fehl, statt eine halbe Liste zu zeigen.`);
  L.push(`- Die Daten gibt es als [jobs.json](jobs.json) und [jobs.csv](jobs.csv). Frei nutzbar, ein Link zurück freut uns.`);
  L.push("");
  L.push(`<sub>Powered by [Careerkit](${INSTALL_URL}). Letzte Aktualisierung: ${date}.</sub>`);
  return L.join("\n") + "\n";
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
