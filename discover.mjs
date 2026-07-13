#!/usr/bin/env node
// Company discovery helper — the repeatable "top-up" tool.
//
// Reads candidates.json (an array of {name, ats, token}), probes each public ATS
// board, and prints seed.json-ready entries for the ones that (a) actually resolve
// and (b) aren't already in seed.json. Never invents tokens: if a board 404s or is
// empty, it's dropped. Personio rate-limits by IP, so those are probed sequentially.
//
// Zero deps (Node 18+). Run: node discover.mjs
// Then paste the printed entries into seed.json (kept alphabetical) and open a PR.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));

const ROLE = [
  /werkstudent|working student/i,
  /praktik|internship|\bintern\b|praktikant/i,
  /absolvent|graduate|new[ -]?grad|berufseinsteiger/i,
  /\bjunior\b|entry[ -]?level|trainee|einsteiger/i,
];
const DACH =
  /german|deutschland|berlin|münchen|munich|hamburg|köln|cologne|frankfurt|stuttgart|düsseldorf|leipzig|dresden|nürnberg|hannover|dortmund|bremen|mannheim|wien|vienna|graz|linz|salzburg|innsbruck|zürich|zurich|genf|geneva|basel|bern|lausanne|remote|deutschlandweit|österreich|austria|schweiz|switzerland|\bat\b|\bch\b/i;
const isEC = (t) => ROLE.some((re) => re.test(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "user-agent": "werkstudent-praktikum-jobs-discover/1.0" };

async function boardTitles(ats, token) {
  if (ats === "greenhouse") {
    const d = await (await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, { headers: UA })).json();
    return (d.jobs || []).map((j) => [j.title, (j.location || {}).name || ""]);
  }
  if (ats === "lever") {
    const d = await (await fetch(`https://api.lever.co/v0/postings/${token}?mode=json`, { headers: UA })).json();
    return (Array.isArray(d) ? d : []).map((j) => [j.text, (j.categories || {}).location || ""]);
  }
  if (ats === "ashby") {
    const d = await (await fetch(`https://api.ashbyhq.com/posting-api/job-board/${token}`, { headers: UA })).json();
    return (d.jobs || []).map((j) => [j.title, j.location || ""]);
  }
  if (ats === "personio") {
    const t = await (await fetch(`https://${token}.jobs.personio.de/xml`, { headers: UA })).text();
    const names = [...t.matchAll(/<position>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
    const offices = [...t.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((m) => m[1].trim());
    return names.map((n, i) => [n, offices[i] || ""]);
  }
  throw new Error(`unknown ats ${ats}`);
}

async function run() {
  const candidates = JSON.parse(await readFile(join(DIR, "candidates.json"), "utf8"));
  const seed = JSON.parse(await readFile(join(DIR, "seed.json"), "utf8"));
  const have = new Set((seed.companies || []).map((c) => `${c.ats}:${c.token}`));

  const hits = [];
  for (const c of candidates) {
    if (have.has(`${c.ats}:${c.token}`)) continue; // already seeded
    try {
      const rows = await boardTitles(c.ats, c.token);
      if (!rows.length) {
        console.log(`empty   ${c.ats}/${c.token}`);
      } else {
        const ec = rows.filter(([t]) => isEC(t)).length;
        const dachEC = rows.filter(([t, l]) => isEC(t) && (DACH.test(l) || DACH.test(t))).length;
        console.log(`OK ${String(rows.length).padStart(4)}  EC=${ec} dachEC=${dachEC}  ${c.ats}/${c.token}`);
        hits.push({ ...c, _jobs: rows.length, _ec: ec, _dachEC: dachEC });
      }
    } catch (e) {
      console.log(`x       ${c.ats}/${c.token} (${e.message})`);
    }
    if (c.ats === "personio") await sleep(500); // Personio rate-limits hard by IP
  }

  console.log(`\n${hits.length} new resolving board(s). Paste into seed.json (keep alphabetical):\n`);
  for (const h of hits.sort((a, b) => b._dachEC - a._dachEC)) {
    console.log(`  { "name": "${h.name}", "ats": "${h.ats}", "token": "${h.token}", "careers_url": "" },  // ${h._jobs} jobs, ${h._dachEC} DACH early-career`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
