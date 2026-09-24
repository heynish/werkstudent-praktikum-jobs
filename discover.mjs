#!/usr/bin/env node
// Company discovery: the repeatable "top-up" tool.
//
// Reads candidates.json (an array of {name, ats, token}), probes each public ATS
// board with the same adapters the daily build uses, and reports how many DACH
// early-career roles each one has right now. Never invents tokens: a board that
// fails or has nothing in DACH is dropped.
//
// Workday candidates may give just "tenant|dc" plus optional "sites": [...]; the
// script tries those site names (and common defaults) and keeps the one that answers.
//
// Zero deps (Node 20+).
//   node discover.mjs            # report only
//   node discover.mjs --write    # also add the hits to seed.json
//   node discover.mjs --min 2    # require at least 2 DACH early-career roles (default 1)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ADAPTERS, getJson, pool, sleep } from "./adapters.mjs";
import { classifyType, isDach } from "./classify.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const MIN = Number(args[args.indexOf("--min") + 1]) || 1;

const WORKDAY_SITE_GUESSES = (tenant) => [
  "External", "Careers", "External_Careers", "ExternalCareers", "careers", tenant, `${tenant}_careers`, `${tenant}careers`, `${tenant}-careers`, "en-US",
];

async function resolveWorkday(c) {
  const [tenant, dc, site] = c.token.split("|");
  if (site) return c;
  for (const s of [...new Set([...(c.sites || []), ...WORKDAY_SITE_GUESSES(tenant)])]) {
    try {
      const d = await getJson(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${s}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      });
      if (Array.isArray(d.jobPostings)) return { ...c, token: `${tenant}|${dc}|${s}` };
    } catch {
      // try the next guess
    }
  }
  throw new Error("no workday site answered");
}

async function probe(c) {
  const resolved = c.ats === "workday" ? await resolveWorkday(c) : c;
  const rows = await ADAPTERS[resolved.ats](resolved);
  const dach = rows.filter((r) => r.title && isDach(r.location || ""));
  return { entry: { name: c.name, ats: resolved.ats, token: resolved.token }, jobs: rows.length, dach: dach.length, dachEC: dach.filter((r) => classifyType(r.title)).length };
}

async function run() {
  const candidates = JSON.parse(await readFile(join(DIR, "candidates.json"), "utf8"));
  const seed = JSON.parse(await readFile(join(DIR, "seed.json"), "utf8"));
  const key = (c) => (c.ats === "workday" ? `workday:${c.token.split("|").slice(0, 2).join("|")}` : `${c.ats}:${c.token.toLowerCase()}`);
  const have = new Set((seed.companies || []).map(key));
  const todo = [];
  for (const c of candidates) {
    if (!ADAPTERS[c.ats]) console.log(`skip    ${c.ats}/${c.token} (unsupported ats)`);
    else if (!have.has(key(c))) (have.add(key(c)), todo.push(c));
  }
  console.log(`${candidates.length} candidates, ${todo.length} not yet in seed.json\n`);

  // Personio rate-limits hard by IP: give it its own one-at-a-time lane, and run
  // every other ATS in parallel next to it.
  const isPersonio = (c) => c.ats === "personio";
  const personioIdx = todo.flatMap((c, i) => (isPersonio(c) ? [i] : []));
  const otherIdx = todo.flatMap((c, i) => (isPersonio(c) ? [] : [i]));
  const [pRes, oRes] = await Promise.all([
    pool(personioIdx, 1, async (i) => {
      try {
        return await probe(todo[i]);
      } finally {
        await sleep(800);
      }
    }),
    pool(otherIdx, 6, (i) => probe(todo[i])),
  ]);
  const results = [];
  personioIdx.forEach((i, k) => (results[i] = pRes[k]));
  otherIdx.forEach((i, k) => (results[i] = oRes[k]));

  const hits = [];
  results.forEach((r, i) => {
    const c = todo[i];
    if (r.status === "rejected") return console.log(`x       ${c.ats}/${c.token} (${r.reason.message.slice(0, 80)})`);
    const { entry, jobs, dach, dachEC } = r.value;
    console.log(`${dachEC >= MIN ? "HIT" : "ok "} ${String(jobs).padStart(5)} jobs  dach=${dach} early-career=${dachEC}  ${entry.ats}/${entry.token}`);
    if (dachEC >= MIN) hits.push({ ...r.value });
  });

  hits.sort((a, b) => b.dachEC - a.dachEC);
  console.log(`\n${hits.length} new board(s) with >= ${MIN} DACH early-career role(s), ${hits.reduce((s, h) => s + h.dachEC, 0)} roles total.`);
  if (!WRITE) {
    for (const h of hits) console.log(`  ${JSON.stringify({ ...h.entry, careers_url: "" })},  // ${h.dachEC}`);
    return console.log("\nRe-run with --write to add them to seed.json.");
  }
  seed.companies = [...seed.companies, ...hits.map((h) => ({ ...h.entry, careers_url: "" }))].sort((a, b) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
  );
  await writeFile(join(DIR, "seed.json"), JSON.stringify(seed, null, 2) + "\n");
  console.log(`seed.json now has ${seed.companies.length} companies.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
