// The Docs tab: a list of every .md file, the open doc rendered as HTML, a
// list of its headings, and links to the previous and next doc.

import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";
import { OWNER, REPO, BRANCH, fetchFile, fetchFileBytes, describeError } from "./github.js";

// The docs use placeholders like <date> and <N> in ordinary text. Escape any
// raw HTML tag that isn't on this list, so DOMPurify doesn't delete it.
const allowed = new Set(["p", "img", "a", "br"]);
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
marked.use({
  renderer: {
    html({ text }) {
      return text.replace(/<\/?([a-zA-Z][\w-]*)[^>]*>/g, (tag, name) =>
        allowed.has(name.toLowerCase()) ? tag : escape(tag));
    },
  },
});

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// The URL hash that opens a doc, optionally at a heading.
export function docHash(path, heading) {
  const p = path.split("/").map(encodeURIComponent).join("/");
  return `#/docs/${p}${heading ? `?h=${encodeURIComponent(decode(heading))}` : ""}`;
}

// ---- State -----------------------------------------------------------------

const textCache = new Map(); // doc path -> Markdown text
let imageUrls = new Map(); // image path -> object URL, for the open doc only
let currentPath = null; // the doc whose images are in imageUrls
let renderId = 0; // lets a late answer for an old doc be ignored
let layout = null; // the page's parts, from buildLayout
let scrollWatch = { until: 0, h: "", moved: false };

export function resetDocs() {
  textCache.clear();
  revokeImages();
  currentPath = null;
  layout = null;
  renderId++;
}

function revokeImages() {
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls = new Map();
}

for (const type of ["wheel", "touchmove", "keydown", "mousedown"]) {
  window.addEventListener(type, () => (scrollWatch.moved = true), { passive: true });
}

// ---- DOM helpers -----------------------------------------------------------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== "") node.append(kid);
  return node;
}

// ---- The list --------------------------------------------------------------

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const fileOf = (p) => p.slice(p.lastIndexOf("/") + 1);

// Folders in the order they're listed. Any other folder follows, alphabetically.
const SECTIONS = new Map([
  ["", "Project"],
  ["product", "Product"],
  ["specs", "Specs"],
  ["specs/phases", "Phases"],
  ["brand", "Brand"],
  ["templates", "Templates"],
]);
const SECTION_ORDER = [...SECTIONS.keys()];

function sectionRank(folder) {
  const i = SECTION_ORDER.indexOf(folder);
  return i < 0 ? SECTION_ORDER.length : i;
}

// A readable name from the filename, so listing the docs needs no extra requests.
function docTitle(path) {
  const name = fileOf(path).replace(/\.md$/i, "");
  if (name === "README") return "README";
  const words = (s) => {
    const text = s.replace(/-/g, " ");
    if (text === "api") return "API";
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const phase = name.match(/^phase-(\d+[a-z]?)-(.+)$/);
  return phase ? `Phase ${phase[1]}: ${words(phase[2])}` : words(name);
}

function groupDocs(paths) {
  const groups = new Map();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const folder = i < 0 ? "" : p.slice(0, i);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(p);
  }
  const folders = [...groups.keys()].sort((a, b) => sectionRank(a) - sectionRank(b) || byName(a, b));
  return folders.map((folder) => ({
    title: SECTIONS.get(folder) || folder,
    paths: groups.get(folder).sort((a, b) => byName(fileOf(a), fileOf(b))),
  }));
}

function buildLayout(paths) {
  const groups = groupDocs(paths);
  const sections = groups.map((g) => ({
    paths: g.paths,
    node: el(
      "details",
      { class: "doc-group" },
      el("summary", {}, g.title),
      el(
        "ul",
        {},
        g.paths.map((p) => el("li", {}, el("a", { href: docHash(p), "data-path": p }, docTitle(p)))),
      ),
    ),
  }));
  const sidebar = el("nav", { class: "doc-sidebar", "aria-label": "Docs" }, sections.map((s) => s.node));
  const select = el(
    "select",
    { class: "doc-select", "aria-label": "Choose a doc" },
    groups.map((g) =>
      el(
        "optgroup",
        { label: g.title },
        g.paths.map((p) => el("option", { value: p }, docTitle(p))),
      ),
    ),
  );
  select.addEventListener("change", () => {
    location.hash = docHash(select.value);
  });

  const tocList = el("ul", {});
  const toc = el("nav", { class: "doc-toc", "aria-label": "On this page", hidden: true }, el("h3", {}, "On this page"), tocList);
  const tocInlineList = el("ul", {});
  const tocInline = el(
    "details",
    { class: "doc-toc-inline", hidden: true },
    el("summary", {}, "On this page"),
    tocInlineList,
  );

  const article = el("article", { class: "doc" });
  const pager = el("nav", { class: "doc-pager", "aria-label": "Previous and next doc" });
  const main = el("div", { class: "doc-main" }, select, tocInline, article, pager);
  const root = el("div", { class: "docs" }, sidebar, main, toc);
  return {
    root,
    sidebar,
    sections,
    select,
    article,
    pager,
    toc,
    tocList,
    tocInline,
    tocInlineList,
    order: groups.flatMap((g) => g.paths),
    markedPath: null, // the doc the list last showed as open
    renderedPath: null, // the doc in the article, once it's fully there
  };
}

// Mark the open doc, and when it changes, open only its section of the list.
function markOpen(path) {
  layout.select.value = path;
  if (layout.markedPath === path) return;
  layout.markedPath = path;
  for (const a of layout.sidebar.querySelectorAll("a")) {
    if (a.dataset.path === path) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (!path) return;
  for (const section of layout.sections) section.node.open = section.paths.includes(path);
  const current = layout.sidebar.querySelector('[aria-current="page"]');
  if (current) current.scrollIntoView({ block: "nearest" });
}

// ---- On this page ----------------------------------------------------------

function tocItems(headings, path, onPick) {
  return headings.map((h) => {
    const a = el("a", { href: docHash(path, h.id), "data-id": h.id }, h.textContent);
    a.addEventListener("click", (event) => {
      onPick();
      // The hash won't change if this heading is already in it, so scroll here.
      if (a.hash === location.hash) {
        event.preventDefault();
        scrollToHeading(h.id);
      }
    });
    return el("li", { class: `toc-${h.tagName.toLowerCase()}` }, a);
  });
}

function fillToc(path) {
  const headings = [...layout.article.querySelectorAll("h2, h3")].filter((h) => h.id);
  layout.tocList.replaceChildren(...tocItems(headings, path, () => {}));
  layout.tocInlineList.replaceChildren(
    ...tocItems(headings, path, () => {
      layout.tocInline.open = false;
    }),
  );
  layout.toc.hidden = headings.length === 0;
  layout.tocInline.hidden = headings.length === 0;
  layout.tocInline.open = false;
  updateTocHighlight();
}

function clearToc() {
  layout.tocList.replaceChildren();
  layout.tocInlineList.replaceChildren();
  layout.toc.hidden = true;
  layout.tocInline.hidden = true;
}

// Highlight the heading the reader has reached. Only the wide layout shows this list.
function updateTocHighlight() {
  if (!layout || !layout.root.isConnected || layout.toc.hidden) return;
  const { toc, tocList, article } = layout;
  if (getComputedStyle(toc).display === "none") return;
  const links = [...tocList.querySelectorAll("a")];
  if (links.length === 0) return;
  const headerHeight = document.getElementById("tk-top").offsetHeight;
  const headings = links.map((a) => article.querySelector(`#${CSS.escape(a.dataset.id)}`));
  let active = -1;
  headings.forEach((h, i) => {
    if (h && h.getBoundingClientRect().top <= headerHeight + 24) active = i;
  });
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  if (atEnd) active = links.length - 1;
  links.forEach((a, i) => {
    if (i === active) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  });
  const link = links[active];
  if (link) {
    // Move only this list, never the page.
    const box = toc.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.top < box.top) toc.scrollTop -= box.top - item.top + 8;
    else if (item.bottom > box.bottom) toc.scrollTop += item.bottom - box.bottom + 8;
  }
}

let highlightQueued = false;
function queueTocHighlight() {
  if (highlightQueued) return;
  highlightQueued = true;
  requestAnimationFrame(() => {
    highlightQueued = false;
    updateTocHighlight();
  });
}
window.addEventListener("scroll", queueTocHighlight, { passive: true });
window.addEventListener("resize", queueTocHighlight, { passive: true });

// ---- Previous and next -----------------------------------------------------

function fillPager(path) {
  const i = layout.order.indexOf(path);
  const card = (label, target, cls) =>
    target
      ? el("a", { href: docHash(target), class: `pager-link ${cls}` }, el("span", { class: "pager-label" }, label), el("span", { class: "pager-title" }, docTitle(target)))
      : el("span", { class: `pager-link pager-empty ${cls}` });
  layout.pager.replaceChildren(
    card("Previous", layout.order[i - 1], "pager-prev"),
    card("Next", layout.order[i + 1], "pager-next"),
  );
}

// ---- Paths and links -------------------------------------------------------

// Resolve a relative path against the open doc's folder. Returns null when it
// goes above the repo root.
function resolvePath(href, docPath) {
  const out = href.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(decode(seg));
    }
  }
  return out.join("/");
}

const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const EXTERNAL = /^(https?:|mailto:)/i;

function unwrap(a) {
  a.replaceWith(...a.childNodes);
}

function rewriteLinks(root, docPath) {
  for (const a of [...root.querySelectorAll("a")]) {
    const href = (a.getAttribute("href") || "").trim();
    if (!href) {
      unwrap(a);
    } else if (EXTERNAL.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else if (SCHEME.test(href)) {
      unwrap(a); // some other kind of address: not followed
    } else if (href.startsWith("#")) {
      a.setAttribute("href", docHash(docPath, href.slice(1)));
    } else {
      const hash = href.indexOf("#");
      const pathPart = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
      const heading = hash < 0 ? "" : href.slice(hash + 1);
      const path = resolvePath(pathPart, docPath);
      if (path === null) {
        unwrap(a);
      } else if (path.endsWith(".md")) {
        a.setAttribute("href", docHash(path, heading));
      } else {
        const kind = pathPart.endsWith("/") ? "tree" : "blob";
        const target = path.split("/").map(encodeURIComponent).join("/");
        a.setAttribute("href", `https://github.com/${OWNER}/${REPO}/${kind}/${BRANCH}/${target}`);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener");
      }
    }
  }
}

// GitHub's heading id rule. Repeated hyphens are kept.
function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function setHeadingIds(root) {
  const seen = new Map();
  for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const slug = slugOf(h.textContent);
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    h.id = n === 0 ? slug : `${slug}-${n}`;
  }
}

// ---- Code blocks -----------------------------------------------------------

function addCopyButtons(root) {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const button = el("button", { type: "button", class: "code-copy" }, "Copy");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Couldn't copy";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
    const block = el("div", { class: "code-block" }, el("div", { class: "code-bar" }, button));
    pre.replaceWith(block);
    block.append(pre);
  }
}

// ---- Images ----------------------------------------------------------------

const MIME = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
};

// Move each relative image's src into data-src, so the browser doesn't ask
// for it at the wrong address. Anything on another site is not loaded.
function prepareImages(root, docPath) {
  for (const img of root.querySelectorAll("img")) {
    const src = (img.getAttribute("src") || "").trim();
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    if (/^data:image\//i.test(src)) {
      img.setAttribute("src", src);
    } else if (!src || SCHEME.test(src)) {
      img.classList.add("img-failed");
    } else {
      const path = resolvePath(src.split("#")[0].split("?")[0], docPath);
      if (path === null) img.classList.add("img-failed");
      else img.dataset.src = path;
    }
  }
}

async function loadImages(root, id, ctx) {
  const pending = [...root.querySelectorAll("img[data-src]")];
  await Promise.all(
    pending.map(async (img) => {
      const path = img.dataset.src;
      let url = imageUrls.get(path);
      if (!url) {
        try {
          const bytes = await fetchFileBytes(path);
          if (id !== renderId) return;
          const type = MIME[path.split(".").pop().toLowerCase()] || "application/octet-stream";
          url = URL.createObjectURL(new Blob([bytes], { type }));
          imageUrls.set(path, url);
        } catch (err) {
          if (id !== renderId) return;
          if (err && err.kind === "unauthorized") ctx.onUnauthorized();
          img.classList.add("img-failed");
          return;
        }
      }
      img.addEventListener("load", keepHeadingInView);
      img.src = url;
    }),
  );
}

// Images change the page's height as they load. Until the reader moves, keep
// the requested heading where it was scrolled to.
function keepHeadingInView() {
  if (scrollWatch.moved || Date.now() > scrollWatch.until || !scrollWatch.h || !layout) return;
  const target = layout.article.querySelector(`#${CSS.escape(scrollWatch.h)}`);
  if (target) target.scrollIntoView();
}

// ---- Rendering -------------------------------------------------------------

function renderMarkdown(text, path) {
  const html = marked.parse(text, { gfm: true });
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  setHeadingIds(fragment);
  rewriteLinks(fragment, path);
  prepareImages(fragment, path);
  addCopyButtons(fragment);
  return fragment;
}

function scrollToHeading(h) {
  const target = h ? layout.article.querySelector(`#${CSS.escape(h)}`) : null;
  scrollWatch = { until: Date.now() + 4000, h: target ? h : "", moved: false };
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

// route: { path, h }. ctx: { model, onUnauthorized }.
export async function renderDocs(view, route, ctx) {
  const { paths, error } = ctx.model.docs;
  if (!paths) {
    renderId++;
    layout = null;
    view.replaceChildren(el("p", { class: "warning", role: "status" }, el("strong", {}, "Warning: "), error));
    return;
  }
  if (!layout || layout.root.parentNode !== view) {
    layout = buildLayout(paths);
    view.replaceChildren(layout.root);
  }
  const path = route.path;
  // Same doc, different heading: nothing to redraw.
  if (layout.renderedPath === path) {
    scrollToHeading(route.h);
    return;
  }

  const id = ++renderId;
  const { article } = layout;
  layout.renderedPath = null;
  markOpen(paths.includes(path) ? path : "");
  clearToc();
  layout.pager.replaceChildren();

  if (!paths.includes(path)) {
    article.replaceChildren(el("p", {}, "Doc not found."));
    window.scrollTo(0, 0);
    return;
  }

  let text = textCache.get(path);
  if (text === undefined) {
    article.replaceChildren(el("p", { class: "loading" }, "Loading…"));
    try {
      text = await fetchFile(path);
    } catch (err) {
      if (id !== renderId || !article.isConnected) return;
      if (err && err.kind === "unauthorized") return ctx.onUnauthorized();
      article.replaceChildren(el("p", { class: "warning", role: "status" }, describeError(err, path)));
      return;
    }
    if (id !== renderId || !article.isConnected) return;
    textCache.set(path, text);
  }

  if (currentPath !== path) {
    revokeImages();
    currentPath = path;
  }
  article.replaceChildren(renderMarkdown(text, path));
  layout.renderedPath = path;
  fillToc(path);
  fillPager(path);
  scrollToHeading(route.h);
  loadImages(article, id, ctx);
}
