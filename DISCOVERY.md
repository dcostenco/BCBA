# Discovery channels — state and actions

Verified 2026-08-06. Baseline to measure against: **npm 1,762 downloads/week**
(2026-07-30 → 2026-08-05, api.npmjs.org).

The canonical one-line description (keep every surface consistent with this):

> Persistent session memory for AI coding agents — local-first, with on-device
> inference, associative recall, and drift detection. Works with Claude Code,
> Cursor, and Codex.

| Channel | State (verified) | Action |
|---|---|---|
| npm (`prism-mcp-server`) | ✅ published; keywords were 62 (spam signal), description was jargon | Fixed in this PR (12 keywords, plain description) |
| MCP Registry (`io.github.dcostenco/prism-coder`) | ✅ listed, but search is **name-only** — `memory` returns 0 hits | Description fixed here for downstream full-text indexes; registry search itself can't be fixed without a rename (breaks the pin — don't) |
| GitHub repo desc/topics | was jargon ("Hivemind, LLM fleet") | ✅ updated live 2026-08-06 via `gh repo edit` |
| Glama | schema allows `maintainers` only; listing derives from GitHub repo desc | Covered by the repo-description fix; verify listing after next crawl |
| Smithery | ❌ absent (`prism-coder`/`dcostenco` → 0; the listed "PRISM" is philongevity's, unrelated) | Submit at smithery.ai (account-bound — owner action) |
| `punkpeye/awesome-mcp-servers` (~60k★) | ⚠️ was stale (dead repo link, wrong-product badge) | ✅ update PR filed: [punkpeye#11632](https://github.com/punkpeye/awesome-mcp-servers/pull/11632) |
| `wong2/awesome-mcp-servers` | ❌ absent; **does not accept PRs** — submissions via the mcpservers.org/submit web form | Owner action: submit the canonical line via the form |
| mcp.so / PulseMCP | unverified | Check; submit only if registry syndication hasn't carried it |
| `.well-known/mcp.json` | **not a real discovery spec** — verified against MCP docs | No action; do not invent the file |
| Codex | no third-party directory exists (`openai/plugins` = examples only) | Hand out the two-liner (README/npm/site):<br>`codex plugin marketplace add dcostenco/prism-coder`<br>`codex plugin add prism-coder@prism` |
| Claude community marketplace | submitted 2026-08-06, **verified still pending 2026-08-18** in the Console status view (see below); the pending entry snapshots the pre-#128 form text as predicted | If listing shows old copy post-approval, amend via plugin review out-of-band |

## Paste-ready: `punkpeye/awesome-mcp-servers` (UPDATE the existing line)

Replace the existing `dcostenco/prism-mcp` line with:

```markdown
- [dcostenco/prism-coder](https://github.com/dcostenco/prism-coder) 📇 🏠 🍎 🪟 🐧 - Persistent session memory for AI coding agents — local-first, with on-device inference, associative recall, and drift detection. Works with Claude Code, Cursor, and Codex.
```

PR note: "Updates a stale entry: repo moved to prism-coder; the old line's Glama
badge pointed at a different server (dcostenco/BCBA)."

## Paste-ready: mcpservers.org/submit (covers wong2's list)

Use the canonical description above; repo URL `https://github.com/dcostenco/prism-coder`.

## Claude community submission — status mechanics (verified 2026-09-10)

Walked end-to-end so nobody re-derives this:

- **Status view for individual authors EXISTS**: Claude Console → your org →
  **Plugin submissions**. (Reached from the Console UI; `platform.claude.com/plugins`
  as a bare URL 404s — only `/plugins/submit` resolves directly, so navigate from
  the Console, not by URL.)
- **TWO entries are live, both pending** (screenshot-verified 2026-09-10):

  | Entry | Status | Submitted |
  |---|---|---|
  | `prism-coder` | Submitted and pending review | Sep 1 |
  | `synalux-prism` | Submitted and pending review | Aug 6 |

  This is the duplicate the rule below warns against: the Aug 6 entry was never
  withdrawn before the Sep 1 rename was resubmitted. `prism-coder` is the one
  that matches the current `.claude-plugin/plugin.json`; `synalux-prism` is a
  stale snapshot carrying the pre-#128 description. Withdraw or amend the Aug 6
  entry rather than filing a third.
- **No confirmation email is sent** for individual submissions — an empty
  inbox does NOT mean the submission was lost. The Console entry is the
  receipt. (Two weeks were nearly written off as a lost submission on this
  wrong assumption.)
- The claude.ai path (`admin-settings/directory/submissions`) is
  Team/Enterprise-only and rejects individual accounts.
- Approved plugins land SHA-pinned in `anthropics/claude-plugins-community`
  (nightly catalog sync, browsable at claude.com/plugins); the repo accepts
  no direct PRs. `synalux-prism` is name-free there; bare `prism` is taken
  by an unrelated plugin — irrelevant, but don't ever rename onto it.
- Pre-flight for any resubmission: `claude plugin validate ./plugins/prism
  --strict` (the pipeline runs the same check) — passed clean at 20.14.0.
- **Do not submit a duplicate while one is pending** — the queue entry is
  live; amend or wait instead.

## Paste-ready: amendment to Claude plugin review (submission shows old copy)

The pending `claude-community` submission snapshots the form text, so the
listing will publish with the pre-#128 description unless amended. Send via
the submission confirmation email / plugin-review channel:

> Subject: synalux-prism (pending review) — updated description
>
> While our submission for `synalux-prism` (repo
> `dcostenco/prism-coder`, path `plugins/prism`) is pending review, we
> refreshed the plugin description in the repo's `.claude-plugin/plugin.json`.
> If the published listing uses the form text rather than the manifest, please
> use the manifest description (current on `main`). No other change — same
> slug, same repo, same path. Thanks!

## Measurement

Re-check ~2 weeks after the external listings land:
- npm weekly downloads vs the 1,762 baseline
- Glama/Smithery full-text search for "session memory" surfaces Prism
- GitHub repo traffic (`gh api repos/dcostenco/prism-coder/traffic/views`)
