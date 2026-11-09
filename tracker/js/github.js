// Every call to the GitHub API lives here. The token is sent only in the
// Authorization header and is never logged or put in a URL.

export const OWNER = "AcousticTeddyBear";
export const REPO = "splitsteps-docs";
export const BRANCH = "main";
// On localhost the test server answers on the page's own address.
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? ""
  : "https://api.github.com";

const TOKEN_KEY = "splitsteps-tracker-token";
let memoryToken = ""; // used only if localStorage is unavailable

export function getToken() {
  try {
    return (localStorage.getItem(TOKEN_KEY) || memoryToken).trim();
  } catch {
    return memoryToken.trim();
  }
}

export function setToken(token) {
  memoryToken = token.trim();
  try {
    localStorage.setItem(TOKEN_KEY, memoryToken);
  } catch {
    /* keep it in memory for this visit */
  }
}

export function clearToken() {
  memoryToken = "";
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

export const MESSAGES = {
  unauthorized: "GitHub rejected this token. It may have expired, so create a new one.",
  cantRead: "This token can't read splitsteps-docs. Check its repository access and Contents permission.",
  network: "Couldn't reach GitHub. Check your connection, then Refresh.",
};

// kind: "unauthorized" (401), "ratelimit", "denied" (403 or 404),
//       "http" (any other status), "network" (fetch threw), "format" (odd answer)
export class ApiError extends Error {
  constructor(kind, status = 0, extra = {}) {
    super(kind);
    this.kind = kind;
    this.status = status;
    Object.assign(this, extra);
  }
}

function errorFor(res) {
  const status = res.status;
  if (status === 401) return new ApiError("unauthorized", status);
  if (status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return new ApiError("ratelimit", status, { resetAt: reset ? new Date(reset * 1000) : null });
  }
  if (status === 403 || status === 404) return new ApiError("denied", status);
  return new ApiError("http", status);
}

async function request(path, accept) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (accept) headers.Accept = accept;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers, cache: "no-store" });
  } catch {
    throw new ApiError("network");
  }
  if (!res.ok) throw errorFor(res);
  return res;
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const repoPath = `/repos/${OWNER}/${REPO}`;
const RAW = "application/vnd.github.raw+json";

export async function fetchFile(path) {
  const res = await request(`${repoPath}/contents/${encodePath(path)}?ref=${BRANCH}`, RAW);
  return res.text();
}

export async function fetchFileBytes(path) {
  const res = await request(`${repoPath}/contents/${encodePath(path)}?ref=${BRANCH}`, RAW);
  return res.arrayBuffer();
}

export async function fetchDocList() {
  const res = await request(`${repoPath}/git/trees/${BRANCH}?recursive=1`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("format", res.status);
  }
  if (!json || !Array.isArray(json.tree)) throw new ApiError("format", res.status);
  return json.tree
    .filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.endsWith(".md"))
    .map((e) => e.path);
}

export async function fetchCommits() {
  const res = await request(`${repoPath}/commits?sha=${BRANCH}&per_page=15`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("format", res.status);
  }
  if (!Array.isArray(json)) throw new ApiError("format", res.status);
  return json.map((c) => {
    const commit = c.commit || {};
    const date = String((commit.author && commit.author.date) || "");
    return {
      date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date,
      message: String(commit.message || "").split(/\r?\n/)[0],
    };
  });
}

// A short, plain description of why one request failed (for warnings).
export function reasonText(err) {
  switch (err && err.kind) {
    case "ratelimit":
      return "GitHub's rate limit is reached";
    case "network":
      return "couldn't reach GitHub";
    case "unauthorized":
      return "GitHub rejected the token (401)";
    case "denied":
      return err.status === 404
        ? "not found (404)"
        : "GitHub refused access (403)";
    case "http":
      return `GitHub answered ${err.status}`;
    default:
      return "GitHub's answer couldn't be read";
  }
}

// The message shown to the owner for an error, naming what was being loaded.
export function describeError(err, what) {
  if (err && err.kind === "unauthorized") return MESSAGES.unauthorized;
  if (err && err.kind === "network") return MESSAGES.network;
  if (err && err.kind === "ratelimit") return rateLimitMessage(err);
  return `${what}: ${reasonText(err)}.`;
}

export function rateLimitMessage(err) {
  const when = err.resetAt ? err.resetAt.toLocaleTimeString() : "a few minutes from now";
  return `GitHub's rate limit is reached. Try again after ${when}.`;
}
