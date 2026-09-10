import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the dead-end plugin install path.
 *
 * The README used to tell Claude Code users to run
 *   /plugin install prism-coder@claude-community
 * against `anthropics/claude-plugins-community`. That marketplace is a
 * read-only mirror of Anthropic's review pipeline and did not (and does not)
 * carry this plugin, so the documented command failed with
 *   Plugin "prism-coder" not found in marketplace "claude-community".
 *
 * Every documented `plugin install <name>@<marketplace>` must resolve against
 * a marketplace this repository actually publishes.
 */

const ROOT = resolve(__dirname, "..");

const marketplace = JSON.parse(
  readFileSync(resolve(ROOT, ".claude-plugin/marketplace.json"), "utf8"),
) as { name: string; plugins: Array<{ name: string }> };

const pluginManifest = JSON.parse(
  readFileSync(
    resolve(ROOT, "plugins/prism/.claude-plugin/plugin.json"),
    "utf8",
  ),
) as { repository: string };

const OWN_MARKETPLACE = marketplace.name;
const OWN_PLUGINS = new Set(marketplace.plugins.map((p) => p.name));
const OWN_SLUG = pluginManifest.repository.replace(
  /^https?:\/\/github\.com\//,
  "",
);

const INSTALL_RE = /plugin\s+(?:install|add)\s+([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/g;
const MARKETPLACE_RE = /plugin\s+marketplace\s+add\s+(\S+)/g;

function docs(): Array<{ label: string; body: string }> {
  const out = [{ label: "README.md", body: readFileSync(resolve(ROOT, "README.md"), "utf8") }];
  const i18nDir = resolve(ROOT, "docs/i18n");
  for (const f of readdirSync(i18nDir).filter((f) => f.endsWith(".md"))) {
    out.push({ label: `docs/i18n/${f}`, body: readFileSync(resolve(i18nDir, f), "utf8") });
  }
  return out;
}

describe("documented plugin install commands", () => {
  it("has at least one install command in the README", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    expect([...readme.matchAll(INSTALL_RE)].length).toBeGreaterThan(0);
  });

  for (const { label, body } of docs()) {
    it(`${label} only installs from a marketplace this repo publishes`, () => {
      for (const [cmd, plugin, market] of body.matchAll(INSTALL_RE)) {
        expect(
          market,
          `${label}: "${cmd}" targets marketplace "${market}", which this repo does not publish`,
        ).toBe(OWN_MARKETPLACE);
        expect(
          OWN_PLUGINS.has(plugin),
          `${label}: "${cmd}" installs "${plugin}", absent from .claude-plugin/marketplace.json`,
        ).toBe(true);
      }
    });

    it(`${label} only adds this repository as a marketplace`, () => {
      for (const [cmd, target] of body.matchAll(MARKETPLACE_RE)) {
        expect(
          target,
          `${label}: "${cmd}" adds a foreign marketplace`,
        ).toBe(OWN_SLUG);
      }
    });
  }
});
