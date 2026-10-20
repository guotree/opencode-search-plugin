/**
 * Cross-check both READMEs against what the code actually does.
 *
 * Verifies, per provider:
 *   - every env knob a plugin reads (`envInt` / `envStr`) appears in its
 *     config table, every variable in a table is one the plugin reads, and
 *     a numeric default in the table matches the plugin's `envInt` fallback
 *   - the provider table's ID, env key and anonymous columns agree with
 *     `test/cases.ts` and the KEYLESS set in `test/providers.test.ts`
 *   - the "Supported providers" link line lists every provider, same in
 *     both languages
 *   - EN and zh-CN config sections and variable names match row for row
 *
 * Run from anywhere: `node scripts/audit-readme.mjs`
 * Exits 1 when a README claim and the code disagree.
 *
 * Prose claims (pricing, API semantics) are not machine-checkable; those
 * were verified against each vendor's own documentation by hand.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const en = readFileSync(join(root, "README.md"), "utf8")
const zh = readFileSync(join(root, "README.zh-CN.md"), "utf8")
const cases = readFileSync(join(root, "test", "cases.ts"), "utf8")
const providersTest = readFileSync(join(root, "test", "providers.test.ts"), "utf8")

const problems = []
const note = (m) => problems.push(m)

// ---------- 1. config tables vs plugin knobs ----------
const pluginFiles = readdirSync(join(root, "plugins")).filter((f) => f.endsWith("-search.ts"))
const knobs = new Map() // file -> Set(env names)
const osKeys = new Map() // file -> OSP_* key read from process.env
const intDefaults = new Map() // env var -> numeric envInt fallback
for (const f of pluginFiles) {
  const src = readFileSync(join(root, "plugins", f), "utf8")
  const names = new Set()
  for (const m of src.matchAll(/\b(?:envInt|envStr)\("([A-Z0-9_]+)"/g)) names.add(m[1])
  knobs.set(f, names)
  const key = /process\.env\.(OSP_[A-Z0-9_]+)/.exec(src)?.[1]
  osKeys.set(f, key)
  // Only a literal fallback counts; a conditional default (jina's timeout)
  // is not comparable to a table cell, so it is left unchecked.
  for (const m of src.matchAll(/envInt\("([A-Z0-9_]+)",\s*(\d[\d_]*)\)/g))
    intDefaults.set(m[1], Number(m[2].replace(/_/g, "")))
}

// Section name -> file: strip non-alphanumerics and compare
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const fileFor = (section) => {
  const n = norm(section)
  // Section names may carry the product suffix ("Brave Search") or not ("Jina").
  return pluginFiles.find((f) => {
    const base = norm(f.replace(/\.ts$/, "").replace(/-search$/, ""))
    return base === n || base + "search" === n
  })
}

// Split EN readme into "### <provider>" sections under ## Configuration
const configStart = en.indexOf("## Configuration")
const configEnd = en.indexOf("## How a query flows")
const configBody = en.slice(configStart, configEnd)
const sections = [...configBody.matchAll(/^### (.+)$/gm)].map((m) => ({
  name: m[1].trim(),
  start: m.index,
}))
for (let i = 0; i < sections.length; i++) {
  const body = configBody.slice(sections[i].start, sections[i + 1]?.start ?? configBody.length)
  if (sections[i].name.startsWith("Shared")) continue
  const file = fileFor(sections[i].name)
  if (!file) {
    note(`EN config section "### ${sections[i].name}" maps to no plugin file`)
    continue
  }
  // First cell only, so combined rows like `JINA_GL` / `JINA_HL` count both.
  const firstCell = (line) => line.split("|")[1] ?? ""
  const tableVars = new Set(
    [...body.matchAll(/^\| `[A-Z0-9_]+`.*$/gm)].flatMap((m) =>
      [...firstCell(m[0]).matchAll(/`([A-Z0-9_]+)`/g)].map((x) => x[1]),
    ),
  )
  const pluginKnobs = knobs.get(file)
  for (const k of pluginKnobs) {
    // CACHE_TTL / TIMEOUT are documented once in the shared table unless the
    // provider overrides the default, in which case the knob is listed with
    // its literal default in its own section.
    const generic = /_(CACHE_TTL|TIMEOUT)$/.test(k)
    if (!tableVars.has(k) && !generic)
      note(`${file}: knob ${k} missing from EN config table "${sections[i].name}"`)
  }
  for (const v of tableVars) {
    if (v.startsWith("OSP_")) {
      if (osKeys.get(file) !== v)
        note(`EN table "${sections[i].name}" lists key ${v}, plugin reads ${osKeys.get(file)}`)
      continue
    }
    if (!pluginKnobs.has(v)) note(`EN table "${sections[i].name}" lists ${v}, not read by ${file}`)
  }
  // A table cell that states a bare numeric default must match the plugin's
  // own envInt fallback for that variable. Prose or code spans that are not
  // bare numbers (dash, enum values, a conditional default) are not checked.
  for (const [rowLine] of body.matchAll(/^\| `[A-Z0-9_]+`.*$/gm)) {
    const vars = [...(rowLine.split("|")[1] ?? "").matchAll(/`([A-Z0-9_]+)`/g)].map((x) => x[1])
    const stated = /`(\d[\d_]*)`/.exec(rowLine.split("|")[2] ?? "")?.[1]
    if (stated === undefined) continue
    const statedNum = Number(stated.replace(/_/g, ""))
    for (const v of vars) {
      const fallback = intDefaults.get(v)
      if (fallback === undefined) continue
      if (fallback !== statedNum)
        note(
          `EN table "${sections[i].name}": ${v} default cell says ${statedNum}, plugin falls back to ${fallback}`,
        )
    }
  }
}

// ---------- 2. provider table vs cases.ts ----------
const caseEntries = [
  ...cases.matchAll(
    /file: "([^"]+)",\s*\n\s*pluginID: "([^"]+)",\s*\n\s*providerID: "([^"]+)",\s*\n\s*displayName: "([^"]+)",\s*\n\s*envKey: "([^"]+)"/g,
  ),
].map((m) => ({ file: m[1], pluginID: m[2], providerID: m[3], displayName: m[4], envKey: m[5] }))

const keyless = new Set(
  [
    .../const KEYLESS = new Set\(\[([^\]]+)\]\)/.exec(providersTest)[1].matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]),
)

// EN provider table rows
const provStart = en.indexOf("| Provider | ID |")
const provBody = en.slice(provStart, en.indexOf("\n\n", provStart))
const rows = [
  ...provBody.matchAll(/^\| (.+?) \| `(osp-[^`]+)` \| `(OSP_[^`]+)` \| (yes|no) \|/gm),
].map((m) => ({ name: m[1], id: m[2], env: m[3], anon: m[4] }))
if (rows.length !== caseEntries.length)
  note(`EN provider table has ${rows.length} rows, cases.ts has ${caseEntries.length} providers`)
for (const c of caseEntries) {
  const row = rows.find((r) => r.id === c.providerID)
  if (!row) {
    note(`provider ${c.providerID} missing from EN table`)
    continue
  }
  if (row.env !== c.envKey) note(`${c.providerID}: EN table key ${row.env} != cases.ts ${c.envKey}`)
  const wantAnon = keyless.has(c.providerID) ? "yes" : "no"
  if (row.anon !== wantAnon)
    note(`${c.providerID}: EN table anonymous=${row.anon}, tests say ${wantAnon}`)
}

// zh provider table parity (IDs + env keys + anon)
const zhStart = zh.indexOf("| Provider | ID |")
const zhBody = zh.slice(zhStart, zh.indexOf("\n\n", zhStart))
const zhRows = [
  ...zhBody.matchAll(/^\| (.+?) \| `(osp-[^`]+)` \| `(OSP_[^`]+)` \| (是|否) \|/gm),
].map((m) => ({ name: m[1], id: m[2], env: m[3], anon: m[4] }))
if (zhRows.length !== rows.length)
  note(`zh provider table has ${zhRows.length} rows, EN has ${rows.length}`)
rows.forEach((r, i) => {
  const z = zhRows[i]
  if (!z) return
  if (z.id !== r.id || z.env !== r.env || (z.anon === "是") !== (r.anon === "yes"))
    note(`row ${i + 1} mismatch EN(${r.id},${r.env},${r.anon}) vs zh(${z.id},${z.env},${z.anon})`)
})

// ---------- 3. supported-providers link line ----------
const links = (text) => {
  const line = /^\[AnySearch\].*$/m.exec(text)[0]
  return [...line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({ name: m[1], url: m[2] }))
}
const enLinks = links(en)
const zhLinks = links(zh)
if (enLinks.length !== caseEntries.length)
  note(`EN link line lists ${enLinks.length} providers, cases.ts has ${caseEntries.length}`)
if (JSON.stringify(enLinks) !== JSON.stringify(zhLinks)) note("EN and zh link lines differ")

// ---------- 4. zh config section parity (section names + var names) ----------
const zhConfig = zh.slice(zh.indexOf("## 配置"), zh.indexOf("## 查询流程"))
const zhSections = [...zhConfig.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim())
const enSections = sections.map((s) => s.name)
// First section is the shared table, whose header is translated by design.
const zhProviderSections = zhSections.slice(1)
const enProviderSections = enSections.slice(1)
if (JSON.stringify(zhProviderSections) !== JSON.stringify(enProviderSections))
  note(
    `config sections differ:\n  EN: ${enProviderSections.join(" | ")}\n  ZH: ${zhProviderSections.join(" | ")}`,
  )

// Default cells are compared by their meaningful tokens, not verbatim: the
// English `off` / Chinese 关 (and `on` / 开) are the same default in two
// languages, and parenthetical prose ("with X" / "开启 X 时为") is
// translation rather than data. Backticked values and bare boolean cells
// are what must agree.
const defaultTokens = (cell) => {
  const bare = cell.trim().replace(/`/g, "")
  if (bare === "off" || bare === "关") return ["BOOL_OFF"]
  if (bare === "on" || bare === "开") return ["BOOL_ON"]
  // Sorted: translations reorder the parenthetical ("60000 with X" vs
  // "X 时为 60000"), so agreement is about which values are stated.
  return [...cell.trim().matchAll(/`([^`]+)`/g)]
    .map((m) => (m[1] === "off" ? "BOOL_OFF" : m[1] === "on" ? "BOOL_ON" : m[1]))
    .sort()
}
const rowsOf = (body) =>
  [...body.matchAll(/^\| `[A-Z0-9_]+`.*$/gm)].map((line) => ({
    vars: [...(line[0].split("|")[1] ?? "").matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]),
    def: defaultTokens(line[0].split("|")[2] ?? ""),
  }))
for (let i = 0; i < Math.min(enSections.length, zhSections.length); i++) {
  const slice = (text, secs, idx) => {
    const start = text.indexOf(`### ${secs[idx]}`)
    const next = text.indexOf("\n### ", start + 1)
    return text.slice(start, next === -1 ? text.length : next)
  }
  const a = rowsOf(slice(en, enSections, i))
  const b = rowsOf(slice(zh, zhSections, i))
  if (JSON.stringify(a) !== JSON.stringify(b))
    note(
      `rows differ in section "${enSections[i]}":\n  EN: ${JSON.stringify(a)}\n  ZH: ${JSON.stringify(b)}`,
    )
}

// ---------- report ----------
console.log(
  `providers: ${caseEntries.length}, plugins: ${pluginFiles.length}, EN sections: ${enSections.length}`,
)
if (problems.length === 0) {
  console.log("README and code are consistent.")
} else {
  console.log(`${problems.length} problem(s):`)
  problems.forEach((p) => console.log(" - " + p))
  process.exitCode = 1
}
