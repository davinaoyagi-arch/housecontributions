const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const CONTRIBUTIONS_ENDPOINT = "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json";
const PUBLIC_RESEARCH_SITE = "https://davinaoyagi-arch.github.io/housecontributions/";
const requestBuckets = new Map();
let contextCache;

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
  };
  return contextCache;
}

function selectFor(groupBy) {
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
  const toDate = validDate(args.to_date || "", new Date().toISOString().slice(0, 10));
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
  const allowedGroups = ["donor_candidate_cycle", "donor", "candidate_cycle", "raw"];
  const groupBy = allowedGroups.includes(args.group_by) ? args.group_by : "donor_candidate_cycle";
  const fields = selectFor(groupBy);
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
  const aggregate = groupBy !== "raw";
  const order = aggregate
    ? args.sort_by === "frequency" ? "contributions DESC, total_amount DESC" : "total_amount DESC, contributions DESC"
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
    filters: { candidates: candidates.length, from_date: fromDate, to_date: toDate, election_period: args.election_period || "all", exclude_individuals: Boolean(args.exclude_individuals) },
    rows: await response.json(),
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
      to_date: { type: "string", description: "YYYY-MM-DD. Empty defaults to today." },
      exclude_individuals: { type: "boolean", description: "True limits results to organizational, PAC, party, union, and other non-individual contributor types." },
      group_by: { type: "string", enum: ["donor_candidate_cycle", "donor", "candidate_cycle", "raw"] },
      sort_by: { type: "string", enum: ["amount", "frequency", "date"] },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    required: ["candidate_names", "contributor_query", "election_period", "from_date", "to_date", "exclude_individuals", "group_by", "sort_by", "limit"],
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
    const instructions = `You are the research assistant inside the Hawaii House Leadership Research Desk. Answer concisely from the official filing data and role context. Use query_contributions for every numerical claim. Treat majority and minority leadership as separate cohorts. For historical first-winner questions, use first_winner_cycles rather than asking for cohort details already present there. A successful Democratic first-House-ballot cohort means partyAtWin is D and firstHouseBallot is true; query each election cycle separately from cycleStart through electionDay, then compare repeated reported donor names across the results. If a question asks whom to call, target, solicit, or approach based on political-giving history, do not create an individual-person prospect list. Instead, automatically provide a neutral historical analysis of recurring organizational, PAC, union, party, trade-association, business, and nonprofit contributors using exclude_individuals=true, and explain that substitution briefly. Distinguish reported contributor names from verified entities, never infer motive or influence, and flag alias, amendment, itemization, address, and timing limitations when relevant. If the data cannot support a claim, say so. Role and current-member context follows:\n${JSON.stringify(compactContext)}`;
    let input = [{ role: "user", content: question }], dataCalls = 0;
    for (let turn = 0; turn < 4; turn += 1) {
      const openAIResponse = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions, input, tools: [queryTool], tool_choice: "auto", reasoning: { effort: "low" }, max_output_tokens: 1400, store: false }),
      });
      const result = await openAIResponse.json();
      if (!openAIResponse.ok) throw new Error(result?.error?.message || `OpenAI returned ${openAIResponse.status}.`);
      const calls = (result.output || []).filter((item) => item.type === "function_call" && item.name === "query_contributions");
      if (!calls.length) {
        const answer = outputText(result);
        if (!answer) throw new Error("The model returned no readable answer.");
        return res.status(200).json({ answer, model, data_calls: dataCalls });
      }
      const outputs = [];
      for (const call of calls) {
        const args = JSON.parse(call.arguments || "{}");
        const data = await queryContributions(args, context);
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
