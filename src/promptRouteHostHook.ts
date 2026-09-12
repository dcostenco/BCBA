/**
 * prism-route — self-installing UserPromptSubmit + SessionStart(compact) hook
 * for Claude Code + Codex.
 *
 * WHY A HOST HOOK. An MCP server never sees the user's prompt; the protocol
 * carries only what a tool call carries. session_route_prompt (the MCP tool)
 * therefore depends on the model deciding to call it — near-automatic at
 * best. A UserPromptSubmit hook is the only mechanism that fires on EVERY
 * prompt regardless of model behaviour, on both hosts, which is what the
 * operator requires ("i need automatic").
 *
 * WHY A SECOND EVENT. Compaction discards the bootstrap with the rest of the
 * transcript, and nothing the MCP server can do brings it back — the server
 * is never told a compaction happened. Both hosts run SessionStart hooks
 * with source "compact" before the next model request (Claude Code:
 * matcher "compact"; Codex hooks reference, verified 2026-09-01: "SessionStart
 * hooks that match source: compact run before the next model request"). The
 * same script answers that event with `prism floor-digest` — the protected
 * floor, one line per rule — so the model does not spend the rest of the
 * session re-reading SKILL.md files it can no longer see. Once per
 * compaction, zero per-prompt cost.
 *
 * WHY SELF-INSTALLING. The previous generation of prism hooks was provisioned
 * by a bootstrap script once, then hand-maintained per machine — which is why
 * this machine has them and the other team machines do not. This module is
 * called from three places so no machine can miss it:
 *   1. `prism connect`      — the explicit path,
 *   2. npm postinstall      — the upgrade path,
 *   3. MCP server startup   — the safety net for installs that skip scripts.
 * All three converge here and the operation is idempotent: same version →
 * no writes; registered → not re-registered; other people's hooks untouched.
 *
 * WHY THE HOOK SHELLS OUT TO `prism route-prompt` instead of matching in
 * Python: the trigger table, scoped-frontmatter triggers, entitlement and
 * caps live in the TypeScript matcher. A Python reimplementation would drift,
 * and a table that matches differently in the hook than in the server is
 * worse than no hook at all.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Bump to force the on-disk script to be rewritten on the next ensure. */
export const PROMPT_ROUTE_HOOK_VERSION = "5";
/** SessionStart matcher: only the post-compaction fire carries the digest.
 *  The script re-checks `source` itself, so a host that ignores matchers on
 *  this event still injects nothing at startup/resume. */
const SESSION_START_MATCHER = "compact";

const MARKER_FILE = ".prism-managed.json";
const SCRIPT_FILE = "on_prompt.py";
const HOOK_DIR = "prism-route";
/** Substring that identifies our entry inside a host hooks config. */
const COMMAND_SIGNATURE = `${HOOK_DIR}/${SCRIPT_FILE}`;
/**
 * The command registered in the host config carries the version as an
 * argument. The script reads stdin for the hook payload and rejects a stale
 * version argument before executing routing logic. This is a SECURITY
 * property, found by an external probe of Codex 0.146: Codex's hook-trust
 * hash covers the CONFIGURED DEFINITION, not the file the command points at.
 * With a stable command and a version-refreshed script, every prism upgrade
 * would silently swap the executable content behind an already-trusted hash —
 * exactly what the trust gate exists to prevent. Versioning the command
 * changes the definition on every script change, forcing Codex to re-prompt.
 * Cost: one approval per release, which is Codex's consent model working.
 */
function hookCommand(scriptPath: string): string {
  return `python3 ${scriptPath} --v${PROMPT_ROUTE_HOOK_VERSION}`;
}

/**
 * The hook script. Python because both hosts' existing hook fleets are
 * Python and the runtime is guaranteed present on macOS.
 *
 * Contract notes:
 *  - stdin carries the host's JSON payload; `prompt` is the Claude Code key
 *    and the fallbacks cover Codex's Claude-compatible hook payloads.
 *  - It must NEVER fail the turn: every path ends in continue:true, and an
 *    unexpected exception exits 0 with a pass-through.
 *  - Per-session dedupe lives HERE (state/<session>.json), because the hook
 *    is the only party that knows what it already injected. `loaded` is
 *    passed to the CLI so the matcher never returns the same skill twice.
 */
export const PROMPT_ROUTE_HOOK_SCRIPT = `#!/usr/bin/env python3
"""Prism-managed hook (prism-route v${PROMPT_ROUTE_HOOK_VERSION}).

Routes every user prompt through the on-device skill matcher via
'prism route-prompt'. Injects newly matched skill bodies as context.
On SessionStart with source "compact" (the host just discarded the
transcript, bootstrap included) it re-injects the protected-floor digest
via 'prism floor-digest' instead.
Managed by prism; edits are overwritten on version bumps.
"""
import json
import os
import re
import shutil
import subprocess
import sys

INLINE_CONTEXT_CAP = 9800
CLI_TIMEOUT_SECONDS = 6
MAX_STATE_SKILLS = 500
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
TASK_CONTEXT_ANCHOR = (
    "[Context attached to the user's request above. Do not acknowledge this context separately. "
    "Execute the user's request now, applying the following task rules.]"
)


def content_cap():
    return INLINE_CONTEXT_CAP - len(TASK_CONTEXT_ANCHOR) - 2


def emit(extra=None, event="UserPromptSubmit"):
    out = {"continue": True, "suppressOutput": True}
    if extra:
        anchored = TASK_CONTEXT_ANCHOR + "\\n\\n" + extra[:content_cap()]
        out["hookSpecificOutput"] = {
            "hookEventName": event,
            "additionalContext": anchored,
        }
    print(json.dumps(out))


def run_cli_json(cli, args, stdin_text=""):
    """Run a prism CLI subcommand; return its last JSON stdout line or None."""
    try:
        result = subprocess.run(
            [cli] + args,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SECONDS,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    # Parse the LAST line that is JSON: wrappers hooked into node via
    # NODE_OPTIONS (dotenv banners and the like) print to stdout BEFORE the
    # CLI's own output, and one polluted line must not kill routing.
    for line in reversed(result.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
            except Exception:
                continue
            return data if isinstance(data, dict) else None
    return None


def session_state_path(payload):
    session = str(
        payload.get("session_id")
        or payload.get("sessionId")
        or payload.get("conversation_id")
        or "default"
    )
    session = re.sub(r"[^A-Za-z0-9._-]", "_", session).lstrip(".")[:80] or "default"
    state_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
    return state_dir, os.path.join(state_dir, session + ".json")


def read_state(state_path):
    try:
        with open(state_path) as fh:
            value = json.load(fh)
    except Exception:
        return {"generation": "", "names": []}
    if isinstance(value, list):
        return {"generation": "", "names": clean_names(value)}
    if not isinstance(value, dict):
        return {"generation": "", "names": []}
    generation = value.get("generation") if isinstance(value.get("generation"), str) else ""
    names = value.get("names") if isinstance(value.get("names"), list) else []
    return {"generation": generation, "names": clean_names(names)}


def clean_names(values):
    kept = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not SKILL_NAME_RE.fullmatch(value) or value in seen:
            continue
        kept.append(value)
        seen.add(value)
    return kept[-MAX_STATE_SKILLS:]


def write_state(state_dir, state_path, generation, names):
    temp_path = state_path + ".tmp-" + str(os.getpid())
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(temp_path, "w") as fh:
            json.dump({"generation": generation, "names": names}, fh)
        os.replace(temp_path, state_path)
    except Exception:
        try:
            os.remove(temp_path)
        except Exception:
            pass


def current_generation():
    override = os.environ.get("PRISM_ROUTE_SKILLS_INDEX")
    index_path = override or os.path.expanduser("~/.agents/skills/.prism-managed-skills.json")
    try:
        with open(index_path) as fh:
            value = json.load(fh)
        generation = value.get("generation") if isinstance(value, dict) else ""
        return generation if isinstance(generation, str) else ""
    except Exception:
        return ""


def reinject(cli, names, budget):
    selected = names[-3:]
    if not selected or budget < 256:
        return {"ok": True, "names": [], "text": ""}
    data = run_cli_json(cli, [
        "reinject-skills", "--names", ",".join(selected), "--budget", str(budget)
    ])
    if not isinstance(data, dict) or data.get("ok") is not True:
        return {"ok": False, "names": [], "text": ""}
    return data


def payload_field(payload, *keys):
    """First non-empty string among alternative spellings of one field.

    Claude Code documents snake_case keys; Codex's payloads are described as
    Claude-compatible, not Claude-identical, which is why the prompt lookup
    below already hedges three ways. The SessionStart detection used to read
    exactly one spelling, so a Codex payload spelled hookEventName/trigger
    would fall to the prompt path and pass through with no digest and no
    signal (round-11 review).
    """
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def event_name(payload):
    name = payload_field(payload, "hook_event_name", "hookEventName", "event_name", "eventName", "event")
    return re.sub(r"[^a-z]", "", name.lower())


def on_session_start(payload):
    # Only the post-compaction fire: at startup/resume the bootstrap carries
    # the digest itself, and a second copy would be pure cost. "compact",
    # "compaction", "compacted" all mean the transcript was just discarded.
    source = payload_field(payload, "source", "trigger", "reason").lower()
    if not source.startswith("compact"):
        emit(event="SessionStart")
        return
    state_dir, state_path = session_state_path(payload)
    state = read_state(state_path)
    generation = current_generation()
    cli = find_cli()
    if not cli:
        emit(event="SessionStart")
        return
    data = run_cli_json(cli, ["floor-digest"])
    raw_floor_text = (data or {}).get("text") or ""
    floor_names = clean_names((data or {}).get("names") or [])
    floor_text = raw_floor_text if floor_names and isinstance(raw_floor_text, str) else ""
    remaining = content_cap() - len(floor_text) - (2 if floor_text else 0)
    restored = reinject(cli, state["names"], remaining)
    restored_names = clean_names(restored.get("names") or [])
    restored_text = restored.get("text") if isinstance(restored.get("text"), str) else ""
    # If the floor consumes the whole host budget or the CLI fails, keep the
    # names but leave the generation stale so the next prompt retries. A
    # successful empty result means the current entitlement revoked them.
    if remaining < 256 and state["names"]:
        write_state(state_dir, state_path, "", state["names"])
    elif restored.get("ok") is not True:
        write_state(state_dir, state_path, "", state["names"])
    else:
        write_state(state_dir, state_path, generation, restored_names)
    combined = "\\n\\n".join(part for part in (floor_text, restored_text if restored_names else "") if part)
    emit(combined[:content_cap()], event="SessionStart")


def find_cli():
    override = os.environ.get("PRISM_ROUTE_CLI")
    if override and os.path.exists(override):
        return override
    found = shutil.which("prism")
    if found:
        return found
    home = os.path.expanduser("~")
    for candidate in (
        os.path.join(home, ".npm-global", "bin", "prism"),
        "/opt/homebrew/bin/prism",
        "/usr/local/bin/prism",
        os.path.join(home, "bin", "prism"),
    ):
        if os.path.exists(candidate):
            return candidate
    return None


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    if event_name(payload) == "sessionstart":
        on_session_start(payload)
        return

    prompt = str(
        payload.get("prompt")
        or payload.get("message")
        or payload.get("user_prompt")
        or ""
    ).strip()
    state_dir, state_path = session_state_path(payload)
    state = read_state(state_path)
    loaded = state["names"]
    generation = current_generation()
    generation_changed = bool(loaded and generation and generation != state["generation"])

    cli = find_cli()
    if not cli:
        emit()
        return

    # Slash commands never route. A micro-prompt normally stays free, but a
    # just-materialized generation must replace any older task rules before
    # even "continue" reaches the model.
    if prompt.startswith("/"):
        emit()
        return
    if len(prompt) < 6:
        if generation_changed:
            restored = reinject(cli, loaded, content_cap())
            restored_names = clean_names(restored.get("names") or [])
            restored_text = restored.get("text") if isinstance(restored.get("text"), str) else ""
            if restored.get("ok") is True:
                write_state(state_dir, state_path, generation, restored_names)
            else:
                write_state(state_dir, state_path, "", loaded)
            if restored_names and restored_text:
                emit(restored_text)
                return
        emit()
        return
    # A pasted log can be megabytes; triggers live in the first human-sized
    # stretch, and the CLI caps identically on its side.
    prompt = prompt[:100_000]

    if generation_changed:
        # Ask the normal matcher what this prompt needs, then rebuild one
        # current-generation payload from the prior active set plus new hits.
        # Emitting the matcher text directly would lose the old active rules
        # whenever this prompt happened to match a different skill.
        data = run_cli_json(cli, ["route-prompt", "--loaded", ""], prompt)
        routed_names = clean_names((data or {}).get("names") or [])
        active = [n for n in state["names"] if n not in routed_names] + routed_names
        restored = reinject(cli, active, content_cap())
        restored_names = clean_names(restored.get("names") or [])
        restored_text = restored.get("text") if isinstance(restored.get("text"), str) else ""
        if restored.get("ok") is True:
            write_state(state_dir, state_path, generation, restored_names)
        else:
            write_state(state_dir, state_path, "", active)
        if restored_names and restored_text:
            emit(restored_text)
            return
        emit()
        return

    data = run_cli_json(cli, ["route-prompt", "--loaded", ",".join(loaded)], prompt)
    if data is None:
        emit()
        return
    names = clean_names(data.get("names") or [])
    text = data.get("text") or ""
    if not names or not text:
        touched = clean_names(data.get("alreadyLoaded") or [])
        if touched and not generation_changed:
            reordered = [n for n in loaded if n not in touched] + touched
            write_state(state_dir, state_path, generation, reordered)
        emit()
        return

    touched = clean_names(data.get("alreadyLoaded") or [])
    merged = [n for n in loaded if n not in touched and n not in names] + touched + names
    write_state(state_dir, state_path, generation, clean_names(merged))

    emit(text)


if __name__ == "__main__":
    if "--v${PROMPT_ROUTE_HOOK_VERSION}" not in sys.argv[1:]:
        print(json.dumps({"continue": True, "suppressOutput": True}))
        sys.exit(0)
    try:
        main()
    except Exception:
        print(json.dumps({"continue": True, "suppressOutput": True}))
        sys.exit(0)
`;

export interface EnsureHookHostResult {
  host: "claude" | "codex";
  script: "installed" | "refreshed" | "unchanged" | "disabled";
  /** "skipped-unparseable": the host config exists but is not valid JSON
   *  (or not an object). Nothing was written — replacing it would delete the
   *  operator's model/env/permissions along with the syntax error. The hook
   *  is NOT registered on that host until the file is fixed. */
  config: "registered" | "updated" | "unchanged" | "skipped-unparseable";
  /** Codex only: its trust gate silently skips unapproved hooks. We can
   *  DETECT approval only coarsely (a [hooks.state] section naming our exact
   *  versioned command, once per event); "pending-or-unknown" means the
   *  operator must run /hooks and trust it. */
  codexApproval?: "detected" | "pending-or-unknown" | "state-present-unverifiable";
  scriptPath: string;
  configPath: string;
}

export interface EnsureHookOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Restrict to specific hosts; default is both. */
  hosts?: Array<"claude" | "codex">;
  /** Only ensure for hosts whose root directory already exists (default true
   *  — a machine without ~/.codex should not grow one). */
  onlyExistingRoots?: boolean;
  /**
   * "explicit" — the user ran `prism connect`; that command IS the consent
   *   to manage host configuration, so install unconditionally.
   * "auto" (postinstall, server startup) — this package is PUBLIC npm, and
   *   silently rewriting a stranger's ~/.claude/settings.json because they
   *   installed an MCP server is consent they never gave. Auto paths
   *   therefore REFRESH ONLY: they act solely on hosts carrying our own
   *   managed marker, i.e. a hook a prior EXPLICIT `prism connect` put
   *   there. A prism MCP registration in host config is deliberately NOT
   *   accepted as evidence (it was, until the 2026-09 directory review):
   *   installing the Claude Code PLUGIN registers `prism-mcp` in host
   *   config, so registration-as-consent let a plugin install transitively
   *   "consent" to a global UserPromptSubmit hook the user never approved.
   *   First install of the hook happens on the explicit path or not at all.
   */
  mode?: "explicit" | "auto";
}

/** A prior EXPLICIT install left our managed marker; only that authorizes
 *  the auto paths to touch this host again (refresh/upgrade). */
function hostHasManagedHook(spec: HostSpec): boolean {
  return existsSync(join(spec.root, "hooks", HOOK_DIR, MARKER_FILE));
}

interface HostSpec {
  host: "claude" | "codex";
  root: string;
  configPath: string;
}

function hostSpecs(homeDir: string, env: NodeJS.ProcessEnv): HostSpec[] {
  const codexHome = env.CODEX_HOME?.trim() ? resolve(env.CODEX_HOME.trim()) : join(homeDir, ".codex");
  return [
    { host: "claude", root: join(homeDir, ".claude"), configPath: join(homeDir, ".claude", "settings.json") },
    // Codex keeps hooks in hooks.json, not settings.json — same schema.
    { host: "codex", root: codexHome, configPath: join(codexHome, "hooks.json") },
  ];
}

/**
 * Coarse Codex approval detection. Codex persists hook approvals as a
 * [hooks.state] table in config.toml keyed by definition hash; the hashing
 * algorithm is not public, so the only honest signal is the state section
 * naming the EXACT command we register — `… --v<version>` — once per event
 * (two hooks, two approvals). The version-agnostic path alone is not
 * evidence: a v3 approval names the same script, and Codex will skip the
 * v4 definition it never saw. Matching the bare path let a stale approval
 * read as "detected" from the second `prism connect` after every hook
 * bump (round-8 review). Never treat unknown as approved.
 */
function detectCodexApproval(codexRoot: string, wantedCommand: string): "detected" | "pending-or-unknown" | "state-present-unverifiable" {
  try {
    // A Windows path lands in a TOML basic string with its backslashes
    // ESCAPED (`C:\\Users\\…`); one-for-one replacement turned that into
    // `C://Users//…` and the approval never matched (round-10 review). A
    // run of backslashes is one separator.
    const toml = readFileSync(join(codexRoot, "config.toml"), "utf8").replace(/\\+/g, "/");
    if (!/\[hooks\.state/.test(toml)) return "pending-or-unknown";
    const wanted = wantedCommand.replace(/\\+/g, "/");
    const exact = toml.split(wanted).length - 1;
    if (exact >= 2) return "detected";
    // Our script is named, but not under the current definition: positive
    // evidence that the trust on file is for an OLDER hook version, which
    // Codex will not honour for this one.
    if (exact === 0 && toml.includes(COMMAND_SIGNATURE)) return "pending-or-unknown";
    // Trust state exists (one of our two entries, or hash-only entries that
    // never name a command) and we cannot distinguish ours from here.
    // Claiming AWAITING TRUST after the operator pressed t would be a false
    // alarm against their own action. Distinct state, distinct wording.
    return "state-present-unverifiable";
  } catch { /* unreadable = no evidence */ }
  return "pending-or-unknown";
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.prism-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function ensureScript(hookDir: string): "installed" | "refreshed" | "unchanged" | "disabled" {
  const markerPath = join(hookDir, MARKER_FILE);
  const scriptPath = join(hookDir, SCRIPT_FILE);
  let existingVersion: string | undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: string; disabled?: boolean };
    // The durable off switch. Without it, an operator who deletes the entry
    // or edits the script gets silently re-enabled by the next upgrade —
    // self-healing becomes self-reinfecting. {"disabled": true} in the
    // marker survives every ensure path, including version bumps.
    if (marker.disabled === true) return "disabled";
    existingVersion = marker.version;
  } catch {
    /* no marker — install */
  }
  const scriptExists = existsSync(scriptPath);
  if (scriptExists && existingVersion === PROMPT_ROUTE_HOOK_VERSION) return "unchanged";

  writeAtomically(scriptPath, PROMPT_ROUTE_HOOK_SCRIPT);
  chmodSync(scriptPath, 0o755);
  mkdirSync(join(hookDir, "state"), { recursive: true });
  writeAtomically(
    markerPath,
    `${JSON.stringify({ managedBy: "prism", feature: "prism-route", version: PROMPT_ROUTE_HOOK_VERSION }, null, 2)}\n`,
  );
  return scriptExists ? "refreshed" : "installed";
}

function ensureRegistered(configPath: string, scriptPath: string, host: "claude" | "codex"): EnsureHookHostResult["config"] {
  // Codex truncates hook additionalContext at ~2,500 tokens by default —
  // a head-and-tail preview of our payload, which defeats the injection.
  // additionalContextLimit: 0 passes the full context through — per the Codex
  // hooks reference (learn.chatgpt.com/docs/hooks, verified 2026-08-13):
  // "Setting to 0 passes full context directly to the model". NOT an in-repo
  // guarantee: if Codex ever re-reads 0 as a literal zero cap, injection dies
  // silently there — re-verify with a live codex probe after any Codex
  // upgrade. The payload is already bounded by HOOK_INLINE_SAFE_CHARS on the
  // emitting side, so the pass-through is not unbounded. Claude Code has no
  // such field (its 10k-char cap is not configurable) — never write unknown
  // keys into settings.json (a manually-added stray field there is left
  // alone, not stripped).
  const wantsLimit = host === "codex";
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    // An existing file we cannot parse is the operator's file with a syntax
    // slip in it (model, env, permissions…) — "replace with {hooks}" would
    // be a silent wipe. Register nothing; the caller reports it.
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped-unparseable";
      config = parsed as Record<string, unknown>;
    } catch {
      return "skipped-unparseable";
    }
  }

  const hooks = (config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
    ? config.hooks
    : {}) as Record<string, unknown>;

  const wanted = hookCommand(scriptPath);
  let updated = false;
  let registered = false;
  // One script, two events. Each event is converged independently so a
  // machine registered under an older release (UserPromptSubmit only) gains
  // the SessionStart entry on refresh, and a hand-removed entry is not
  // resurrected by the other event still being current — the disabled marker
  // is the opt-out for both.
  const converge = (event: "UserPromptSubmit" | "SessionStart", matcher: string) => {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    let found = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const inner = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (!h || typeof h !== "object") continue;
        // Normalize separators: on Windows join() registers a backslash path,
        // and a forward-slash signature would never match — so every ensure
        // would re-register a duplicate entry.
        const command = String((h as { command?: unknown }).command ?? "");
        if (!command.replace(/\\/g, "/").includes(COMMAND_SIGNATURE)) continue;
        found = true;
        const limitCurrent = !wantsLimit || (h as { additionalContextLimit?: unknown }).additionalContextLimit === 0;
        if (command === wanted && limitCurrent) continue;
        // Same hook, older definition: UPDATE it in place. This is what makes a
        // refresh visible to Codex's definition-hash — and on Claude it is a
        // harmless argv change.
        (h as { command: string }).command = wanted;
        if (wantsLimit) (h as { additionalContextLimit?: number }).additionalContextLimit = 0;
        updated = true;
      }
    }
    if (!found) {
      entries.push({
        matcher,
        hooks: [{ type: "command", command: wanted, timeout: 15, ...(wantsLimit ? { additionalContextLimit: 0 } : {}) }],
      });
      registered = true;
    }
    hooks[event] = entries;
  };
  converge("UserPromptSubmit", "*");
  converge("SessionStart", SESSION_START_MATCHER);
  if (!updated && !registered) return "unchanged";
  config.hooks = hooks;
  writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return registered ? "registered" : "updated";
}

/**
 * Idempotently install the prism-route hook for both hosts.
 * Never throws for a single host's failure — the other host still gets it.
 */
export function ensurePromptRouteHook(options: EnsureHookOptions = {}): EnsureHookHostResult[] {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const wanted = new Set(options.hosts ?? ["claude", "codex"]);
  const onlyExisting = options.onlyExistingRoots ?? true;

  const results: EnsureHookHostResult[] = [];
  for (const spec of hostSpecs(homeDir, env)) {
    if (!wanted.has(spec.host)) continue;
    if (onlyExisting && !existsSync(spec.root)) continue;
    if ((options.mode ?? "explicit") === "auto" && !hostHasManagedHook(spec)) continue;
    try {
      const hookDir = join(spec.root, "hooks", HOOK_DIR);
      const script = ensureScript(hookDir);
      if (script === "disabled") continue; // operator opt-out — do not re-register either
      const config = ensureRegistered(spec.configPath, join(hookDir, SCRIPT_FILE), spec.host);
      const result: EnsureHookHostResult = { host: spec.host, script, config, scriptPath: join(hookDir, SCRIPT_FILE), configPath: spec.configPath };
      if (spec.host === "codex") {
        // Never report a green "registered" as if it were active: Codex
        // SILENTLY SKIPS untrusted hooks, and "installed but inert" is the
        // exact failure class this feature exists to end.
        //
        // Approvals are keyed by definition hash, so a hooks.json we just
        // rewrote (new entry, changed command) carries definitions the
        // operator has never trusted — whatever config.toml says about the
        // OLD ones. Only an untouched config can inherit prior trust.
        result.codexApproval = config === "unchanged"
          ? detectCodexApproval(spec.root, hookCommand(result.scriptPath))
          : "pending-or-unknown";
      }
      results.push(result);
    } catch {
      // One host failing (permissions, odd config) must not block the other.
    }
  }
  return results;
}
