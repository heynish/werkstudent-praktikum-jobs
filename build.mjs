#!/usr/bin/env node
// Werkstudent / Praktikum / Absolventen job list — generator.
// Fetches early-career roles from public ATS job-board APIs (Greenhouse/Lever/Ashby),
// filters to DACH, normalizes/dedups, renders README.md + jobs.json at repo root.
//
// Zero dependencies (Node 18+ global fetch). Run: node build.mjs
//
// Source is ONLY public per-company ATS APIs, which are built to be consumed.
// Do NOT add scrapers for StepStone/Indeed/aggregators (ToS risk).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));

// Careerkit links.
const INSTALL_URL = "https://careerkit.me/de"; // top CTA -> install funnel (live page)
const APPLY_BASE = "https://careerkit.me/api/apply"; // per-row tracked redirect (route TBD)
// While the /apply route does not exist, per-row "Bewerben" points to the real job
// URL (useful, no 404). jobs.json always carries the tracked link for later swap.
const TRACKED_APPLY = true;

// ---- classification --------------------------------------------------------

// Ordered most-specific first; first match wins. Word-boundary safe so "intern"
// does not match "internal"/"international".
const ROLE_TYPES = [
  { type: "Werkstudent", re: /werkstudent|working student/i },
  { type: "Praktikum", re: /praktik|internship|\bintern\b|praktikant/i },
  { type: "Absolvent", re: /absolvent|graduate|new[ -]?grad|berufseinsteiger/i },
  { type: "Junior", re: /\bjunior\b|entry[ -]?level|trainee|einsteiger/i },
];

const DACH_RE =
  /german|deutschland|\bberlin\b|munich|münchen|hamburg|cologne|köln|frankfurt|stuttgart|düsseldorf|dusseldorf|leipzig|dresden|nürnberg|nuremberg|austria|österreich|vienna|wien|graz|salzburg|switzerland|schweiz|zurich|zürich|geneva|genf|basel|\bat\b|\bch\b/i;

const CITY_MAP = [
  [/berlin/i, "Berlin"],
  [/munich|münchen/i, "Munich"],
  [/hamburg/i, "Hamburg"],
  [/cologne|köln/i, "Cologne"],
  [/frankfurt/i, "Frankfurt"],
  [/stuttgart/i, "Stuttgart"],
  [/düsseldorf|dusseldorf/i, "Düsseldorf"],
  [/leipzig/i, "Leipzig"],
  [/vienna|wien/i, "Vienna"],
  [/zurich|zürich/i, "Zurich"],
  [/remote/i, "Remote"],
];

const classifyType = (t) => ROLE_TYPES.find(({ re }) => re.test(t))?.type ?? null;
const classifyCity = (l) => CITY_MAP.find(([re]) => re.test(l))?.[1] ?? "Other DACH";
const isDach = (l) => DACH_RE.test(l);

// ---- ATS adapters ----------------------------------------------------------

async function fetchGreenhouse(c) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${c.token}/jobs`);
  return (d.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    location: (j.location || {}).name || "",
    url: j.absolute_url,
    posted: j.updated_at || j.first_published || null,
  }));
}
async function fetchLever(c) {
  const d = await getJson(`https://api.lever.co/v0/postings/${c.token}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => ({
    company: c.name,
    title: j.text,
    location: (j.categories || {}).location || "",
    url: j.hostedUrl,
    posted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}
async function fetchAshby(c) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${c.token}`);
  return (d.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    location: j.location || "",
    url: j.jobUrl || j.applyUrl,
    posted: j.publishedAt || null,
  }));
}
const ADAPTERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby };

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "werkstudent-praktikum-jobs/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---- Arbeitsagentur (German Federal Employment Agency) public jobs API -------
// Large legal DE source. Queried by early-career keyword x city. These are DE by
// construction, so we mark them dach:true and skip the location filter.
const AA_KEY = "jobboerse-jobsuche"; // well-known public client key for this API
const AA_QUERIES = ["Werkstudent", "Praktikum", "Absolvent", "Trainee", "Berufseinsteiger"];
const AA_CITIES = [
  "Berlin", "München", "Hamburg", "Köln", "Frankfurt", "Stuttgart",
  "Düsseldorf", "Leipzig", "Nürnberg", "Hannover", "Dortmund", "Bremen",
];
const AA_SIZE = 50;

async function aaQuery(was, wo) {
  try {
    const u = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=${encodeURIComponent(was)}&wo=${encodeURIComponent(wo)}&umkreis=0&size=${AA_SIZE}`;
    const res = await fetch(u, { headers: { "X-API-Key": AA_KEY, "user-agent": "werkstudent-praktikum-jobs/1.0" } });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.stellenangebote || [])
      .filter((j) => j.refnr && j.arbeitgeber)
      .map((j) => ({
        company: (j.arbeitgeber || "").trim(),
        title: (j.titel || j.beruf || "").trim(),
        location: (j.arbeitsort || {}).ort || wo,
        url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(j.refnr)}`,
        posted: j.aktuelleVeroeffentlichungsdatum || null,
        dach: true,
      }));
  } catch {
    return [];
  }
}

async function fetchArbeitsagentur() {
  const tasks = [];
  for (const was of AA_QUERIES) for (const wo of AA_CITIES) tasks.push(aaQuery(was, wo));
  return (await Promise.all(tasks)).flat();
}

// ---- helpers ---------------------------------------------------------------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const trackedApplyUrl = (r) =>
  `${APPLY_BASE}?${new URLSearchParams({ src: "github-dach", company: slug(r.company), url: r.url || "" })}`;
function daysAgo(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}
const tally = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});

// Cap roles per (city, type) so no single combo floods the list. Keeps the most
// recent, so the list stays comprehensive but readable.
const MAX_PER_COMBO = 30;
function capPerCombo(rows, n) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.city}|${r.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.posted_days_ago ?? 9999) - (b.posted_days_ago ?? 9999));
    out.push(...arr.slice(0, n));
  }
  return out;
}

// ---- pipeline --------------------------------------------------------------

async function run() {
  const seed = JSON.parse(await readFile(join(DIR, "seed.json"), "utf8"));
  const companies = seed.companies || [];
  const errors = [];

  const settled = await Promise.allSettled(
    companies.map((c) => (ADAPTERS[c.ats] || (() => Promise.reject(new Error(`unknown ats "${c.ats}"`))))(c)),
  );

  const raw = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") raw.push(...s.value);
    else errors.push(`${companies[i].name} (${companies[i].token}): ${s.reason.message}`);
  });

  // Arbeitsagentur (large public DE source) merged alongside the seed companies.
  try {
    raw.push(...(await fetchArbeitsagentur()));
  } catch (e) {
    errors.push(`arbeitsagentur: ${e.message}`);
  }

  const roles = [];
  for (const r of raw) {
    if (!r.title || !r.location) continue;
    if (!r.dach && !isDach(r.location)) continue;
    const type = classifyType(r.title);
    if (!type) continue;
    roles.push({
      company: r.company,
      title: r.title.trim(),
      type,
      city: classifyCity(r.location),
      location: r.location.trim(),
      posted: r.posted,
      posted_days_ago: daysAgo(r.posted),
      raw_url: r.url,
      careerkit_apply_url: trackedApplyUrl(r),
    });
  }

  const seen = new Set();
  let deduped = roles.filter((r) => {
    const k = `${slug(r.company)}|${slug(r.title)}|${r.city}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  deduped = capPerCombo(deduped, MAX_PER_COMBO);
  deduped.sort(
    (a, b) => a.city.localeCompare(b.city) || a.type.localeCompare(b.type) || a.company.localeCompare(b.company),
  );

  const generatedAt = new Date().toISOString();
  await writeFile(
    join(DIR, "jobs.json"),
    JSON.stringify({ generated_at: generatedAt, count: deduped.length, source: "company ATS boards (Greenhouse/Lever/Ashby) + Arbeitsagentur", roles: deduped }, null, 2),
  );
  await writeFile(join(DIR, "README.md"), renderReadme(deduped, companies, generatedAt, errors));

  console.log(`Companies: ${companies.length}  errors: ${errors.length}  roles: ${deduped.length}`);
  console.log("by city:", tally(deduped, "city"));
  console.log("by type:", tally(deduped, "type"));
  if (errors.length) console.log("errors:\n  " + errors.join("\n  "));
}

// ---- render ----------------------------------------------------------------

const escapePipe = (s) => String(s).replace(/\|/g, "\\|");

function renderReadme(roles, companies, generatedAt, errors) {
  const date = generatedAt.slice(0, 10);
  const byCity = tally(roles, "city");
  const cityOrder = [...new Set(roles.map((r) => r.city))].sort((a, b) => byCity[b] - byCity[a]);

  const L = [];
  L.push(`# Werkstudent · Praktikum · Absolventen Jobs in DACH`);
  L.push("");
  L.push(`> Aktuelle Einstiegsjobs (Werkstudent, Praktikum, Absolvent, Junior) in Deutschland, Österreich und der Schweiz. **Täglich automatisch aktualisiert.**`);
  L.push(`> A daily-updated list of early-career roles (working-student, internship, new-grad, junior) across Germany, Austria and Switzerland.`);
  L.push("");
  L.push(`**${roles.length} offene Stellen** · **${companies.length} Unternehmen** · aktualisiert **${date}**`);
  L.push("");
  L.push(`## In 10 Sekunden bewerben`);
  L.push(`Fülle jede Bewerbung automatisch aus und erstelle einen passenden, ATS-geprüften Lebenslauf mit der [**Careerkit Extension →**](${INSTALL_URL})`);
  L.push("");
  L.push(`⭐ Nützlich? Gib dem Repo einen Star, damit andere es finden.`);
  L.push("");
  L.push(`_Typen: **Werkstudent** · **Praktikum** (inkl. Internship) · **Absolvent** (New Grad) · **Junior**_`);
  L.push("");

  for (const city of cityOrder) {
    const rows = roles.filter((r) => r.city === city);
    L.push(`## ${city} (${rows.length})`);
    L.push("");
    L.push(`| Rolle | Unternehmen | Typ | Gepostet | |`);
    L.push(`|---|---|---|---|---|`);
    for (const r of rows) {
      const age = r.posted_days_ago == null ? "" : r.posted_days_ago === 0 ? "heute" : `vor ${r.posted_days_ago}d`;
      const applyHref = TRACKED_APPLY ? r.careerkit_apply_url : r.raw_url;
      L.push(`| [${escapePipe(r.title)}](${r.raw_url}) | ${escapePipe(r.company)} | ${r.type} | ${age} | [Bewerben](${applyHref}) |`);
    }
    L.push("");
  }

  L.push(`---`);
  L.push(`### Dein Unternehmen fehlt?`);
  L.push(`Öffne einen PR gegen \`seed.json\` (nur öffentliche Greenhouse/Lever/Ashby-Boards). Generator: \`build.mjs\`, läuft täglich per GitHub Action.`);
  L.push("");
  L.push(`<sub>Auto-generiert aus öffentlichen ATS-Job-APIs. Powered by [Careerkit](${INSTALL_URL}).${errors.length ? ` Quellen mit Fehler beim letzten Lauf: ${errors.length}.` : ""}</sub>`);
  return L.join("\n") + "\n";
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
