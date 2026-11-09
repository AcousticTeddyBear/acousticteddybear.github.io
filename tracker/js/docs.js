// The Docs tab: a list of every .md file, and the open doc rendered as HTML.

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
let layout = null; // { root, sidebar, select, article }
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

function groupDocs(paths) {
  const groups = new Map();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const folder = i < 0 ? "" : p.slice(0, i);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(p);
  }
  const folders = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : byName(a, b)));
  return folders.map((folder) => ({
    folder,
    title: folder === "" ? "Top level" : folder,
    paths: groups.get(folder).sort((a, b) => byName(a.slice(a.lastIndexOf("/") + 1), b.slice(b.lastIndexOf("/") + 1))),
  }));
}

function buildLayout(paths) {
  const groups = groupDocs(paths);
  const sidebar = el("nav", { class: "doc-sidebar", "aria-label": "Docs" });
  for (const g of groups) {
    sidebar.append(
      el("h3", {}, g.title),
      el(
        "ul",
        {},
        g.paths.map((p) =>
          el("li", {}, el("a", { href: docHash(p), "data-path": p }, p.slice(p.lastIndexOf("/") + 1))),
        ),
      ),
    );
  }
  const select = el(
    "select",
    { class: "doc-select", "aria-label": "Choose a doc" },
    groups.map((g) =>
      el(
        "optgroup",
        { label: g.title },
        g.paths.map((p) => el("option", { value: p }, p.slice(p.lastIndexOf("/") + 1))),
      ),
    ),
  );
  select.addEventListener("change", () => {
    location.hash = docHash(select.value);
  });
  const article = el("article", { class: "doc" });
  const root = el("div", { class: "docs" }, sidebar, el("div", { class: "doc-main" }, select, article));
  return { root, sidebar, select, article };
}

function markOpen(path) {
  for (const a of layout.sidebar.querySelectorAll("a")) {
    if (a.dataset.path === path) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  layout.select.value = path;
  const current = layout.sidebar.querySelector('[aria-current="page"]');
  if (current) current.scrollIntoView({ block: "nearest" });
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
  const id = ++renderId;
  const { paths, error } = ctx.model.docs;
  if (!paths) {
    layout = null;
    view.replaceChildren(el("p", { class: "warning", role: "status" }, el("strong", {}, "Warning: "), error));
    return;
  }
  if (!layout || layout.root.parentNode !== view) {
    layout = buildLayout(paths);
    view.replaceChildren(layout.root);
  }
  const { article } = layout;
  const path = route.path;
  markOpen(paths.includes(path) ? path : "");

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
      if (id !== renderId) return;
      if (err && err.kind === "unauthorized") return ctx.onUnauthorized();
      article.replaceChildren(el("p", { class: "warning", role: "status" }, describeError(err, path)));
      return;
    }
    if (id !== renderId) return;
    textCache.set(path, text);
  }

  if (currentPath !== path) {
    revokeImages();
    currentPath = path;
  }
  article.replaceChildren(renderMarkdown(text, path));
  scrollToHeading(route.h);
  loadImages(article, id, ctx);
}
