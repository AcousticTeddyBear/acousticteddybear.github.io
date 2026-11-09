// Markdown tables to rows, with the warnings.

export const ALLOWED = {
  phaseStatus: ["Not started", "In progress", "Issue", "Awaiting sign-off", "Done", "Dropped"],
  issueStatus: ["Open", "Resolved"],
  checkStatus: ["Open", "Partly done", "Done (docs)", "Done", "Dropped"],
  buildStatus: ["Not started", "In progress", "Done"],
  tier: ["Free", "Host Pro", "Club", "Paid separately", "Internal", "Not decided"],
};

// Which file, heading and columns feed each tracker tab.
export const SOURCES = {
  phases: {
    file: "README.md",
    tables: [{ heading: "## Phase status", columns: ["Phase", "Name", "Status", "Updated", "Notes"] }],
    values: [{ field: "Status", allowed: ALLOWED.phaseStatus, label: "status" }],
  },
  issues: {
    file: "specs/issues.md",
    tables: [{ heading: "## Issues", columns: ["#", "Issue", "Where", "Status", "Notes"], allowEmpty: true }],
    values: [{ field: "Status", allowed: ALLOWED.issueStatus, label: "status" }],
  },
  checks: {
    file: "specs/open-checks.md",
    tables: [
      { heading: "## Technical checks", type: "Technical" },
      { heading: "## Product assumptions", type: "Product" },
    ].map((t) => ({
      ...t,
      columns: ["#", "Check", "Why it matters", "Phase", "How to check", "Status", "Result"],
    })),
    values: [{ field: "Status", allowed: ALLOWED.checkStatus, label: "status" }],
  },
  features: {
    file: "product/feature-tracker.md",
    tables: [
      {
        heading: "## Features",
        columns: ["Feature", "What it adds", "Group", "Commitment", "Build it when", "Tier", "Build status"],
      },
    ],
    values: [
      { field: "Tier", allowed: ALLOWED.tier, label: "tier" },
      { field: "Build status", allowed: ALLOWED.buildStatus, label: "build status" },
    ],
  },
};

export const splitLines = (text) => text.split(/\r?\n/);

// Split a table line on "|" unless it is escaped as "\|". Ignores the leading
// and trailing "|", and trims each cell.
export function splitCells(line) {
  const s = line.trim();
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  if (s.startsWith("|")) cells.shift();
  if (s.endsWith("|") && !s.endsWith("\\|")) cells.pop();
  return cells.map((c) => c.trim());
}

const LINK = /!?\[([^\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g;

// For display: [text](url) becomes text, and ** and backticks are removed.
export function clean(cell) {
  return cell.replace(LINK, "$1").replace(/\*\*/g, "").replace(/`/g, "").trim();
}

// The target of the first Markdown link in a cell (a path in the repo), or null.
export function linkTarget(cell) {
  const m = cell.match(/\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)/);
  if (!m || !m[1] || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1])) return null;
  return m[1];
}

const quote = (s) => `"${s}"`;

// Reads one table. Returns { rows, warnings }. rows is null when the table
// can't be shown at all.
export function parseTable(text, { heading, columns, allowEmpty = false }, file) {
  const fail = (msg) => ({ rows: null, warnings: [`${file}: ${msg}`] });
  const lines = splitLines(text);
  const at = lines.findIndex((l) => l.trimEnd() === heading);
  if (at < 0) return fail(`the heading ${quote(heading)} is missing.`);

  let start = -1;
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i].startsWith("|")) {
      start = i;
      break;
    }
  }
  if (start < 0) return fail(`there is no table under ${quote(heading)}.`);

  let end = start;
  while (end < lines.length && lines[end].startsWith("|")) end++;
  const block = lines.slice(start, end);

  const header = splitCells(block[0]).map(clean);
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length) {
    return fail(
      `the table under ${quote(heading)} is missing the column${missing.length > 1 ? "s" : ""} ${missing
        .map(quote)
        .join(", ")}.`,
    );
  }

  const warnings = [];
  const rows = [];
  for (const line of block.slice(2)) {
    const cells = splitCells(line);
    const cleaned = {};
    const raw = {};
    header.forEach((name, i) => {
      raw[name] = cells[i] ?? "";
      cleaned[name] = clean(raw[name]);
    });
    const first = clean(cells[0] ?? "") || "(empty)";
    if (cells.length !== header.length) {
      warnings.push(
        `${file}: row ${quote(first)} has ${cells.length} cells, but the table has ${header.length} columns.`,
      );
    }
    rows.push({ cells: cleaned, raw, first });
  }
  if (rows.length === 0 && !allowEmpty) {
    warnings.push(`${file}: the table under ${quote(heading)} has no rows.`);
  }
  return { rows, warnings };
}

// Warnings for values outside the allowed list. The rows still show.
export function checkValues(rows, { field, allowed, label }, file) {
  const out = [];
  for (const r of rows) {
    const v = r.cells[field];
    if (!allowed.includes(v)) {
      out.push(`${file}: row ${quote(r.first)} has the ${label} ${quote(v)}, which isn't an allowed value.`);
    }
  }
  return out;
}

// outcome is { text } for a file that loaded, or { reason } for one that didn't.
// Returns { rows, warnings }. rows is null when nothing can be shown.
export function parseSource(key, outcome) {
  const src = SOURCES[key];
  if (outcome.text === undefined) {
    return { rows: null, warnings: [`${src.file}: couldn't be loaded (${outcome.reason}).`] };
  }
  let rows = [];
  let shown = 0;
  const warnings = [];
  for (const table of src.tables) {
    const result = parseTable(outcome.text, table, src.file);
    warnings.push(...result.warnings);
    if (result.rows) {
      shown++;
      for (const r of result.rows) {
        if (table.type) r.type = table.type;
        rows.push(r);
      }
    }
  }
  if (shown === 0) return { rows: null, warnings };
  for (const rule of src.values) warnings.push(...checkValues(rows, rule, src.file));
  return { rows, warnings };
}
