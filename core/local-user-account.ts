// @ts-nocheck
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const LOCAL_USER_AUTH_FILE = "local-user-auth.json";

const USERS_FILE = "users.json";
const SCHEMA_VERSION = 1;
const PASSWORD_ALGORITHM = "scrypt-sha256";
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 512;
const USERNAME_MAX_LENGTH = 64;
const DISPLAY_NAME_MAX_LENGTH = 80;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1 });

export function getLocalAccountSummary(gsapHome) {
  const { user } = loadDefaultUser(gsapHome);
  const auth = loadLocalUserAuth(gsapHome);
  return sanitizeAccount(user, { passwordSet: !!findCredential(auth, user.userId) });
}

export function updateLocalAccountProfile(gsapHome, {
  username,
  displayName,
  now = new Date().toISOString(),
} = {}) {
  const users = loadUsers(gsapHome);
  const user = getDefaultUser(users);
  user.username = normalizeUsername(username, user.username || user.displayName);
  user.displayName = normalizeDisplayName(displayName, user.displayName);
  user.updatedAt = now;
  users.updatedAt = now;
  writeJsonAtomic(path.join(gsapHome, USERS_FILE), users);
  const auth = loadLocalUserAuth(gsapHome);
  return sanitizeAccount(user, { passwordSet: !!findCredential(auth, user.userId) });
}

export function setLocalAccountPassword(gsapHome, {
  password,
  now = new Date().toISOString(),
} = {}) {
  const { user } = loadDefaultUser(gsapHome);
  const normalizedPassword = normalizePassword(password);
  const auth = loadLocalUserAuth(gsapHome);
  const credential = findCredential(auth, user.userId);
  const passwordSalt = randomToken(16);
  const nextCredential = {
    schemaVersion: SCHEMA_VERSION,
    userId: user.userId,
    algorithm: PASSWORD_ALGORITHM,
    passwordHash: hashPassword(normalizedPassword, passwordSalt),
    passwordSalt,
    keyLength: PASSWORD_KEY_LENGTH,
    params: { ...SCRYPT_OPTIONS },
    createdAt: credential?.createdAt || now,
    updatedAt: now,
  };
  if (credential) Object.assign(credential, nextCredential);
  else auth.credentials.push(nextCredential);
  auth.updatedAt = now;
  writeJsonAtomic(path.join(gsapHome, LOCAL_USER_AUTH_FILE), auth);
  return sanitizeAccount(user, { passwordSet: true });
}

export function clearLocalAccountPassword(gsapHome, {
  now = new Date().toISOString(),
} = {}) {
  const { user } = loadDefaultUser(gsapHome);
  const auth = loadLocalUserAuth(gsapHome);
  auth.credentials = auth.credentials.filter((credential) => credential.userId !== user.userId);
  auth.updatedAt = now;
  writeJsonAtomic(path.join(gsapHome, LOCAL_USER_AUTH_FILE), auth);
  return sanitizeAccount(user, { passwordSet: false });
}

export function verifyLocalAccountPassword(gsapHome, { username, password } = {}) {
  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    return { ok: false, reason: "invalid_credentials" };
  }
  const users = loadUsers(gsapHome);
  const auth = loadLocalUserAuth(gsapHome);
  const normalizedUsername = normalizeAccountLookup(username);
  const user = users.users.find((candidate) => {
    return normalizeAccountLookup(candidate.username) === normalizedUsername
      || normalizeAccountLookup(candidate.displayName) === normalizedUsername
      || normalizeAccountLookup(candidate.userId) === normalizedUsername;
  });
  if (!user) return { ok: false, reason: "invalid_credentials" };
  const credential = findCredential(auth, user.userId);
  if (!credential) return { ok: false, reason: "password_not_set" };
  if (!verifyPassword(password, credential)) return { ok: false, reason: "invalid_credentials" };
  return {
    ok: true,
    userId: user.userId,
    account: sanitizeAccount(user, { passwordSet: true }),
  };
}

export function loadLocalUserAuth(gsapHome, { now = new Date().toISOString() } = {}) {
  const filePath = path.join(gsapHome, LOCAL_USER_AUTH_FILE);
  const existing = readJsonIfPresent(filePath, LOCAL_USER_AUTH_FILE);
  if (existing) return validateLocalUserAuth(existing, LOCAL_USER_AUTH_FILE);
  return {
    schemaVersion: SCHEMA_VERSION,
    credentials: [],
    createdAt: now,
    updatedAt: now,
  };
}

function loadDefaultUser(gsapHome) {
  const users = loadUsers(gsapHome);
  return { users, user: getDefaultUser(users) };
}

function loadUsers(gsapHome) {
  return validateUsers(readJsonRequired(path.join(gsapHome, USERS_FILE), USERS_FILE), USERS_FILE);
}

function getDefaultUser(users) {
  const user = users.users.find((candidate) => candidate.userId === users.defaultUserId);
  if (!user) throw new Error(`invalid ${USERS_FILE}: defaultUserId must reference an existing user`);
  return user;
}

function validateUsers(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!isNonEmptyString(value.defaultUserId)) throw new Error(`invalid ${label}: defaultUserId required`);
  if (!Array.isArray(value.users) || value.users.length === 0) {
    throw new Error(`invalid ${label}: users must be a non-empty array`);
  }
  for (const user of value.users) {
    if (!isPlainObject(user)) throw new Error(`invalid ${label}: user must be object`);
    if (!isNonEmptyString(user.userId)) throw new Error(`invalid ${label}: userId required`);
    if (!isNonEmptyString(user.displayName)) throw new Error(`invalid ${label}: displayName required`);
  }
  return value;
}

function validateLocalUserAuth(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!Array.isArray(value.credentials)) throw new Error(`invalid ${label}: credentials must be array`);
  for (const credential of value.credentials) {
    if (!isPlainObject(credential)) throw new Error(`invalid ${label}: credential must be object`);
    if (!isNonEmptyString(credential.userId)) throw new Error(`invalid ${label}: credential.userId required`);
    if (credential.algorithm !== PASSWORD_ALGORITHM) throw new Error(`invalid ${label}: unsupported algorithm`);
    if (!isNonEmptyString(credential.passwordHash)) throw new Error(`invalid ${label}: passwordHash required`);
    if (!isNonEmptyString(credential.passwordSalt)) throw new Error(`invalid ${label}: passwordSalt required`);
  }
  return value;
}

function findCredential(auth, userId) {
  return auth.credentials.find((credential) => credential.userId === userId) || null;
}

function sanitizeAccount(user, { passwordSet }) {
  return {
    userId: user.userId,
    username: user.username || user.displayName || user.userId,
    displayName: user.displayName,
    kind: user.kind || null,
    passwordSet: passwordSet === true,
    updatedAt: user.updatedAt || null,
  };
}

function normalizeUsername(value, fallback) {
  const raw = isNonEmptyString(value) ? value.trim() : fallback;
  if (!isNonEmptyString(raw)) throw new Error("username required");
  if (raw.length > USERNAME_MAX_LENGTH) throw new Error(`username must be at most ${USERNAME_MAX_LENGTH} characters`);
  if (hasControlOrDelete(raw) || raw.includes("/") || raw.includes("\\")) {
    throw new Error("username contains unsupported characters");
  }
  return raw;
}

function normalizeDisplayName(value, fallback) {
  const raw = isNonEmptyString(value) ? value.trim() : fallback;
  if (!isNonEmptyString(raw)) throw new Error("displayName required");
  if (raw.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  if (hasControlOrDelete(raw)) throw new Error("displayName contains unsupported characters");
  return raw;
}

function hasControlOrDelete(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function normalizePassword(value) {
  if (typeof value !== "string") throw new Error("password required");
  if (value.length < PASSWORD_MIN_LENGTH) throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (value.length > PASSWORD_MAX_LENGTH) throw new Error(`password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  return value;
}

function normalizeAccountLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH, SCRYPT_OPTIONS).toString("base64");
}

function verifyPassword(password, credential) {
  const expected = Buffer.from(credential.passwordHash, "base64");
  const actual = crypto.scryptSync(password, credential.passwordSalt, expected.length, credential.params || SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function readJsonRequired(filePath, label) {
  const value = readJsonIfPresent(filePath, label);
  if (!value) throw new Error(`${label} not found`);
  return value;
}

function readJsonIfPresent(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) throw new Error(`invalid ${label}: ${err.message}`);
    throw new Error(`failed to read ${label}: ${err.message}`);
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
