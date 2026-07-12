const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const CONTRIBUTIONS_ENDPOINT = "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json";
const PUBLIC_RESEARCH_SITE = "https://davinaoyagi-arch.github.io/housecontributions/";
const requestBuckets = new Map();
let contextCache;
let horizonCache;

function allowedOrigin() {
  return process.env.RESEARCH_ALLOWED_ORIGIN?.trim() || "https://davinaoyagi-arch.github.io";
}

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin());
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
}

function requestAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === allowedOrigin();
}

function withinRateLimit(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now(), existing = requestBuckets.get(ip);
  if (!existing || now - existing.started > 60_000) {
    requestBuckets.set(ip, { started: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 20;
}

function soqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

async function loadContext() {
  if (contextCache) return contextCache;
  const response = await fetch(PUBLIC_RESEARCH_SITE, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error("The House research context could not be loaded.");
  const html = await response.text();
  const match = html.match(/window\.HOUSE_DATA=(\{.*?\});<\/script>/s);
  if (!match) throw new Error("The House research context was not found in the public site.");
  const source = JSON.parse(match[1]);
  contextCache = {
    currentMembers: source.currentMembers,
    periods: source.periods,
    roleChanges: source.roleChanges,
    winnerCycles: source.winnerCycles,
    suppliedFileAudit: source.suppliedFileAudit,
  };
  return contextCache;
}

async function currentMemberDataHorizon(context) {
  const now = Date.now();
  if (horizonCache && now - horizonCache.checkedAt < 15 * 60_000) return horizonCache.date;
  const candidates = context.currentMembers.map((member) => member.candidate);
  const params = new URLSearchParams({
    "$select": "max(date) as latest",
    "$where": `office='House' AND date >= '2026-01-01T00:00:00' AND candidate_name in(${candidates.map(soqlString).join(",")})`,
  });
  const response = await fetch(`${CONTRIBUTIONS_ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`The state campaign-data horizon query failed (${response.status}).`);
  const rows = await response.json();
  const fallback = context.suppliedFileAudit?.current_member_end_date || "2026-04-22";
  const date = String(rows[0]?.latest || fallback).slice(0, 10);
  horizonCache = { date, checkedAt: now };
  return date;
}

function selectFor(groupBy) {
  if (groupBy === "donor_name") return {
    select: "upper(contributor_name) as donor, sum(amount) as total_amount, count(*) as contributions, count(distinct candidate_name) as recipients",
    group: "upper(contributor_name)",
  };
  if (groupBy === "donor") return {
    select: "upper(contributor_name) as donor, contributor_type, upper(employer) as employer, sum(amount) as total_amount, count(*) as contributions, count(distinct candidate_name) as recipients",
    group: "upper(contributor_name), contributor_type, upper(employer)",
  };
  if (groupBy === "candidate_cycle") return {
    select: "candidate_name, election_period, sum(amount) as total_amount, count(*) as contributions, count(distinct contributor_name) as donors",
    group: "candidate_name, election_period",
  };
  if (groupBy === "raw") return {
    select: "contributor_name, candidate_name, date, amount, election_period, contributor_type, employer, occupation, city, state",
    group: "",
  };
  return {
    select: "upper(contributor_name) as donor, candidate_name, election_period, contributor_type, upper(employer) as employer, sum(amount) as total_amount, count(*) as contributions",
    group: "upper(contributor_name), candidate_name, election_period, contributor_type, upper(employer)",
  };
}

async function queryContributions(args, context) {
  const allCandidates = context.currentMembers.map((member) => member.candidate);
  const historicalCandidates = (context.winnerCycles || []).flatMap((cycle) => cycle.winners.map((winner) => winner.candidate));
  const canonical = new Map([...allCandidates, ...historicalCandidates].map((name) => [name.toLocaleLowerCase(), name]));
  const requested = (args.candidate_names || []).map((name) => canonical.get(String(name).toLocaleLowerCase())).filter(Boolean);
  const candidates = requested.length ? [...new Set(requested)] : allCandidates;
  const fromDate = validDate(args.from_date || "", "2020-01-01");
  const dataAvailableThrough = await currentMemberDataHorizon(context);
  const requestedToDate = validDate(args.to_date || "", "");
  const toDate = requestedToDate && requestedToDate < dataAvailableThrough ? requestedToDate : dataAvailableThrough;
  if (fromDate > toDate) throw new Error(`The requested start date is later than the latest available current-member receipt (${dataAvailableThrough}).`);
  const clauses = [
    "office='House'",
    `date >= '${fromDate}T00:00:00'`,
    `date <= '${toDate}T23:59:59'`,
    `candidate_name in(${candidates.map(soqlString).join(",")})`,
  ];
  if (args.election_period?.trim()) clauses.push(`election_period=${soqlString(args.election_period.trim())}`);
  if (args.exclude_individuals) clauses.push("contributor_type not in('Individual','Immediate Family')");
  if (args.contributor_query?.trim()) {
    const term = `%${args.contributor_query.trim().toLocaleLowerCase().replaceAll("%", "")}%`;
    const safe = soqlString(term);
    clauses.push(`(lower(contributor_name) like ${safe} or lower(employer) like ${safe} or lower(occupation) like ${safe})`);
  }
  const allowedGroups = ["donor_candidate_cycle", "donor_name", "donor", "candidate_cycle", "raw"];
  const groupBy = allowedGroups.includes(args.group_by) ? args.group_by : "donor_candidate_cycle";
  const fields = selectFor(groupBy);
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
  const aggregate = groupBy !== "raw";
  const order = aggregate
    ? args.sort_by === "recipients" && ["donor", "donor_name"].includes(groupBy)
      ? "recipients DESC, total_amount DESC"
      : args.sort_by === "frequency" ? "contributions DESC, total_amount DESC" : "total_amount DESC, contributions DESC"
    : args.sort_by === "amount" ? "amount DESC" : "date DESC";
  const params = new URLSearchParams({
    "$select": fields.select,
    "$where": clauses.join(" AND "),
    "$order": order,
    "$limit": String(limit),
  });
  if (fields.group) params.set("$group", fields.group);
  const response = await fetch(`${CONTRIBUTIONS_ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`The state campaign-data query failed (${response.status}).`);
  return {
    filters: { candidates: candidates.length, from_date: fromDate, to_date: toDate, data_available_through: dataAvailableThrough, election_period: args.election_period || "all", exclude_individuals: Boolean(args.exclude_individuals) },
    rows: await response.json(),
  };
}

async function queryFirstWinnerOverlap(args, context) {
  const selectedYears = new Set((args.years || []).map(Number).filter((year) => [2020, 2022, 2024].includes(year)));
  const party = args.party === "R" ? "R" : "D";
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
  const cohorts = [];

  for (const cycle of (context.winnerCycles || []).filter((entry) => !selectedYears.size || selectedYears.has(Number(entry.year)))) {
    const winners = cycle.winners.filter((winner) =>
      winner.partyAtWin === party && (!args.first_house_ballot_only || winner.firstHouseBallot),
    );
    if (!winners.length) continue;
    const clauses = [
      "office='House'",
      `date >= '${cycle.cycleStart}'`,
      `date <= '${cycle.electionDay}'`,
      "contributor_name is not null",
      `candidate_name in(${winners.map((winner) => soqlString(winner.candidate)).join(",")})`,
    ];
    if (args.exclude_individuals) clauses.push("contributor_type not in('Individual','Immediate Family')");
    const params = new URLSearchParams({
      "$select": "upper(contributor_name) as donor, candidate_name, sum(amount) as total_amount, count(*) as contributions",
      "$where": clauses.join(" AND "),
      "$group": "upper(contributor_name), candidate_name",
      "$order": "total_amount DESC",
      "$limit": "50000",
    });
    const response = await fetch(`${CONTRIBUTIONS_ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`The first-winner campaign-data query failed (${response.status}).`);
    const rows = await response.json();
    const donors = new Map();
    for (const row of rows) {
      const key = String(row.donor || "").trim().replace(/\s+/g, " ");
      const donor = donors.get(key) || { donor: key, recipients: new Set(), total_amount: 0, contributions: 0 };
      donor.recipients.add(row.candidate_name);
      donor.total_amount += Number(row.total_amount || 0);
      donor.contributions += Number(row.contributions || 0);
      donors.set(key, donor);
    }
    const ranked = [...donors.values()].map((donor) => ({
      donor: donor.donor,
      recipient_count: donor.recipients.size,
      recipient_names: [...donor.recipients].sort(),
      total_amount: donor.total_amount,
      contributions: donor.contributions,
    })).sort((a, b) => b.recipient_count - a.recipient_count || b.total_amount - a.total_amount || a.donor.localeCompare(b.donor));
    cohorts.push({
      year: cycle.year,
      window: { from_date: cycle.cycleStart.slice(0, 10), to_date: cycle.electionDay.slice(0, 10) },
      candidates: winners.map(({ name, candidate, district, partyAtWin, appointedIncumbent }) => ({ name, candidate, district, partyAtWin, appointedIncumbent: Boolean(appointedIncumbent) })),
      all: ranked,
      leading: ranked.slice(0, limit),
    });
  }

  const overlap = new Map();
  for (const cohort of cohorts) {
    for (const row of cohort.all) {
      const donor = overlap.get(row.donor) || { donor: row.donor, recipients: new Set(), cycles: new Set(), total_amount: 0, contributions: 0 };
      row.recipient_names.forEach((name) => donor.recipients.add(name));
      donor.cycles.add(cohort.year);
      donor.total_amount += row.total_amount;
      donor.contributions += row.contributions;
      overlap.set(row.donor, donor);
    }
  }
  const cross_cycle = [...overlap.values()].filter((donor) => donor.cycles.size >= 2).map((donor) => ({
    donor: donor.donor,
    recipient_count: donor.recipients.size,
    recipient_names: [...donor.recipients].sort(),
    cycle_count: donor.cycles.size,
    cycles: [...donor.cycles].sort(),
    total_amount: donor.total_amount,
    contributions: donor.contributions,
  })).sort((a, b) => b.recipient_count - a.recipient_count || b.cycle_count - a.cycle_count || b.total_amount - a.total_amount || a.donor.localeCompare(b.donor));

  return {
    definition: { party_at_win: party, first_house_ballot_only: Boolean(args.first_house_ballot_only), exclude_individuals: Boolean(args.exclude_individuals) },
    cohorts: cohorts.map(({ all, ...cohort }) => cohort),
    cross_cycle: cross_cycle.slice(0, limit),
    cross_cycle_count: cross_cycle.length,
    method_note: "Exact uppercase reported contributor names are compared without entity or alias consolidation.",
  };
}

const queryTool = {
  type: "function",
  name: "query_contributions",
  description: "Query Hawaii Campaign Spending Commission Schedule A receipts for current Hawaii House members and certified historical first-winner cohorts. Use this for every numerical contribution claim.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidate_names: { type: "array", items: { type: "string" }, description: "Exact candidate names. Empty means all current House members." },
      contributor_query: { type: "string", description: "Optional donor, employer, or occupation word fragment. Empty means any." },
      election_period: { type: "string", description: "Exact reported cycle, such as 2024-2026. Empty means any." },
      from_date: { type: "string", description: "YYYY-MM-DD. Empty defaults to 2020-01-01." },
      to_date: { type: "string", description: "YYYY-MM-DD. Empty defaults to the latest available 2026 receipt for the current elected House roster." },
      exclude_individuals: { type: "boolean", description: "True limits results to organizational, PAC, party, union, and other non-individual contributor types." },
      group_by: { type: "string", enum: ["donor_candidate_cycle", "donor_name", "donor", "candidate_cycle", "raw"] },
      sort_by: { type: "string", enum: ["amount", "frequency", "recipients", "date"] },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    required: ["candidate_names", "contributor_query", "election_period", "from_date", "to_date", "exclude_individuals", "group_by", "sort_by", "limit"],
  },
};

const firstWinnerOverlapTool = {
  type: "function",
  name: "query_first_winner_overlap",
  description: "Deterministically compare exact reported contributor names across certified Hawaii House first-winner election cohorts, including unique recipients and cross-cycle overlap.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      years: { type: "array", items: { type: "integer", enum: [2020, 2022, 2024] } },
      party: { type: "string", enum: ["D", "R"] },
      first_house_ballot_only: { type: "boolean" },
      exclude_individuals: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["years", "party", "first_house_ballot_only", "exclude_individuals", "limit"],
  },
};

function outputText(result) {
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text.trim();
  return (result.output || []).filter((item) => item.type === "message")
    .flatMap((item) => item.content || []).filter((item) => item.type === "output_text")
    .map((item) => item.text).join("\n").trim();
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!requestAllowed(req)) return res.status(403).json({ error: "Origin not allowed." });
  if (!withinRateLimit(req)) return res.status(429).json({ error: "Too many queries. Please wait one minute." });
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return res.status(503).json({ error: "Add OPENAI_API_KEY in the server environment." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length < 3 || question.length > 1200) return res.status(400).json({ error: "Question must contain between 3 and 1,200 characters." });
  try {
    const context = await loadContext();
    const compactContext = {
      current_members: context.currentMembers.map(({ candidate, name, district, party }) => ({ candidate, name, district, party })),
      role_periods: context.periods,
      role_changes: context.roleChanges,
      first_winner_cycles: context.winnerCycles,
    };
    const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
    const instructions = `You are the research assistant inside the Hawaii House Leadership Research Desk. Answer concisely from the official filing data and role context. Use a data tool for every numerical claim. All ordinary lookups stay limited to the current elected House roster. For current, latest, recent, or 2026 contribution questions, use the reported 2024-2026 election period when appropriate and leave to_date empty so the tool includes records through the latest available 2026 current-member receipt; never stop at December 31, 2025 unless the user explicitly requests that cutoff. Treat majority and minority leadership as separate cohorts. For historical first-winner or cross-cycle donor-overlap questions, always use query_first_winner_overlap instead of manually merging query results. A successful Democratic first-House-ballot cohort means party=D, first_house_ballot_only=true, and years=[2020,2022,2024]. Put the tool's cross_cycle table first, preserving its deterministic ranking and counts exactly, followed by no more than five leading rows from each cohort. If a question asks whom to call, target, solicit, or approach based on political-giving history, do not create an individual-person prospect list. Instead, automatically call query_first_winner_overlap with exclude_individuals=true and provide a neutral historical analysis of recurring organizational, PAC, union, party, trade-association, business, and nonprofit contributors, explaining that substitution briefly. Distinguish reported contributor names from verified entities, never infer motive or influence, and flag alias, amendment, itemization, address, and timing limitations when relevant. If the data cannot support a claim, say so. Role and current-member context follows:\n${JSON.stringify(compactContext)}`;
    let input = [{ role: "user", content: question }], dataCalls = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      const openAIResponse = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions, input, tools: [queryTool, firstWinnerOverlapTool], tool_choice: "auto", reasoning: { effort: "low" }, max_output_tokens: 2600, store: false }),
      });
      const result = await openAIResponse.json();
      if (!openAIResponse.ok) throw new Error(result?.error?.message || `OpenAI returned ${openAIResponse.status}.`);
      const calls = (result.output || []).filter((item) => item.type === "function_call" && ["query_contributions", "query_first_winner_overlap"].includes(item.name));
      if (!calls.length) {
        const answer = outputText(result);
        if (!answer) throw new Error("The model returned no readable answer.");
        return res.status(200).json({ answer, model, data_calls: dataCalls });
      }
      const outputs = [];
      for (const call of calls) {
        const args = JSON.parse(call.arguments || "{}");
        const data = call.name === "query_first_winner_overlap"
          ? await queryFirstWinnerOverlap(args, context)
          : await queryContributions(args, context);
        dataCalls += 1;
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(data) });
      }
      const callInputs = calls.map((call) => ({
        type: "function_call",
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments || "{}",
      }));
      input = [...input, ...callInputs, ...outputs];
    }
    return res.status(422).json({ error: "Please narrow the question." });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "The research query failed." });
  }
}
