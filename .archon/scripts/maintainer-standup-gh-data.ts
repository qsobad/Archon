#!/usr/bin/env bun
/**
 * Fetches GitLab data for the maintainer-standup synthesis: all open MRs
 * (light metadata), review-requested MRs, authored-by-me MRs, assigned issues,
 * recent unlabeled issues, and recently-closed MRs/issues since the last run.
 *
 * Reads gh_handle (the maintainer's GitLab username) from
 * .archon/maintainer-standup/profile.md frontmatter. The frontmatter key is
 * still `gh_handle` for backwards compatibility — set it to the GitLab username.
 *
 * Output: JSON to stdout. Field names follow GitLab conventions
 * (iid / source_branch / target_branch / merge_status / draft / web_url /
 * created_at / updated_at / closed_at / merged_at / author.username); the
 * synthesizer in maintainer-standup.md / maintainer-review-gate.md is aware
 * of these names.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// execFileSync with argv arrays — avoids shell-string interpolation and the
// associated quoting hazards (esp. for handles loaded from profile.md).
function exec(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    process.stderr.write(`${file} command failed: ${file} ${args.join(' ')}\n${(e as Error).message}\n`);
    return '[]';
  }
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ── Load gh_handle (GitLab username) from profile.md frontmatter ──
let ghHandle = '';
const profilePath = resolve(process.cwd(), '.archon/maintainer-standup/profile.md');
if (existsSync(profilePath)) {
  const profile = readFileSync(profilePath, 'utf8');
  const match = profile.match(/^gh_handle:\s*(\S+)\s*$/m);
  if (match) ghHandle = match[1];
}
if (!ghHandle) {
  process.stderr.write('Warning: no gh_handle (GitLab username) found in profile.md frontmatter\n');
}

// ── Load prior state to scope "recently closed" lookups ──
let lastRunAt = '';
const statePath = resolve(process.cwd(), '.archon/maintainer-standup/state.json');
if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { last_run_at?: string };
    lastRunAt = state.last_run_at ?? '';
  } catch {
    // ignore corrupt state
  }
}

// ── Resolve the project's GitLab path/host once (used for /api/v4/projects/... calls) ──
function ownerRepo(): { host: string; path: string; encodedId: string } | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    // ssh: git@gitlab.example.com:owner/repo.git ; https: https://gitlab.example.com/owner/repo.git
    const m = url.match(/^(?:https?:\/\/|[^@]+@)([^:/]+)[:/](.+?)(?:\.git)?$/);
    if (!m) return null;
    const host = m[1];
    const path = m[2];
    return { host, path, encodedId: encodeURIComponent(path) };
  } catch {
    return null;
  }
}

const repo = ownerRepo();
const PROJECT_API = repo ? `projects/${repo.encodedId}` : null;
const HOSTNAME_FLAG = repo ? ['--hostname', repo.host] : [];

// ── Open MRs (full metadata for triage) ──
// glab mr list -F json returns an array of MRs with these fields:
// iid, title, author{username}, labels, created_at, updated_at, draft,
// merge_status, source_branch, target_branch, web_url. We do not get
// additions/deletions/changedFiles or mergeStateStatus/reviewDecision —
// downstream synth prompts have been adjusted to consume what glab provides.
const PR_LIMIT = 100; // glab's per-page max; for very busy repos consider
                     // a paginating wrapper via --paginate against the API.
const allOpenPrs = parseJson<unknown[]>(
  exec('glab', ['mr', 'list', '--per-page', String(PR_LIMIT), '-F', 'json']),
  [],
);
if (allOpenPrs.length === PR_LIMIT) {
  process.stderr.write(
    `Warning: hit per-page ${PR_LIMIT} on all_open_prs. Some MRs may be silently truncated; ` +
      `next-run "resolved since last run" detection will misclassify the dropped tail. ` +
      `Switch to glab api ${PROJECT_API}/merge_requests --paginate when this becomes a persistent issue.\n`,
  );
}

let reviewRequested: unknown[] = [];
let authoredByMe: unknown[] = [];
let issuesAssigned: unknown[] = [];

if (ghHandle) {
  // glab supports --reviewer / --author / --assignee directly.
  reviewRequested = parseJson<unknown[]>(
    exec('glab', ['mr', 'list', '--reviewer', ghHandle, '-F', 'json']),
    [],
  );
  authoredByMe = parseJson<unknown[]>(
    exec('glab', ['mr', 'list', '--author', ghHandle, '-F', 'json']),
    [],
  );
  issuesAssigned = parseJson<unknown[]>(
    exec('glab', ['issue', 'list', '--assignee', ghHandle, '-F', 'json']),
    [],
  );
}

// ── Recent unlabeled issues (last 7 days) ──
// glab issue list does not have a `--no-label` filter that takes a date range.
// Use the API directly: /projects/:id/issues?labels=None&created_after=...
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
const sevenDaysAgoISO = sevenDaysAgo.toISOString();
const sevenDaysAgoStr = sevenDaysAgoISO.slice(0, 10);
const recentUnlabeledIssues = PROJECT_API
  ? parseJson<unknown[]>(
      exec('glab', [
        'api',
        ...HOSTNAME_FLAG,
        `${PROJECT_API}/issues?state=opened&labels=None&created_after=${sevenDaysAgoISO}&per_page=30`,
      ]),
      [],
    )
  : [];

// ── Recently closed/merged since last run (or last 7 days as fallback) ──
const sinceDate = lastRunAt ? lastRunAt.slice(0, 10) : sevenDaysAgoStr;
const sinceISO = lastRunAt || sevenDaysAgoISO;
// GitLab's MR `state` is one of opened/closed/merged. Recently closed PRs in
// the GitHub sense covers both closed-without-merge AND merged. Pull both.
const recentlyClosedMrs = PROJECT_API
  ? parseJson<unknown[]>(
      exec('glab', [
        'api',
        ...HOSTNAME_FLAG,
        `${PROJECT_API}/merge_requests?state=all&updated_after=${sinceISO}&per_page=50`,
      ]),
      [],
    ).filter((m) => {
      const s = (m as { state?: string }).state;
      return s === 'closed' || s === 'merged';
    })
  : [];
const recentlyClosedIssues = PROJECT_API
  ? parseJson<unknown[]>(
      exec('glab', [
        'api',
        ...HOSTNAME_FLAG,
        `${PROJECT_API}/issues?state=closed&updated_after=${sinceISO}&per_page=50`,
      ]),
      [],
    )
  : [];

// ── Maintainer's recent commits on dev (what you shipped) ──
let myRecentCommits = '';
if (ghHandle) {
  const since = lastRunAt || '7 days ago';
  try {
    myRecentCommits = execFileSync(
      'git',
      ['log', 'origin/dev', `--since=${since}`, `--author=${ghHandle}`, '--no-decorate', '--format=%h %s'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
  } catch {
    myRecentCommits = '';
  }
}

// ── Replies since last run (contributor comments on MRs/issues) ──
// Fetches all conversation comments since the last run, filters out the
// maintainer's own comments, and groups by MR/issue iid. Lets the
// synthesizer surface "@author replied on MR !N" items for the maintainer
// to triage today.
//
// GitLab endpoints:
//   - /projects/:id/events?action=commented&after=DATE — surface what got
//     commented; use to discover the (target_iid, target_type) pairs.
//   - /projects/:id/merge_requests/:iid/notes — fetch notes per MR.
//   - /projects/:id/issues/:iid/notes — fetch notes per issue.
//
// We use the events API to discover commented MRs/issues since `lastRunAt`,
// then pull notes for each unique target. This matches the GitHub script's
// "comments since X" semantics without iterating every MR/issue in the project.
type GlabEvent = {
  action_name?: string;
  target_iid?: number;
  target_type?: string; // "MergeRequest" | "Issue"
  created_at?: string;
};

type GlabNote = {
  author?: { username?: string };
  created_at?: string;
  body?: string;
  system?: boolean;
};

type GroupedReply = {
  number: number;
  kind: 'issue' | 'pr_conversation' | 'pr_review';
  comments: {
    author: string;
    created_at: string;
    body_excerpt: string;
    url: string;
  }[];
};

const repliesByNumber: Record<number, GroupedReply> = {};

if (PROJECT_API && lastRunAt) {
  const openPrIids = new Set(
    (allOpenPrs as Array<{ iid?: number }>)
      .map((p) => p.iid)
      .filter((n): n is number => typeof n === 'number'),
  );

  const events = parseJson<GlabEvent[]>(
    exec('glab', [
      'api',
      ...HOSTNAME_FLAG,
      `${PROJECT_API}/events?action=commented&after=${lastRunAt.slice(0, 10)}&per_page=100`,
      '--paginate',
    ]),
    [],
  );

  // Deduplicate (iid, target_type) pairs we need to fetch notes for.
  const targets = new Map<string, { iid: number; type: 'MergeRequest' | 'Issue' }>();
  for (const ev of events) {
    if (ev.action_name !== 'commented on') continue;
    if (!ev.target_iid) continue;
    if (ev.target_type !== 'MergeRequest' && ev.target_type !== 'Issue') continue;
    targets.set(`${ev.target_type}#${ev.target_iid}`, { iid: ev.target_iid, type: ev.target_type });
  }

  const webBase = repo ? `https://${repo.host}/${repo.path}` : '';

  for (const { iid, type } of targets.values()) {
    const isMr = type === 'MergeRequest';
    const path = isMr
      ? `${PROJECT_API}/merge_requests/${iid}/notes?per_page=100`
      : `${PROJECT_API}/issues/${iid}/notes?per_page=100`;
    const notes = parseJson<GlabNote[]>(exec('glab', ['api', ...HOSTNAME_FLAG, path, '--paginate']), []);
    for (const n of notes) {
      if (n.system) continue; // skip system events ("commit added", "branch updated")
      if (!n.created_at || n.created_at < lastRunAt) continue;
      const author = n.author?.username;
      if (!author) continue;
      if (ghHandle && author.toLowerCase() === ghHandle.toLowerCase()) continue;
      // Skip GitLab bot accounts (e.g. project_NN_bot, marvin-mr-bot, etc.).
      // GitLab convention: bot accounts often end with `-bot` or `_bot` and have
      // `bot` types in the user object — we conservatively skip *_bot suffixes.
      if (/[-_]bot$/i.test(author)) continue;
      const kind: GroupedReply['kind'] = isMr
        ? openPrIids.has(iid) ? 'pr_conversation' : 'pr_review'
        : 'issue';
      if (!repliesByNumber[iid]) repliesByNumber[iid] = { number: iid, kind, comments: [] };
      const refUrl = webBase
        ? isMr
          ? `${webBase}/-/merge_requests/${iid}`
          : `${webBase}/-/issues/${iid}`
        : '';
      repliesByNumber[iid].comments.push({
        author,
        created_at: n.created_at ?? '',
        body_excerpt: (n.body ?? '').slice(0, 240).replace(/\s+/g, ' ').trim(),
        url: refUrl,
      });
    }
  }
}

const repliesSinceLastRun = Object.values(repliesByNumber).sort((a, b) => {
  const aLatest = a.comments[a.comments.length - 1]?.created_at ?? '';
  const bLatest = b.comments[b.comments.length - 1]?.created_at ?? '';
  return bLatest.localeCompare(aLatest); // newest first
});

console.log(
  JSON.stringify({
    gh_handle: ghHandle,
    since_date: sinceDate,
    all_open_prs: allOpenPrs,
    review_requested: reviewRequested,
    authored_by_me: authoredByMe,
    issues_assigned: issuesAssigned,
    recent_unlabeled_issues: recentUnlabeledIssues,
    recently_closed_prs: recentlyClosedMrs,
    recently_closed_issues: recentlyClosedIssues,
    my_recent_commits: myRecentCommits,
    replies_since_last_run: repliesSinceLastRun,
  }),
);
