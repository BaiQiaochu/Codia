import path from "path";

const WINDOWS_UNSAFE_FILENAME_CHARS_RE = /[<>:"/\\|?*]/g;
const RESERVED_WINDOWS_NAMES_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function replaceUnsafeFilenameChars(value, replacement = " ") {
  const safeReplacement = String(replacement ?? " ");
  return String(value || "")
    .replace(WINDOWS_UNSAFE_FILENAME_CHARS_RE, safeReplacement)
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 ? safeReplacement : ch))
    .join("");
}

export function sanitizeFilenameBase(value, { fallback = "file", maxLength = 80 } = {}) {
  const normalized = replaceUnsafeFilenameChars(value, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/g, "")
    .trim();
  if (!normalized || RESERVED_WINDOWS_NAMES_RE.test(normalized)) return fallback;
  return normalized;
}

export function sanitizePathBasename(value, { fallback = "file" } = {}) {
  const raw = typeof value === "string" ? path.posix.basename(value.replace(/\\/g, "/")) : "";
  return sanitizeFilename(raw, { fallback, replacement: "" });
}

export function sanitizeFilename(value, { fallback = "file", replacement = " ", maxLength = 160 } = {}) {
  const normalized = replaceUnsafeFilenameChars(value, replacement)
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/g, "")
    .trim();
  if (!normalized || RESERVED_WINDOWS_NAMES_RE.test(normalized)) return fallback;
  return normalized;
}

export function sanitizeArtifactFilename(title, extension, { fallback = "artifact", maxBaseLength = 80 } = {}) {
  const cleanExt = replaceUnsafeFilenameChars(extension, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/g, "")
    .trim() || "txt";
  const base = sanitizeFilenameBase(title, { fallback, maxLength: maxBaseLength });
  return sanitizeFilename(`${base}.${cleanExt}`, { fallback: `${fallback}.${cleanExt}`, replacement: " " });
}

export function uniqueFilename(filename, usedNames = new Set()) {
  const used = usedNames instanceof Set ? usedNames : new Set(usedNames || []);
  const safe = sanitizeFilename(filename);
  if (!used.has(safe)) return safe;

  const ext = path.extname(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;
  let index = 2;
  let candidate = "";
  do {
    candidate = `${base} (${index})${ext}`;
    index += 1;
  } while (used.has(candidate));
  return candidate;
}

export function sanitizePublicMediaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}
