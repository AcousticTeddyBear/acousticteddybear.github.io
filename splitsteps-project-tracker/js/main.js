// Startup, the token screen, and routing from the URL hash.

import * as gh from "./github.js";
import { parseGoal, parseSource } from "./parse.js";
import {
  loadingNode,
  phasePlan,
  renderChecks,
  renderFeatures,
  renderIssues,
  renderOverview,
  renderPhases,
  resetFilters,
  specPath,
} from "./tabs.js";
import { rememberDoc, renderDocs, resetDocs } from "./docs.js";

const $ = (id) => document.getElementById(id);
const tokenScreen = $("tk-token-screen");
const tokenForm = $("tk-token-form");
const tokenInput = $("tk-token-input");
const tokenMessage = $("tk-token-message");
const app = $("tk-app");
const view = $("tk-view");
const banner = $("tk-banner");
const loadedLabel = $("tk-loaded");
const refreshButton = $("tk-refresh");
const forgetButton = $("tk-forget");

const TAB_RENDERERS = {
  overview: renderOverview,
  phases: renderPhases,
  issues: renderIssues,
  checks: renderChecks,
  features: renderFeatures,
};

let model = null; // parsed data, or null while loading
let loading = false;
let loadSeq = 0; // lets a late answer from an old load be ignored

// ---- Token screen ----------------------------------------------------------

function showTokenScreen(message) {
  gh.clearToken();
  loadSeq++; // drop anything still loading
  model = null;
  loading = false;
  refreshButton.disabled = false;
  resetDocs();
  resetFilters();
  clearBrand();
  view.replaceChildren();
  view.dataset.tab = "";
  app.hidden = true;
  tokenScreen.hidden = false;
  tokenInput.value = "";
  tokenMessage.textContent = message || "";
  tokenMessage.hidden = !message;
}

tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  gh.setToken(token);
  tokenInput.value = "";
  startApp();
});

forgetButton.addEventListener("click", () => showTokenScreen(""));
refreshButton.addEventListener("click", () => {
  resetDocs();
  resetFilters();
  loadAll();
});

function onUnauthorized() {
  showTokenScreen(gh.MESSAGES.unauthorized);
}

// ---- Logo and favicon ------------------------------------------------------

// These live in the private docs repo. Nothing from that repo may be copied
// into this public one, so they are fetched with the token, like a doc's images.
const brandSlot = $("tk-brand");
const LOGO = "brand/assets/svg/splitsteps-lockup-dark.svg"; // for deep purple backgrounds
const FAVICON = "brand/assets/favicon/favicon.svg";
let brandUrls = [];
let brandSeq = 0; // lets a late answer be ignored after the token is forgotten

async function svgUrl(path) {
  const bytes = await gh.fetchFileBytes(path);
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
  brandUrls.push(url);
  return url;
}

function clearBrand() {
  brandSeq++;
  for (const url of brandUrls) URL.revokeObjectURL(url);
  brandUrls = [];
  brandSlot.textContent = "SplitSteps";
  document.querySelector('link[rel="icon"]')?.remove();
}

// If either file fails, the page keeps the plain text name and the default icon.
async function loadBrand() {
  const seq = ++brandSeq;
  const [logo, favicon] = await Promise.allSettled([svgUrl(LOGO), svgUrl(FAVICON)]);
  if (seq !== brandSeq) return;
  if (logo.status === "fulfilled") {
    const img = new Image();
    img.src = logo.value;
    img.alt = "SplitSteps";
    img.className = "logo";
    brandSlot.replaceChildren(img);
  }
  if (favicon.status === "fulfilled") {
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = favicon.value;
    document.head.append(link);
  }
}

// ---- Loading ---------------------------------------------------------------

function showBanner(messages) {
  banner.textContent = messages.join(" ");
  banner.hidden = messages.length === 0;
}

const kindOf = (err) => (err instanceof gh.ApiError ? err.kind : "other");

// The specs of the phases Insights shows, for their goals. Never rejects:
// returns [path, { text } or { error }] pairs.
async function loadPhaseSpecs(readmeText) {
  const { rows } = parseSource("phases", { text: readmeText });
  if (!rows) return [];
  const { done, open, next } = phasePlan(rows);
  const paths = [...new Set([...done, ...open, ...next].map(specPath).filter(Boolean))];
  const settled = await Promise.allSettled(paths.map((p) => gh.fetchFile(p)));
  return paths.map((p, i) => [p, settled[i].status === "fulfilled" ? { text: settled[i].value } : { error: settled[i].reason }]);
}

function goalsFrom(specs) {
  const byPath = new Map();
  const warnings = [];
  for (const [path, spec] of specs) {
    if (spec.error) {
      warnings.push(`${path}: couldn't be loaded (${gh.reasonText(spec.error)}), so its goal isn't shown.`);
      continue;
    }
    rememberDoc(path, spec.text);
    const goal = parseGoal(spec.text);
    if (goal) byPath.set(path, goal);
    else warnings.push(`${path}: there is no "**Goal:**" line, so its goal isn't shown.`);
  }
  return { byPath, warnings };
}

async function loadAll() {
  const seq = ++loadSeq;
  loading = true;
  model = null;
  refreshButton.disabled = true;
  loadedLabel.textContent = "Loading…";
  showBanner([]);
  render();

  const readmeRequest = gh.fetchFile("README.md");
  const specsRequest = readmeRequest.then(loadPhaseSpecs, () => []);
  const results = await Promise.allSettled([
    readmeRequest,
    gh.fetchFile("specs/issues.md"),
    gh.fetchFile("specs/open-checks.md"),
    gh.fetchFile("product/feature-tracker.md"),
    gh.fetchDocList(),
    gh.fetchCommits(),
  ]);
  const specs = await specsRequest;
  if (seq !== loadSeq) return;

  loading = false;
  refreshButton.disabled = false;

  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  const specErrors = specs.filter(([, s]) => s.error).map(([, s]) => s.error);
  if ([...errors, ...specErrors].some((e) => kindOf(e) === "unauthorized")) return onUnauthorized();
  if (errors.length === results.length && errors.every((e) => kindOf(e) === "denied")) {
    return showTokenScreen(gh.MESSAGES.cantRead);
  }

  const notes = [];
  const rateLimited = errors.find((e) => kindOf(e) === "ratelimit");
  if (rateLimited) notes.push(gh.rateLimitMessage(rateLimited));
  if (errors.some((e) => kindOf(e) === "network")) notes.push(gh.MESSAGES.network);
  showBanner(notes);

  const outcome = (r) =>
    r.status === "fulfilled" ? { text: r.value } : { reason: gh.reasonText(r.reason) };
  const [readme, issues, checks, features, tree, commits] = results;
  model = {
    phases: parseSource("phases", outcome(readme)),
    issues: parseSource("issues", outcome(issues)),
    checks: parseSource("checks", outcome(checks)),
    features: parseSource("features", outcome(features)),
    goals: goalsFrom(specs),
    docs:
      tree.status === "fulfilled"
        ? { paths: tree.value, error: null }
        : { paths: null, error: gh.describeError(tree.reason, "The list of docs") },
    commits:
      commits.status === "fulfilled"
        ? { list: commits.value, error: null }
        : { list: null, error: gh.describeError(commits.reason, "Recent changes") },
  };
  loadedLabel.textContent = `Loaded ${new Date().toLocaleTimeString()}`;
  view.dataset.tab = ""; // new data, so rebuild the view
  render();
}

// ---- Routing ---------------------------------------------------------------

const TABS = ["overview", "phases", "issues", "checks", "features", "docs"];
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function parseRoute() {
  const hash = location.hash.replace(/^#/, "");
  const docs = hash.match(/^\/docs(?:\/([^?]*))?(?:\?(.*))?$/);
  if (docs) {
    return {
      tab: "docs",
      path: decode(docs[1] || "") || "README.md",
      h: new URLSearchParams(docs[2] || "").get("h") || "",
    };
  }
  const name = hash.replace(/^\//, "");
  return { tab: TABS.includes(name) && name !== "docs" ? name : "overview" };
}

function render() {
  if (!gh.getToken()) return;
  const route = parseRoute();
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === route.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (loading || !model) {
    view.replaceChildren(loadingNode());
    view.dataset.tab = "";
    return;
  }
  if (route.tab === "docs") {
    if (view.dataset.tab !== "docs") view.replaceChildren();
    view.dataset.tab = "docs";
    renderDocs(view, route, { model, onUnauthorized });
    return;
  }
  if (view.dataset.tab !== route.tab) window.scrollTo(0, 0);
  view.dataset.tab = route.tab;
  view.replaceChildren(TAB_RENDERERS[route.tab](model));
}

window.addEventListener("hashchange", render);

// ---- Startup ---------------------------------------------------------------

// The sticky header's height, so sticky table headings and doc headings sit below it.
const topBar = $("tk-top");
function measureTop() {
  document.documentElement.style.setProperty("--top-measured", `${topBar.offsetHeight}px`);
}
if ("ResizeObserver" in window) new ResizeObserver(measureTop).observe(topBar);

function startApp() {
  tokenScreen.hidden = true;
  app.hidden = false;
  measureTop();
  loadBrand();
  loadAll();
}

if (gh.getToken()) startApp();
else showTokenScreen("");

// The page works without this, so a failed registration is ignored.
navigator.serviceWorker?.register("sw.js").catch(() => {});
