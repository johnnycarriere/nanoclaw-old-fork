---
name: handoff
description: Work Baw's queued dev handoffs. Use when Johnny types /handoff, says "check the handoff queue", "work the handoff", or "Baw sent a handoff". Pulls the oldest handoff from groups/telegram_main/handoffs/queue/, does the work, archives it, and notifies Baw. `/handoff watch` arms a live watcher for new handoffs in this session.
---

# Handoff — work Baw's queued dev tasks

Baw De Claw writes dev handoffs (markdown files) into `groups/telegram_main/handoffs/queue/` from inside its container (`/workspace/agent/handoffs/queue/`). This skill is the pull side: pick one up, do the work, close the loop.

## `/handoff` (default)

1. **List the queue**: `ls -t groups/telegram_main/handoffs/queue/`. If empty, say so and stop. If Johnny named a specific file/topic, pick that; otherwise pick the **oldest**. If several are queued, show the list and which one you're starting.
2. **Claim it (atomic — prevents two sessions racing on the same task):** `mv groups/telegram_main/handoffs/queue/<file> groups/telegram_main/handoffs/working/<file>`. If the `mv` fails because the file is gone, another Claude Code session claimed it first — say so and stop (do NOT work it from memory). A file older than ~6h in `working/` is an abandoned claim from a dead session: reclaim it by working it from there, and say you did. (Two sessions worked the same handoff in parallel on 2026-08-07 — this step is the fix.)
3. **Read the handoff** (now in `working/`) and restate the task in one sentence so Johnny can course-correct before work starts.
4. **Do the work.** Handoffs usually target other repos/hosts (dexbaw, Refinery Linode, etc.) — use absolute paths, and check auto-memory first: most of Johnny's apps have a memory file with gotchas that will save you from known traps. Verify before claiming done (run it, curl it, check the log). Honor standing rules: repos stay private, live `dexbaw.service` is never restarted/hot-edited unless the handoff explicitly allows it, verify interactive UI in a real browser.
5. **Close the loop** (all three, in order):
   - Move the file: `mv groups/telegram_main/handoffs/working/<file> groups/telegram_main/handoffs/done/`
   - Append a dated entry to `groups/telegram_main/claude-dev-log.md` (newest-first, `## YYYY-MM-DD — Title` + `**TL;DR for you, Baw:**` paragraph — match the existing entries).
   - Notify Baw so it can relay to Johnny: `pnpm exec tsx scripts/notify-baw.ts --text "<short completion report — what shipped, where, how verified, anything open. Written to be relayed to Johnny nearly verbatim.>"`

## `/handoff watch`

Arm a persistent Monitor on the queue so new handoffs pop into this session live (run from the repo root):

```bash
Q=groups/telegram_main/handoffs/queue; known=$(ls "$Q" 2>/dev/null | sort); while true; do now=$(ls "$Q" 2>/dev/null | sort); new=$(comm -13 <(echo "$known") <(echo "$now")); [ -n "$new" ] && echo "NEW HANDOFF from Baw: $new"; known="$now"; sleep 15; done
```

Run it via the Monitor tool (`persistent: true`). When a NEW HANDOFF event fires, tell Johnny what arrived and start on it (per the default flow **including the claim step**) unless he redirects.

## Notes

- Queue = to do, `working/` = claimed by a live session, `done/` = finished archive, flat files in `handoffs/` root = pre-queue legacy handoffs (already handled or superseded — don't work them).
- This is the **Johnny-at-the-desk lane**. The **async lane** is the `claude-dev` NanoClaw agent (Baw `send_message` → approval card → containerized run) — see auto-memory `claude-dev-agent-group`. Same task should not go down both lanes.
