// Overview, Phases, Issues, Checks and Features.
// All text goes in with textContent (via el), never innerHTML, so nothing in
// the docs can run as code on a page that holds a token.

import { ALLOWED, linkTarget } from "./parse.js";
import { docHash } from "./docs.js";

// ---- Small DOM helpers -----------------------------------------------------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false && kid !== "") node.append(kid);
  }
  return node;
}

export const loadingNode = () => el("p", { class: "loading" }, "Loading…");

function warningList(list) {
  if (!list || list.length === 0) return null;
  return el(
    "div",
    { class: "warnings" },
    list.map((w) => el("p", { class: "warning", role: "status" }, el("strong", {}, "Warning: "), w)),
  );
}

// ---- Status badges ---------------------------------------------------------

const BADGE_COLOUR = {
  Done: "green",
  Resolved: "green",
  "In progress": "blue",
  "Done (docs)": "blue",
  "Awaiting sign-off": "amber",
  "Partly done": "amber",
  Issue: "red",
};

// A value outside the allowed list is red. "Open" is red for an issue and grey for a check.
function badge(value, allowed, { issue = false } = {}) {
  if (!value) return null;
  let colour = "grey";
  if (!allowed.includes(value)) colour = "red";
  else if (value === "Open" && issue) colour = "red";
  else if (BADGE_COLOUR[value]) colour = BADGE_COLOUR[value];
  return el("span", { class: `badge badge-${colour}` }, value);
}

// ---- Filtered table --------------------------------------------------------

const ALL = "\u0000all";
const filterState = {}; // table key -> { filter id -> chosen value }

export function resetFilters() {
  for (const key of Object.keys(filterState)) delete filterState[key];
}

// columns: [{ label, cell(row) }]. filters: [{ id, label, get(row), order }].
// detail(row) returns a node shown under the row when its Details control is opened.
function tableView({ key, columns, rows, filters = [], detail }) {
  const state = (filterState[key] ||= {});
  const tbody = el("tbody");
  const count = el("span", { class: "filter-count", "aria-live": "polite" });

  function draw() {
    tbody.replaceChildren();
    let shown = 0;
    for (const row of rows) {
      if (!filters.every((f) => !state[f.id] || state[f.id] === ALL || state[f.id] === f.get(row))) continue;
      shown++;
      const tr = el("tr");
      for (const col of columns) {
        tr.append(el("td", { dataset: { label: col.label } }, col.cell(row)));
      }
      tbody.append(tr);
      if (detail) {
        const panel = el("tr", { class: "detail", hidden: true }, el("td", { colspan: columns.length + 1 }, detail(row)));
        const button = el(
          "button",
          { type: "button", "aria-expanded": "false", class: "details-button" },
          "Details",
        );
        button.addEventListener("click", () => {
          const open = panel.hidden;
          panel.hidden = !open;
          button.setAttribute("aria-expanded", String(open));
          button.textContent = open ? "Hide details" : "Details";
        });
        tr.append(el("td", {}, button));
        tbody.append(panel);
      }
    }
    count.textContent = `${shown} of ${rows.length}`;
  }

  const bar = filters.length
    ? el(
        "div",
        { class: "filters" },
        filters.map((f) => {
          const id = `tk-filter-${key}-${f.id}`;
          const values = [...new Set(rows.map(f.get))];
          const ordered = [
            ...(f.order || []).filter((v) => values.includes(v)),
            ...values.filter((v) => !(f.order || []).includes(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
          ];
          const select = el(
            "select",
            { id },
            el("option", { value: ALL }, "All"),
            ordered.map((v) => el("option", { value: v }, v === "" ? "(blank)" : v)),
          );
          if (ordered.includes(state[f.id])) select.value = state[f.id];
          else delete state[f.id];
          select.addEventListener("change", () => {
            state[f.id] = select.value;
            draw();
          });
          return el("div", { class: "filter" }, el("label", { for: id }, f.label), select);
        }),
        count,
      )
    : null;

  const head = el(
    "tr",
    {},
    columns.map((c) => el("th", { scope: "col" }, c.label)),
    detail ? el("th", { scope: "col" }, "Details") : null,
  );
  draw();
  return el(
    "div",
    { class: "table-view" },
    bar,
    el("table", { class: "data-table" }, el("thead", {}, head), tbody),
  );
}

const plain = (name) => (row) => row.cells[name];
const col = (label, cell) => ({ label, cell: cell || plain(label) });

function section(title, data, body) {
  return el("section", {}, el("h2", {}, title), warningList(data.warnings), data.rows ? body : null);
}

// ---- Overview --------------------------------------------------------------

function countGroup(title, rows, field, allowed) {
  if (!rows) return el("section", { class: "count-group" }, el("h3", {}, title), el("p", { class: "muted" }, "Not loaded."));
  const counts = new Map(allowed.map((v) => [v, 0]));
  let unknown = 0;
  for (const r of rows) {
    const v = r.cells[field];
    if (counts.has(v)) counts.set(v, counts.get(v) + 1);
    else unknown++;
  }
  const entries = [...counts.entries(), ["Total", rows.length]];
  if (unknown > 0) entries.push(["Unknown", unknown]);
  return el(
    "section",
    { class: "count-group" },
    el("h3", {}, title),
    el(
      "ul",
      { class: "counts" },
      entries.map(([label, n]) => el("li", {}, el("span", {}, label), el("strong", {}, String(n)))),
    ),
  );
}

function currentPhase(phases) {
  if (!phases.rows) return "Not available";
  const open = phases.rows.find((r) => r.cells.Status !== "Done" && r.cells.Status !== "Dropped");
  return open ? `${open.cells.Phase} ${open.cells.Name}` : "All phases finished";
}

export function renderOverview(model) {
  const all = [model.phases, model.issues, model.checks, model.features].flatMap((d) => d.warnings);
  const changes = model.commits.list
    ? model.commits.list.length
      ? el(
          "ul",
          { class: "commits" },
          model.commits.list.map((c) => el("li", {}, el("span", { class: "commit-date" }, c.date), " ", c.message)),
        )
      : el("p", { class: "muted" }, "No commits found.")
    : el("p", { class: "warning", role: "status" }, el("strong", {}, "Warning: "), model.commits.error);
  return el(
    "div",
    {},
    el("h2", {}, "Overview"),
    warningList(all),
    el("section", { class: "current-phase" }, el("h3", {}, "Current phase"), el("p", { class: "big" }, currentPhase(model.phases))),
    el(
      "div",
      { class: "count-grid" },
      countGroup("Phases by status", model.phases.rows, "Status", ALLOWED.phaseStatus),
      countGroup("Issues by status", model.issues.rows, "Status", ALLOWED.issueStatus),
      countGroup("Open checks by status", model.checks.rows, "Status", ALLOWED.checkStatus),
      countGroup("Features by tier", model.features.rows, "Tier", ALLOWED.tier),
      countGroup("Features by build status", model.features.rows, "Build status", ALLOWED.buildStatus),
    ),
    el("section", {}, el("h3", {}, "Recent changes"), changes),
  );
}

// ---- Phases ----------------------------------------------------------------

function phaseLink(row) {
  const title = `${row.cells.Phase} ${row.cells.Name}`.trim();
  const target = linkTarget(row.raw.Name);
  if (!target) return title;
  const [path, heading] = target.split("#");
  return el("a", { href: docHash(path, heading) }, title);
}

export function renderPhases(model) {
  const d = model.phases;
  return section(
    "Phases",
    d,
    tableView({
      key: "phases",
      rows: d.rows || [],
      columns: [
        col("Phase", phaseLink),
        col("Status", (r) => badge(r.cells.Status, ALLOWED.phaseStatus)),
        col("Updated"),
        col("Notes"),
      ],
    }),
  );
}

// ---- Issues ----------------------------------------------------------------

export function renderIssues(model) {
  const d = model.issues;
  let body = null;
  if (d.rows) {
    const rows = [...d.rows.filter((r) => r.cells.Status === "Open"), ...d.rows.filter((r) => r.cells.Status !== "Open")];
    body = rows.length
      ? tableView({
          key: "issues",
          rows,
          columns: [
            col("#"),
            col("Issue"),
            col("Where"),
            col("Status", (r) => badge(r.cells.Status, ALLOWED.issueStatus, { issue: true })),
            col("Notes"),
          ],
        })
      : el("p", {}, "No issues recorded.");
  }
  return section("Issues", d, body);
}

// ---- Checks ----------------------------------------------------------------

function checkDetail(row) {
  const block = (label, text) =>
    el("div", { class: "detail-block" }, el("h4", {}, label), el("p", {}, text || "—"));
  return el(
    "div",
    { class: "detail-body" },
    block("Why it matters", row.cells["Why it matters"]),
    block("How to check", row.cells["How to check"]),
    block("Result", row.cells.Result),
  );
}

export function renderChecks(model) {
  const d = model.checks;
  const rows = d.rows || [];
  return section(
    "Checks",
    d,
    rows.length
      ? tableView({
          key: "checks",
          rows,
          columns: [
            col("#"),
            col("Type", (r) => r.type),
            col("Check"),
            col("Phase"),
            col("Status", (r) => badge(r.cells.Status, ALLOWED.checkStatus)),
          ],
          filters: [{ id: "status", label: "Status", get: (r) => r.cells.Status, order: ALLOWED.checkStatus }],
          detail: checkDetail,
        })
      : null,
  );
}

// ---- Features --------------------------------------------------------------

export function renderFeatures(model) {
  const d = model.features;
  const rows = d.rows || [];
  return section(
    "Features",
    d,
    rows.length
      ? tableView({
          key: "features",
          rows,
          columns: [
            col("Feature"),
            col("What it adds"),
            col("Group"),
            col("Commitment"),
            col("Build it when"),
            col("Tier"),
            col("Build status", (r) => badge(r.cells["Build status"], ALLOWED.buildStatus)),
          ],
          filters: [
            { id: "tier", label: "Tier", get: (r) => r.cells.Tier, order: ALLOWED.tier },
            { id: "group", label: "Group", get: (r) => r.cells.Group },
            { id: "build", label: "Build status", get: (r) => r.cells["Build status"], order: ALLOWED.buildStatus },
          ],
        })
      : null,
  );
}
