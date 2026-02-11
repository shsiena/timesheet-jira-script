#!/usr/bin/env bun

// Jira Timesheet Activity Fetcher
// Fetches tickets you created and status changes you made, grouped by week

const JIRA_BASE_URL = process.env.JIRA_BASE_URL; // e.g., https://yourcompany.atlassian.net
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing required environment variables:");
  console.error("  JIRA_BASE_URL - e.g., https://yourcompany.atlassian.net");
  console.error("  JIRA_EMAIL    - your Jira account email");
  console.error("  JIRA_API_TOKEN - from https://id.atlassian.com/manage-profile/security/api-tokens");
  process.exit(1);
}

const AUTH_HEADER = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;

interface JiraIssue {
  key: string;
  fields: {
    created: string;
    summary: string;
    creator: { accountId: string };
  };
}

interface ChangelogItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

interface ChangelogHistory {
  author: { accountId: string };
  created: string;
  items: ChangelogItem[];
}

interface TicketAction {
  ticketKey: string;
  summary: string;
  action: string;
  date: Date;
}

async function jiraFetch(endpoint: string, params?: Record<string, string>, retries = 3): Promise<any> {
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: AUTH_HEADER,
      Accept: "application/json",
    },
  });

  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "30", 10);
    console.error(`  Rate limited, waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return jiraFetch(endpoint, params, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function getCurrentUserId(): Promise<string> {
  const user = await jiraFetch("/myself");
  return user.accountId;
}

async function searchIssues(jql: string): Promise<JiraIssue[]> {
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const data = await jiraFetch("/search/jql", {
      jql,
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: "key,created,summary,creator",
    });

    allIssues.push(...data.issues);

    // New API uses isLast instead of total
    if (data.isLast || data.issues.length === 0) break;
    startAt += data.issues.length;
  }

  return allIssues;
}

async function getIssueChangelog(issueKey: string): Promise<ChangelogHistory[]> {
  const allHistories: ChangelogHistory[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const data = await jiraFetch(`/issue/${issueKey}/changelog`, {
      startAt: String(startAt),
      maxResults: String(maxResults),
    });

    const values = data.values || [];
    allHistories.push(...values);

    // Handle both old (total) and new (isLast) pagination styles
    const isDone = data.isLast || values.length === 0 ||
      (data.total !== undefined && startAt + values.length >= data.total);
    if (isDone) break;
    startAt += values.length;
  }

  return allHistories;
}

function getWeekKey(date: Date): string {
  // Get Monday of the week
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(d);
  endOfWeek.setDate(d.getDate() + 6);

  const format = (dt: Date) =>
    `${dt.toLocaleString("en-US", { month: "short" })} ${dt.getDate()}`;

  return `${format(d)} - ${format(endOfWeek)}, ${d.getFullYear()}`;
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function main() {
  const weeksBack = parseInt(process.argv[2] || "8", 10);
  console.error(`Fetching Jira activity for the past ${weeksBack} weeks...\n`);

  const userId = await getCurrentUserId();
  console.error(`Logged in as account: ${userId}\n`);

  const actions: TicketAction[] = [];
  const summaries: Map<string, string> = new Map();

  // 1. Get tickets created by user
  console.error("Fetching tickets you created...");
  const createdIssues = await searchIssues(
    `creator = currentUser() AND created >= -${weeksBack}w ORDER BY created DESC`
  );
  console.error(`  Found ${createdIssues.length} created tickets`);

  for (const issue of createdIssues) {
    summaries.set(issue.key, issue.fields.summary);
    actions.push({
      ticketKey: issue.key,
      summary: issue.fields.summary,
      action: "created",
      date: new Date(issue.fields.created),
    });
  }

  // 2. Get tickets where user changed status
  console.error("Fetching tickets where you changed status...");
  const statusChangedIssues = await searchIssues(
    `status changed BY currentUser() AFTER -${weeksBack}w ORDER BY updated DESC`
  );
  console.error(`  Found ${statusChangedIssues.length} tickets with status changes`);

  // 3. Fetch changelogs to get actual transition details
  console.error("Fetching changelog details...");
  let processed = 0;
  for (const issue of statusChangedIssues) {
    summaries.set(issue.key, issue.fields.summary);

    const changelog = await getIssueChangelog(issue.key);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - weeksBack * 7);

    for (const history of changelog) {
      const changeDate = new Date(history.created);
      if (changeDate < cutoffDate) continue;
      if (history.author.accountId !== userId) continue;

      for (const item of history.items) {
        if (item.field === "status") {
          actions.push({
            ticketKey: issue.key,
            summary: issue.fields.summary,
            action: `moved from "${item.fromString}" to "${item.toString}"`,
            date: changeDate,
          });
        }
      }
    }

    processed++;
    if (processed % 10 === 0) {
      console.error(`  Processed ${processed}/${statusChangedIssues.length} changelogs`);
    }
  }

  // 4. Group by week, then by ticket
  const weekMap: Map<string, Map<string, string[]>> = new Map();

  // Sort actions by date to ensure proper ordering
  actions.sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const action of actions) {
    const weekKey = getWeekKey(action.date);

    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, new Map());
    }

    const ticketMap = weekMap.get(weekKey)!;
    if (!ticketMap.has(action.ticketKey)) {
      ticketMap.set(action.ticketKey, []);
    }

    ticketMap.get(action.ticketKey)!.push(action.action);
  }

  // 5. Sort weeks chronologically and output
  const sortedWeeks = [...weekMap.entries()].sort((a, b) => {
    // Parse first date from week key for sorting
    const parseWeekStart = (key: string) => {
      const match = key.match(/^(\w+) (\d+)/);
      if (!match) return new Date(0);
      return new Date(`${match[1]} ${match[2]}, ${key.split(", ")[1]}`);
    };
    return parseWeekStart(a[0]).getTime() - parseWeekStart(b[0]).getTime();
  });

  console.log("\n" + "=".repeat(60));
  console.log("JIRA ACTIVITY BY WEEK");
  console.log("=".repeat(60));

  for (const [weekKey, ticketMap] of sortedWeeks) {
    console.log(`\n📅 Week of ${weekKey}:`);
    console.log("-".repeat(40));

    const sortedTickets = [...ticketMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    for (const [ticketKey, ticketActions] of sortedTickets) {
      const summary = summaries.get(ticketKey) || "";
      const truncatedSummary =
        summary.length > 50 ? summary.slice(0, 47) + "..." : summary;
      console.log(`  ${ticketKey}: ${ticketActions.join(", ")}`);
      console.log(`    └─ ${truncatedSummary}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${actions.length} actions across ${weekMap.size} weeks`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
