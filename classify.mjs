// Role-type + location classification, shared by build.mjs and discover.mjs.

// Ordered most-specific first; first match wins. Word-boundary safe so "intern"
// does not match "internal"/"international".
export const ROLE_TYPES = [
  { type: "Werkstudent", re: /werkstudent|working student|studentische|student assistant|student job/i },
  { type: "Praktikum", re: /praktik|internship|\bintern\b|\binterns\b|pflichtpraktik|stagiaire/i },
  { type: "Absolvent", re: /absolvent|graduate|new[ -]?grad|berufseinsteiger|direkteinstieg|young professional/i },
  { type: "Junior", re: /\bjunior\b|\bjr\.?\s|entry[ -]?level|trainee|einsteiger/i },
];

// Titles that match a role keyword but are not early-career roles.
const NOT_EARLY_CAREER = /\b(senior|lead|head of|principal|director|manager of interns)\b|ausbildung(?!sabschluss)|azubi/i;

// City matcher, label. Cities added after v1 use their German name; the original
// English labels (Munich, Cologne, Vienna, Zurich, ...) stay as they are because
// careerkit.me maps them by name. Order matters: first match wins.
export const CITY_MAP = [
  [/berlin/i, "Berlin"],
  [/munich|münchen|muenchen/i, "Munich"],
  [/hamburg/i, "Hamburg"],
  [/cologne|köln|koeln/i, "Cologne"],
  [/frankfurt/i, "Frankfurt"],
  [/stuttgart/i, "Stuttgart"],
  [/düsseldorf|dusseldorf|duesseldorf/i, "Düsseldorf"],
  [/leipzig/i, "Leipzig"],
  [/dresden/i, "Dresden"],
  [/nürnberg|nuremberg|nuernberg/i, "Nürnberg"],
  [/erlangen/i, "Erlangen"],
  [/hannover|hanover/i, "Hannover"],
  [/bremen/i, "Bremen"],
  [/\bessen\b/i, "Essen"],
  [/dortmund/i, "Dortmund"],
  [/\bbochum\b/i, "Bochum"],
  [/\bbonn\b/i, "Bonn"],
  [/mannheim/i, "Mannheim"],
  [/heidelberg/i, "Heidelberg"],
  [/walldorf/i, "Walldorf"],
  [/karlsruhe/i, "Karlsruhe"],
  [/darmstadt/i, "Darmstadt"],
  [/wiesbaden/i, "Wiesbaden"],
  [/\bmainz\b/i, "Mainz"],
  [/aachen/i, "Aachen"],
  [/münster|muenster/i, "Münster"],
  [/augsburg/i, "Augsburg"],
  [/ingolstadt/i, "Ingolstadt"],
  [/regensburg/i, "Regensburg"],
  [/wolfsburg/i, "Wolfsburg"],
  [/potsdam/i, "Potsdam"],
  [/freiburg/i, "Freiburg"],
  [/\bulm\b/i, "Ulm"],
  [/vienna|wien/i, "Vienna"],
  [/\bgraz\b/i, "Graz"],
  [/\blinz\b/i, "Linz"],
  [/salzburg/i, "Salzburg"],
  [/innsbruck/i, "Innsbruck"],
  [/zurich|zürich|zuerich/i, "Zurich"],
  [/winterthur/i, "Winterthur"],
  [/geneva|genf|genève/i, "Geneva"],
  [/\bbasel\b/i, "Basel"],
  [/\bbern\b/i, "Bern"],
  [/lausanne/i, "Lausanne"],
  [/\bzug\b|\bbaar\b/i, "Zug"],
  [/luzern|lucerne/i, "Luzern"],
  [/st\.? ?gallen/i, "St. Gallen"],
  [/remote|homeoffice|home office/i, "Remote"],
];

const DACH_WORDS =
  /german|deutschland|\bgermany\b|austria|österreich|oesterreich|switzerland|schweiz|suisse|svizzera|deutschlandweit|bundesweit/i;
// ISO country codes as ATSes print them ("Berlin, DE"). Case-sensitive on purpose
// so the English words "at"/"de" never match.
const DACH_CODES = /(^|[\s,(/-])(DE|DEU|AT|AUT|CH|CHE)($|[\s,)/-])/;

export const classifyType = (title) => {
  // "Senior ... Intern" is German for "internal", so only unambiguous student words
  // override the seniority exclusion ("Working Student Senior Management Support").
  if (NOT_EARLY_CAREER.test(title) && !/werkstudent|working student|praktik|internship/i.test(title)) return null;
  return ROLE_TYPES.find(({ re }) => re.test(title))?.type ?? null;
};

// A location counts as DACH if it names a DACH country or code, or a DACH city
// (the "Remote" bucket only counts together with a DACH country).
export const isDach = (loc) =>
  DACH_WORDS.test(loc) || DACH_CODES.test(loc) || CITY_MAP.some(([re, city]) => city !== "Remote" && re.test(loc));

export const classifyCity = (loc) => {
  // Multi-location postings ("London / Berlin"): prefer the first DACH city.
  const hit = CITY_MAP.find(([re, city]) => city !== "Remote" && re.test(loc));
  if (hit) return hit[1];
  if (/remote|homeoffice|home office/i.test(loc)) return "Remote";
  return "Other DACH";
};
