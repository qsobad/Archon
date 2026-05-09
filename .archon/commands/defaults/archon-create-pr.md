---
description: Create a PR from current branch with implementation context
argument-hint: [base-branch] (default: auto-detected from config or repo)
---

# Create Pull Request

**Base branch override**: $ARGUMENTS
**Default base branch**: $BASE_BRANCH

> If a base branch was provided as argument above, use it for `--base`. Otherwise use the default base branch.

---

## Pre-flight: Check for Existing PRs

Extract the issue number from the current branch name or context (e.g., `fix/issue-580` → `580`).

```bash
BRANCH=$(git branch --show-current)
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | tail -1)
```

If an issue number was found, search for open MRs that already reference it:

```bash
glab mr list \
  --search "Closes #${ISSUE_NUM}" \
  -F json
```

**If a matching MR is returned**: stop here, report the existing MR URL (`web_url`), and do **not** proceed to Phase 2 or Phase 3.

```
Existing MR found for issue #${ISSUE_NUM}: [web_url]
Skipping MR creation.
```

**If no match is found** (or no issue number could be extracted): continue to Phase 1.

---

## Phase 1: Gather Context

### 1.1 Check Git State

```bash
git branch --show-current
git status --short
git log origin/$BASE_BRANCH..HEAD --oneline
```

### 1.2 Check for Implementation Report

Look for the most recent implementation report:

```bash
ls -t $ARTIFACTS_DIR/../reports/*-report.md 2>/dev/null | head -1
```

If found, read it to extract:
- Summary of what was implemented
- Files changed
- Validation results
- Any deviations from plan

### 1.3 Get Commit Summary

```bash
git log origin/$BASE_BRANCH..HEAD --pretty=format:"- %s"
```

---

## Phase 2: Prepare Branch

### 2.1 Ensure All Changes Committed

If uncommitted changes exist:

```bash
git status --porcelain
```

**If dirty**:
1. Stage changes: `git add -A`
2. Commit: `git commit -m "Final changes before PR"`

### 2.2 Push Branch

```bash
git push -u origin HEAD
```

---

## Phase 3: Create PR

### 3.1 Check for MR Template

Look for the project's MR template at `.gitlab/merge_request_templates/Default.md`, `.gitlab/merge_request_templates/default.md`, or `docs/MERGE_REQUEST_TEMPLATE.md`. Read whichever one exists.

**If template found**: Use it as the structure, fill in **every section** with details from the implementation report and commits. Don't skip sections or leave placeholders.

**If no template**, use this format:

```markdown
## Summary

[Brief description from implementation report or commits]

## Changes

[List from implementation report "Files Changed" section, or from commits]
- file1.ts - description
- file2.ts - description

## Validation

[From implementation report "Validation Results" section]
- [x] Type check passes
- [x] Lint passes
- [x] Tests pass
- [x] Build succeeds

## Testing Notes

[Any manual testing done or integration test results]

---

[If from a GitLab issue, add: Closes #XXX]
```

### 3.2 Determine MR Title

**Title**: Concise, imperative mood
- From implementation report summary, OR
- From commit messages

### 3.3 Create the MR

```bash
# Write body to file to avoid shell escaping
cat > $ARTIFACTS_DIR/pr-body.md <<'EOF'
[body from above]
EOF

glab mr create \
  --title "[title]" \
  --description "$(cat $ARTIFACTS_DIR/pr-body.md)" \
  --target-branch $BASE_BRANCH \
  --yes
```

Or if the content is simple:

```bash
glab mr create --fill --target-branch $BASE_BRANCH --yes
```

After creating the MR, capture its identifiers for downstream steps. Only write artifacts if MR creation succeeded — never persist stale data from a pre-existing MR:

```bash
# After creating the MR, capture and persist the MR number for downstream steps
# IMPORTANT: Only write artifacts after confirmed successful MR creation
if MR_JSON=$(glab mr view -F json 2>/dev/null); then
  MR_NUMBER=$(echo "$MR_JSON" | jq -r '.iid')
  MR_URL=$(echo "$MR_JSON" | jq -r '.web_url')
  echo "$MR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"
  echo "$MR_URL" > "$ARTIFACTS_DIR/.pr-url"
else
  echo "WARNING: Could not confirm MR creation; skipping .pr-number/.pr-url artifacts"
fi
```

---

## Phase 4: Output

Report the result:

```markdown
## MR Created

**URL**: [MR URL]
**Branch**: [branch-name] → [target-branch]
**Title**: [MR title]

### Summary
[Brief summary of what the MR contains]

### Next Steps
1. Request review if needed
2. Address any CI failures
3. Merge when approved
```

---

## Error Handling

### No Commits to Push

```
No commits between origin/$BASE_BRANCH and HEAD.
Nothing to create an MR for.
```

### Branch Already Has MR

```bash
glab mr view --web
```

Opens the existing MR instead of creating a duplicate.

### Push Fails

1. Check if branch exists remotely: `git ls-remote --heads origin [branch]`
2. If conflicts: `git pull --rebase origin $BASE_BRANCH` then retry push
3. If permission issues: Check GitLab access
