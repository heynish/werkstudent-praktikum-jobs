// Public ATS adapters, shared by build.mjs (daily list) and discover.mjs (top-up).
//
// Every source here is a company's OWN public job-board API, built to be consumed
// by career sites and job widgets. No aggregators, no scraping of StepStone/Indeed.
//
// Each adapter takes a seed entry {name, ats, token} and returns raw rows:
//   { company, title, location, url, posted, hint? }
// `hint` is extra location text used only for matching, never displayed.
// Adapters THROW on a failed request so the build can count it as an error.
// Returning [] means "the board answered and has nothing".

const UA = { "user-agent": "werkstudent-praktikum-jobs/2.0 (+https://github.com/heynish/werkstudent-praktikum-jobs)" };
const TIMEOUT_MS = 25000;

// Retries 429 / 5xx / network errors with backoff; anything else fails at once.
async function request(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= 2) throw new Error(`${e.name === "TimeoutError" ? "timeout" : e.message} ${url}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 3000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const getJson = async (url, init = {}) =>
  (await request(url, { ...init, headers: { accept: "application/json", ...(init.headers || {}) } })).json();
export const getText = async (url) => (await request(url)).text();

export const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#0?38;/g, "&");

// Search terms for ATSes that can only be queried by keyword (Workday). Covers the
// German and English names of every role type the list tracks.
export const EARLY_CAREER_SEARCHES = ["Werkstudent", "Working Student", "Praktikum", "Intern", "Absolvent", "Graduate", "Trainee", "Junior"];

// ---- adapters --------------------------------------------------------------

async function greenhouse(c) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${c.token}/jobs`);
  return (d.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    location: (j.location || {}).name || "",
    url: j.absolute_url,
    posted: j.first_published || j.updated_at || null,
  }));
}

async function lever(c) {
  const d = await getJson(`https://api.lever.co/v0/postings/${c.token}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => ({
    company: c.name,
    title: j.text,
    location: [(j.categories || {}).location, ...((j.categories || {}).allLocations || [])].filter(Boolean).join(" / "),
    url: j.hostedUrl,
    posted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

async function ashby(c) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${c.token}`);
  return (d.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean).join(" / "),
    url: j.jobUrl || j.applyUrl,
    posted: j.publishedAt || null,
  }));
}

// Personio: public XML feed per customer. Most German SMB/scale-up hiring runs on it.
// Older accounts live on .de, newer ones on .com; try .de first.
async function personio(c) {
  let tld = "de";
  let xml;
  try {
    xml = await getText(`https://${c.token}.jobs.personio.de/xml`);
  } catch {
    tld = "com";
    xml = await getText(`https://${c.token}.jobs.personio.com/xml`);
  }
  const out = [];
  for (const block of xml.split("<position>").slice(1)) {
    const seg = block.split("</position>")[0];
    const pick = (tag) => {
      const m = seg.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    const id = pick("id");
    const name = decodeEntities(pick("name")); // first <name> is the title
    if (!id || !name) continue;
    const offices = [...seg.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((m) => decodeEntities(m[1].trim()));
    out.push({
      company: c.name,
      title: name,
      location: [...new Set(offices)].join(" / "),
      url: `https://${c.token}.jobs.personio.${tld}/job/${id}`,
      posted: pick("createdAt") || null,
    });
  }
  return out;
}

// SmartRecruiters public postings API. Big German employers (Bosch, Delivery Hero)
// post thousands of roles here; filter server-side by country to keep it light.
async function smartrecruiters(c) {
  const out = [];
  for (const country of ["de", "at", "ch"]) {
    for (let offset = 0; offset < 2000; offset += 100) {
      const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${c.token}/postings?limit=100&offset=${offset}&country=${country}`);
      const content = d.content || [];
      for (const p of content) {
        const loc = p.location || {};
        if (!["de", "at", "ch"].includes((loc.country || "").toLowerCase())) continue;
        out.push({
          company: (p.company || {}).name || c.name,
          title: p.name,
          location: loc.fullLocation || [loc.city, loc.country].filter(Boolean).join(", "),
          url: `https://jobs.smartrecruiters.com/${c.token}/${p.id}`,
          posted: p.releasedDate || null,
        });
      }
      if (content.length < 100) break;
    }
  }
  return out;
}

async function recruitee(c) {
  const d = await getJson(`https://${c.token}.recruitee.com/api/offers/`);
  return (d.offers || []).map((o) => ({
    company: c.name || o.company_name,
    title: o.title,
    location: o.location || [o.city, o.country].filter(Boolean).join(", "),
    url: o.careers_url || o.careers_apply_url,
    posted: o.published_at || o.created_at || null,
  }));
}

async function workable(c) {
  const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${c.token}`);
  return (d.jobs || []).map((j) => {
    const locs = (j.locations || []).map((l) => [l.city, l.country].filter(Boolean).join(", "));
    return {
      company: c.name || d.name,
      title: j.title,
      location: (locs.length ? locs : [[j.city, j.country].filter(Boolean).join(", ")]).join(" / "),
      url: j.url || j.application_url,
      posted: j.published_on || j.created_at || null,
    };
  });
}

async function teamtailor(c) {
  const d = await getJson(`https://${c.token}.teamtailor.com/jobs.json`);
  return (d.items || []).map((it) => {
    const jp = it._jobposting || {};
    const locs = (jp.jobLocation || []).map((l) => {
      const a = l.address || {};
      return [a.addressLocality, a.addressCountry].filter(Boolean).join(", ");
    });
    return {
      company: c.name,
      title: it.title || jp.title,
      location: locs.filter(Boolean).join(" / "),
      url: it.url,
      posted: jp.datePosted || it.date_published || null,
    };
  });
}

// Workday CXS: the JSON API behind every *.myworkdayjobs.com career site. Used by
// most large corporates. It can only be searched by keyword, so we run the early-
// career searches and keep the first pages. token = "tenant|dc|site".
function workdayPosted(s) {
  if (!s) return null;
  const now = Date.now();
  if (/today/i.test(s)) return new Date(now).toISOString();
  if (/yesterday/i.test(s)) return new Date(now - 86400000).toISOString();
  const m = s.match(/(\d+)\+?\s*days?/i);
  return m ? new Date(now - Number(m[1]) * 86400000).toISOString() : null;
}

const workdayPathCity = (path) => decodeURIComponent(path.split("/")[2] || "").replace(/-+/g, " ").trim();

async function workday(c) {
  const [tenant, dc, site] = c.token.split("|");
  if (!tenant || !dc || !site) throw new Error(`bad workday token "${c.token}"`);
  const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const seen = new Map();
  for (const searchText of EARLY_CAREER_SEARCHES) {
    for (let offset = 0; offset < 100; offset += 20) {
      const d = await getJson(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
      });
      const posts = d.jobPostings || [];
      for (const j of posts) if (j.externalPath) seen.set(j.externalPath, j);
      if (posts.length < 20) break;
    }
  }
  return [...seen.values()].map((j) => ({
    company: c.name,
    title: j.title,
    // Multi-location postings only say "3 Locations"; the URL path names the primary
    // city, so pass it along for the DACH filter, and show it when there is nothing else.
    location: j.locationsText || workdayPathCity(j.externalPath),
    hint: workdayPathCity(j.externalPath),
    url: `${base}/${site}${j.externalPath}`,
    posted: workdayPosted(j.postedOn),
  }));
}

export const ADAPTERS = { greenhouse, lever, ashby, personio, smartrecruiters, recruitee, workable, teamtailor, workday };
export const SUPPORTED_ATS = Object.keys(ADAPTERS);

// Run fn over items with at most `limit` in flight (polite to the ATS hosts).
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}
