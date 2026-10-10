#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef LUA_TOKEN
#define LUA_TOKEN 0x00000004
#endif
#ifndef WRITE_RESTRICTED
#define WRITE_RESTRICTED 0x00000008
#endif

struct WritableRoot {
    std::wstring path;
    bool required;
    std::wstring sidString;
    PSID sid = nullptr;
};

struct Options {
    std::wstring cwd;
    std::vector<WritableRoot> writableRoots;
    std::vector<std::wstring> denyWritePaths;
    std::vector<std::wstring> codiaWriteAclCleanupPaths;
    std::vector<std::wstring> legacyAclDiagnosticPaths;
    std::vector<std::wstring> legacyProfileNames;
    std::vector<std::wstring> legacyProfileCleanupNames;
    bool cleanupLegacyAcl = false;
    bool diagnoseToken = false;
    std::wstring executable;
    std::vector<std::wstring> args;
};

struct LegacyProfileSid {
    std::wstring name;
    std::wstring sidString;
    PSID sid = nullptr;
};

struct MigrationResult {
    int findings = 0;
    int failures = 0;
};

struct AclRestore {
    std::wstring path;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL oldDacl = nullptr;
};

struct SandboxDesktop {
    std::wstring name;
    HDESK handle = nullptr;
};

struct TokenDefaultDaclSnapshot {
    std::vector<BYTE> buffer;
    PACL dacl = nullptr;
};

struct StartupAttributeList {
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
};

static const DWORD WRITE_ALLOW_MASK =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD;
static const DWORD WRITE_DENY_MASK =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | FILE_DELETE_CHILD;
static const wchar_t* EVERYONE_SID = L"S-1-1-0";
static const wchar_t* WRITE_RESTRICTED_CODE_SID = L"S-1-5-33";

static void fail(const std::wstring& message) {
    std::wcerr << L"codia-win-sandbox: " << message << std::endl;
}
static void debug(const std::wstring& message) {
    wchar_t enabled[8] = {};
    DWORD n = GetEnvironmentVariableW(L"CODIA_WIN32_SANDBOX_DEBUG", enabled, 8);
    if (n == 0) {
        n = GetEnvironmentVariableW(L"CODIA_WIN32_SANDBOX_DEBUG", enabled, 8);
    }
    if (n > 0 && enabled[0] != L'\0' && enabled[0] != L'0') {
        std::wcerr << L"codia-win-sandbox: " << message << std::endl;
    }
}

static std::wstring win32Message(DWORD code) {
    LPWSTR buffer = nullptr;
    FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        code,
        0,
        reinterpret_cast<LPWSTR>(&buffer),
        0,
        nullptr
    );
    std::wstring out = buffer ? buffer : L"unknown error";
    if (buffer) LocalFree(buffer);
    return out;
}

static bool isDirectory(const std::wstring& p) {
    DWORD attrs = GetFileAttributesW(p.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring normalizePathKey(std::wstring out) {
    if (out.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        out = L"\\\\" + out.substr(8);
    } else if (out.rfind(L"\\\\?\\", 0) == 0) {
        out = out.substr(4);
    }
    if (out.rfind(L"\\??\\UNC\\", 0) == 0) {
        out = L"\\\\" + out.substr(8);
    } else if (out.rfind(L"\\??\\", 0) == 0) {
        out = out.substr(4);
    }
    std::replace(out.begin(), out.end(), L'/', L'\\');
    std::transform(out.begin(), out.end(), out.begin(), [](wchar_t ch) {
        return static_cast<wchar_t>(std::towupper(ch));
    });
    while (out.size() > 3 && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    return out;
}

static std::wstring finalPathForKey(const std::wstring& raw) {
    HANDLE handle = CreateFileW(
        raw.c_str(),
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr
    );
    if (handle == INVALID_HANDLE_VALUE) return L"";

    DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, VOLUME_NAME_DOS);
    if (needed == 0) {
        CloseHandle(handle);
        return L"";
    }
    std::wstring out(needed + 1, L'\0');
    DWORD written = GetFinalPathNameByHandleW(handle, out.data(), needed + 1, VOLUME_NAME_DOS);
    CloseHandle(handle);
    if (written == 0 || written > needed) return L"";
    out.resize(written);
    return normalizePathKey(out);
}

static std::wstring fullPathForKey(const std::wstring& raw) {
    std::wstring finalPath = finalPathForKey(raw);
    if (!finalPath.empty()) return finalPath;

    DWORD needed = GetFullPathNameW(raw.c_str(), 0, nullptr, nullptr);
    if (needed == 0) return raw;
    std::wstring out(needed, L'\0');
    DWORD written = GetFullPathNameW(raw.c_str(), needed, out.data(), nullptr);
    if (written == 0 || written >= needed) return raw;
    out.resize(written);
    return normalizePathKey(out);
}

static bool isSameOrInside(const std::wstring& childRaw, const std::wstring& rootRaw) {
    std::wstring child = fullPathForKey(childRaw);
    std::wstring root = fullPathForKey(rootRaw);
    if (child == root) return true;
    if (root.empty()) return false;
    if (root.back() != L'\\') root.push_back(L'\\');
    return child.size() > root.size() && child.compare(0, root.size(), root) == 0;
}

static std::wstring hashSidForWritableRoot(const std::wstring& root, const std::wstring& prefix, const std::wstring& discriminator) {
    const std::wstring key = discriminator + fullPathForKey(root);
    std::uint32_t hashes[4] = { 2166136261u, 2166136261u ^ 0x9e3779b9u, 2166136261u ^ 0x85ebca6bu, 2166136261u ^ 0xc2b2ae35u };
    for (wchar_t ch : key) {
        std::uint32_t value = static_cast<std::uint32_t>(ch);
        for (int i = 0; i < 4; i++) {
            hashes[i] ^= (value + static_cast<std::uint32_t>(i * 257));
            hashes[i] *= 16777619u;
            hashes[i] ^= (hashes[i] >> 13);
        }
    }
    return prefix +
        std::to_wstring(hashes[0] | 1u) + L"-" +
        std::to_wstring(hashes[1] | 1u) + L"-" +
        std::to_wstring(hashes[2] | 1u) + L"-" +
        std::to_wstring(hashes[3] | 1u);
}

static std::wstring sidForWritableRoot(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-5-21-", L"codia-win32-write-root-v3:");
}

static std::wstring sidForWritableRootLegacyCapabilityNamespace(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-15-3-4096-", L"codia-win32-write-root-v2:");
}

static std::wstring sidForWritableRootLegacyAccountNamespace(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-5-21-", L"codia-win32-write-root:");
}

static std::wstring sidForCodiaWritableRoot(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-15-3-4096-", L"codia-win32-write-root-v2:");
}

static std::wstring sidForCodiaWritableRootLegacyAccountNamespace(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-5-21-", L"codia-win32-write-root:");
}

static Options parseArgs(int argc, wchar_t** argv) {
    Options opts;
    bool passthrough = false;
    for (int i = 1; i < argc; i++) {
        std::wstring arg = argv[i];
        if (passthrough) {
            if (opts.executable.empty()) opts.executable = arg;
            else opts.args.push_back(arg);
            continue;
        }
        if (arg == L"--") {
            passthrough = true;
            continue;
        }
        if (arg == L"--cwd" && i + 1 < argc) {
            opts.cwd = argv[++i];
            continue;
        }
        if ((arg == L"--writable-root" || arg == L"--writable-root-optional") && i + 1 < argc) {
            std::wstring target = argv[++i];
            opts.writableRoots.push_back({ target, arg == L"--writable-root" });
            continue;
        }
        if (arg == L"--deny-write" && i + 1 < argc) {
            opts.denyWritePaths.push_back(argv[++i]);
            continue;
        }
        if ((arg == L"--cleanup-codia-write-acl" || arg == L"--cleanup-codia-write-acl") && i + 1 < argc) {
            opts.codiaWriteAclCleanupPaths.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--diagnose-legacy-acl" && i + 1 < argc) {
            opts.legacyAclDiagnosticPaths.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--cleanup-legacy-acl") {
            opts.cleanupLegacyAcl = true;
            continue;
        }
        if (arg == L"--legacy-appcontainer-profile" && i + 1 < argc) {
            opts.legacyProfileNames.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--cleanup-legacy-profile" && i + 1 < argc) {
            opts.legacyProfileCleanupNames.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--diagnose-token") {
            opts.diagnoseToken = true;
            continue;
        }
        if (arg == L"--network" || arg == L"--grant-read" || arg == L"--grant-read-optional" ||
            arg == L"--grant-write" || arg == L"--grant-write-optional" || arg == L"--deny-read") {
            throw std::runtime_error("legacy AppContainer helper argument is no longer supported");
        }
        throw std::runtime_error("unknown or incomplete argument");
    }

    bool maintenanceMode = !opts.codiaWriteAclCleanupPaths.empty() ||
        !opts.legacyAclDiagnosticPaths.empty() ||
        !opts.legacyProfileNames.empty() ||
        !opts.legacyProfileCleanupNames.empty() ||
        opts.cleanupLegacyAcl;
    if (maintenanceMode) {
        if (!opts.cwd.empty() || !opts.executable.empty() || !opts.writableRoots.empty() || !opts.denyWritePaths.empty() || opts.diagnoseToken) {
            throw std::runtime_error("maintenance arguments cannot be combined with sandbox execution arguments");
        }
        return opts;
    }
    if (opts.cwd.empty()) throw std::runtime_error("missing --cwd");
    if (opts.executable.empty()) throw std::runtime_error("missing executable after --");
    if (opts.writableRoots.empty()) opts.writableRoots.push_back({ opts.cwd, true });
    return opts;
}

static std::wstring quoteArg(const std::wstring& arg) {
    if (arg.empty()) return L"\"\"";
    bool needsQuotes = arg.find_first_of(L" \t\n\v\"") != std::wstring::npos;
    if (!needsQuotes) return arg;

    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            backslashes++;
            continue;
        }
        if (ch == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(ch);
            backslashes = 0;
            continue;
        }
        out.append(backslashes, L'\\');
        backslashes = 0;
        out.push_back(ch);
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

static std::wstring buildCommandLine(const Options& opts) {
    std::wstring command = quoteArg(opts.executable);
    for (const auto& arg : opts.args) {
        command.push_back(L' ');
        command += quoteArg(arg);
    }
    return command;
}

static bool aceMatchesSidAndMask(PACL dacl, PSID sid, BYTE aceType, DWORD mask) {
    if (!dacl || !sid) return false;
    for (DWORD i = 0; i < dacl->AceCount; i++) {
        void* rawAce = nullptr;
        if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
        ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
        if (header->AceType != aceType) continue;
        if (aceType == ACCESS_ALLOWED_ACE_TYPE) {
            auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
            PSID aceSid = reinterpret_cast<PSID>(&ace->SidStart);
            if (EqualSid(aceSid, sid) && ((ace->Mask & mask) == mask)) return true;
        } else if (aceType == ACCESS_DENIED_ACE_TYPE) {
            auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
            PSID aceSid = reinterpret_cast<PSID>(&ace->SidStart);
            if (EqualSid(aceSid, sid) && ((ace->Mask & mask) == mask)) return true;
        }
    }
    return false;
}

static bool ensureAce(
    const std::wstring& path,
    PSID sid,
    ACCESS_MODE mode,
    DWORD mask,
    bool required,
    std::vector<AclRestore>* restores = nullptr
) {
    PACL oldDacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD rc = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        &oldDacl,
        nullptr,
        &descriptor
    );
    if (rc != ERROR_SUCCESS) {
        if (required) fail(L"cannot read ACL for " + path + L": " + win32Message(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Message(rc));
        return false;
    }

    BYTE aceType = mode == DENY_ACCESS ? ACCESS_DENIED_ACE_TYPE : ACCESS_ALLOWED_ACE_TYPE;
    if (aceMatchesSidAndMask(oldDacl, sid, aceType, mask)) {
        if (descriptor) LocalFree(descriptor);
        return true;
    }

    EXPLICIT_ACCESSW access = {};
    access.grfAccessPermissions = mask;
    access.grfAccessMode = mode;
    access.grfInheritance = isDirectory(path) ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);

    PACL newDacl = nullptr;
    rc = SetEntriesInAclW(1, &access, oldDacl, &newDacl);
    if (rc != ERROR_SUCCESS) {
        if (required) fail(L"cannot build ACL for " + path + L": " + win32Message(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Message(rc));
        if (descriptor) LocalFree(descriptor);
        return false;
    }

    rc = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        newDacl,
        nullptr
    );
    if (newDacl) LocalFree(newDacl);
    if (rc != ERROR_SUCCESS) {
        if (descriptor) LocalFree(descriptor);
        if (required) fail(L"cannot apply ACL for " + path + L": " + win32Message(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Message(rc));
        return false;
    }
    if (restores) {
        restores->push_back({ path, descriptor, oldDacl });
        descriptor = nullptr;
    }
    if (descriptor) LocalFree(descriptor);
    return true;
}

static void restoreAcls(std::vector<AclRestore>& restores) {
    for (auto it = restores.rbegin(); it != restores.rend(); ++it) {
        DWORD rc = SetNamedSecurityInfoW(
            const_cast<LPWSTR>(it->path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            it->oldDacl,
            nullptr
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"cannot restore ACL for " + it->path + L": " + win32Message(rc));
        }
        if (it->descriptor) LocalFree(it->descriptor);
        it->descriptor = nullptr;
        it->oldDacl = nullptr;
    }
    restores.clear();
}

static bool convertRootSids(std::vector<WritableRoot>& roots) {
    for (auto& root : roots) {
        root.sidString = sidForWritableRoot(root.path);
        if (!ConvertStringSidToSidW(root.sidString.c_str(), &root.sid)) {
            fail(L"cannot create restricted SID for " + root.path + L": " + win32Message(GetLastError()));
            return false;
        }
    }
    return true;
}

static void freeRootSids(std::vector<WritableRoot>& roots) {
    for (auto& root : roots) {
        if (root.sid) LocalFree(root.sid);
        root.sid = nullptr;
    }
}

static bool applyWriteAcls(
    std::vector<WritableRoot>& roots,
    const std::vector<std::wstring>& denyWritePaths,
    std::vector<AclRestore>& restores
) {
    for (const auto& root : roots) {
        if (!ensureAce(root.path, root.sid, GRANT_ACCESS, WRITE_ALLOW_MASK, root.required, &restores) && root.required) {
            return false;
        }
    }

    for (const auto& denyPath : denyWritePaths) {
        bool matched = false;
        for (const auto& root : roots) {
            if (!root.sid || !isSameOrInside(denyPath, root.path)) continue;
            matched = true;
            if (!ensureAce(denyPath, root.sid, DENY_ACCESS, WRITE_DENY_MASK, true, &restores)) return false;
        }
        if (!matched) {
            debug(L"deny-write path is outside writable roots: " + denyPath);
        }
    }
    return true;
}

static bool queryTokenDefaultDacl(HANDLE token, TokenDefaultDaclSnapshot& snapshot) {
    DWORD needed = 0;
    GetTokenInformation(token, TokenDefaultDacl, nullptr, 0, &needed);
    if (needed == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        debug(L"GetTokenInformation(TokenDefaultDacl) size failed: " + win32Message(GetLastError()));
        return false;
    }
    snapshot.buffer.assign(needed, 0);
    if (!GetTokenInformation(token, TokenDefaultDacl, snapshot.buffer.data(), needed, &needed)) {
        debug(L"GetTokenInformation(TokenDefaultDacl) failed: " + win32Message(GetLastError()));
        snapshot.buffer.clear();
        snapshot.dacl = nullptr;
        return false;
    }
    auto* info = reinterpret_cast<TOKEN_DEFAULT_DACL*>(snapshot.buffer.data());
    snapshot.dacl = info ? info->DefaultDacl : nullptr;
    return true;
}

static PACL buildDaclWithRootSids(const std::vector<WritableRoot>& roots, PACL baseDefaultDacl, DWORD permissions) {
    std::vector<EXPLICIT_ACCESSW> entries;
    for (const auto& root : roots) {
        if (!root.sid) continue;
        EXPLICIT_ACCESSW access = {};
        access.grfAccessPermissions = permissions;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = NO_INHERITANCE;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(root.sid);
        entries.push_back(access);
    }
    if (entries.empty()) return nullptr;
    PACL dacl = nullptr;
    DWORD rc = SetEntriesInAclW(
        static_cast<ULONG>(entries.size()),
        entries.data(),
        baseDefaultDacl,
        &dacl
    );
    if (rc != ERROR_SUCCESS) {
        debug(L"SetEntriesInAclW(root SID DACL) failed: " + win32Message(rc));
        return nullptr;
    }
    return dacl;
}

static bool sidAlreadyListed(const std::vector<SID_AND_ATTRIBUTES>& sids, PSID sid) {
    if (!sid) return true;
    return std::any_of(sids.begin(), sids.end(), [sid](const SID_AND_ATTRIBUTES& existing) {
        return existing.Sid && EqualSid(existing.Sid, sid);
    });
}

static bool appendRestrictingSid(std::vector<SID_AND_ATTRIBUTES>& sids, PSID sid) {
    if (!sid || sidAlreadyListed(sids, sid)) return true;
    SID_AND_ATTRIBUTES attr = {};
    attr.Sid = sid;
    attr.Attributes = 0;
    sids.push_back(attr);
    return true;
}

static bool appendRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    const std::wstring& sidString,
    std::vector<PSID>& ownedSids
) {
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(sidString.c_str(), &sid)) {
        fail(L"cannot create restricting SID " + sidString + L": " + win32Message(GetLastError()));
        return false;
    }
    if (sidAlreadyListed(sids, sid)) {
        LocalFree(sid);
        return true;
    }
    ownedSids.push_back(sid);
    return appendRestrictingSid(sids, sid);
}

static void freeOwnedSids(std::vector<PSID>& sids) {
    for (PSID sid : sids) {
        if (sid) LocalFree(sid);
    }
    sids.clear();
}

static PSID copySidToLocalAlloc(PSID source) {
    if (!source || !IsValidSid(source)) return nullptr;
    DWORD length = GetLengthSid(source);
    PSID copy = LocalAlloc(LMEM_FIXED, length);
    if (!copy) return nullptr;
    if (!CopySid(length, copy, source)) {
        LocalFree(copy);
        return nullptr;
    }
    return copy;
}

static bool appendEveryoneRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    std::vector<PSID>& ownedSids
) {
    return appendRestrictingSid(sids, EVERYONE_SID, ownedSids);
}

static bool appendCurrentLogonRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    HANDLE token,
    std::vector<PSID>& ownedSids
) {
    DWORD needed = 0;
    GetTokenInformation(token, TokenGroups, nullptr, 0, &needed);
    if (needed == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        debug(L"GetTokenInformation(TokenGroups) size failed: " + win32Message(GetLastError()));
        return true;
    }

    std::vector<BYTE> buffer(needed, 0);
    if (!GetTokenInformation(token, TokenGroups, buffer.data(), needed, &needed)) {
        debug(L"GetTokenInformation(TokenGroups) failed: " + win32Message(GetLastError()));
        return true;
    }

    auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
    for (DWORD i = 0; groups && i < groups->GroupCount; i++) {
        SID_AND_ATTRIBUTES& group = groups->Groups[i];
        if ((group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
        PSID copy = copySidToLocalAlloc(group.Sid);
        if (!copy) {
            fail(L"cannot copy current logon SID");
            return false;
        }
        ownedSids.push_back(copy);
        return appendRestrictingSid(sids, copy);
    }

    debug(L"current logon SID was not present in TokenGroups");
    return true;
}

static bool buildRestrictingSids(
    const std::vector<WritableRoot>& roots,
    HANDLE baseToken,
    std::vector<SID_AND_ATTRIBUTES>& restrictingSids,
    std::vector<PSID>& ownedRestrictingSids
) {
    if (!appendEveryoneRestrictingSid(restrictingSids, ownedRestrictingSids)) return false;
    if (!appendCurrentLogonRestrictingSid(restrictingSids, baseToken, ownedRestrictingSids)) return false;
    for (const auto& root : roots) {
        if (!root.sid) continue;
        appendRestrictingSid(restrictingSids, root.sid);
    }
    if (!appendRestrictingSid(restrictingSids, WRITE_RESTRICTED_CODE_SID, ownedRestrictingSids)) return false;
    if (restrictingSids.empty()) {
        fail(L"no restricting SIDs available for restricted token");
        return false;
    }
    return true;
}

static HANDLE createRestrictedWriteToken(const std::vector<WritableRoot>& roots) {
    HANDLE baseToken = nullptr;
    DWORD desired = TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_IMPERSONATE |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
    if (!OpenProcessToken(GetCurrentProcess(), desired, &baseToken)) {
        fail(L"OpenProcessToken failed: " + win32Message(GetLastError()));
        return nullptr;
    }
    TokenDefaultDaclSnapshot baseDefaultDacl;
    queryTokenDefaultDacl(baseToken, baseDefaultDacl);

    std::vector<SID_AND_ATTRIBUTES> restrictingSids;
    std::vector<PSID> ownedRestrictingSids;
    if (!buildRestrictingSids(roots, baseToken, restrictingSids, ownedRestrictingSids)) {
        CloseHandle(baseToken);
        freeOwnedSids(ownedRestrictingSids);
        return nullptr;
    }

    HANDLE restrictedToken = nullptr;
    DWORD flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    BOOL ok = CreateRestrictedToken(
        baseToken,
        flags,
        0,
        nullptr,
        0,
        nullptr,
        static_cast<DWORD>(restrictingSids.size()),
        restrictingSids.data(),
        &restrictedToken
    );
    CloseHandle(baseToken);
    freeOwnedSids(ownedRestrictingSids);
    if (!ok) {
        fail(L"CreateRestrictedToken failed: " + win32Message(GetLastError()));
        return nullptr;
    }

    PACL defaultDacl = buildDaclWithRootSids(roots, baseDefaultDacl.dacl, GENERIC_ALL);
    if (defaultDacl) {
        TOKEN_DEFAULT_DACL info = {};
        info.DefaultDacl = defaultDacl;
        if (!SetTokenInformation(restrictedToken, TokenDefaultDacl, &info, sizeof(info))) {
            debug(L"SetTokenInformation(TokenDefaultDacl) failed: " + win32Message(GetLastError()));
        }
        LocalFree(defaultDacl);
    } else {
        debug(L"TokenDefaultDacl left unchanged because no merged DACL was built");
    }

    return restrictedToken;
}

static HANDLE createKillOnCloseJob() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return nullptr;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
        CloseHandle(job);
        return nullptr;
    }
    return job;
}

static bool createSandboxDesktop(const std::vector<WritableRoot>& roots, SandboxDesktop& desktop) {
    HANDLE processToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &processToken)) {
        fail(L"OpenProcessToken for desktop DACL failed: " + win32Message(GetLastError()));
        return false;
    }

    TokenDefaultDaclSnapshot baseDefaultDacl;
    queryTokenDefaultDacl(processToken, baseDefaultDacl);
    CloseHandle(processToken);

    PACL desktopDacl = buildDaclWithRootSids(roots, baseDefaultDacl.dacl, GENERIC_ALL);
    if (!desktopDacl) {
        fail(L"cannot build sandbox desktop ACL");
        return false;
    }

    SECURITY_DESCRIPTOR descriptor = {};
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, desktopDacl, FALSE)) {
        DWORD err = GetLastError();
        LocalFree(desktopDacl);
        fail(L"cannot initialize sandbox desktop descriptor: " + win32Message(err));
        return false;
    }

    desktop.name = L"codia-win-sandbox-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(GetTickCount64());
    SECURITY_ATTRIBUTES attributes = {};
    attributes.nLength = sizeof(attributes);
    attributes.lpSecurityDescriptor = &descriptor;
    attributes.bInheritHandle = FALSE;

    desktop.handle = CreateDesktopW(
        desktop.name.c_str(),
        nullptr,
        nullptr,
        0,
        GENERIC_ALL,
        &attributes
    );
    LocalFree(desktopDacl);
    if (!desktop.handle) {
        fail(L"CreateDesktopW failed: " + win32Message(GetLastError()));
        return false;
    }
    return true;
}

static void closeSandboxDesktop(SandboxDesktop& desktop) {
    if (desktop.handle) CloseDesktop(desktop.handle);
    desktop.handle = nullptr;
    desktop.name.clear();
}

static bool isValidInheritableCandidate(HANDLE handle) {
    return handle && handle != INVALID_HANDLE_VALUE;
}

static void pushUniqueHandle(std::vector<HANDLE>& handles, HANDLE handle) {
    if (!isValidInheritableCandidate(handle)) return;
    if (std::find(handles.begin(), handles.end(), handle) == handles.end()) {
        handles.push_back(handle);
    }
}

static bool setupInheritedHandleList(const std::vector<HANDLE>& handles, StartupAttributeList& attributes) {
    if (handles.empty()) return true;
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    if (size == 0) {
        fail(L"InitializeProcThreadAttributeList size failed: " + win32Message(GetLastError()));
        return false;
    }
    attributes.list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        HeapAlloc(GetProcessHeap(), 0, size)
    );
    if (!attributes.list) {
        fail(L"HeapAlloc for process attribute list failed");
        return false;
    }
    if (!InitializeProcThreadAttributeList(attributes.list, 1, 0, &size)) {
        fail(L"InitializeProcThreadAttributeList failed: " + win32Message(GetLastError()));
        return false;
    }
    if (!UpdateProcThreadAttribute(
        attributes.list,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        const_cast<HANDLE*>(handles.data()),
        handles.size() * sizeof(HANDLE),
        nullptr,
        nullptr
    )) {
        fail(L"UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST) failed: " + win32Message(GetLastError()));
        return false;
    }
    return true;
}

static void freeStartupAttributeList(StartupAttributeList& attributes) {
    if (attributes.list) {
        DeleteProcThreadAttributeList(attributes.list);
        HeapFree(GetProcessHeap(), 0, attributes.list);
    }
    attributes.list = nullptr;
}

static int runSandboxed(const Options& opts, HANDLE restrictedToken) {
    SandboxDesktop desktop;
    if (!createSandboxDesktop(opts.writableRoots, desktop)) {
        return 1;
    }

    STARTUPINFOEXW startup = {};
    startup.StartupInfo.cb = sizeof(STARTUPINFOW);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.StartupInfo.lpDesktop = const_cast<LPWSTR>(desktop.name.c_str());

    std::vector<HANDLE> inheritedHandles;
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdInput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdOutput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdError);
    StartupAttributeList inheritedAttributes;
    if (!setupInheritedHandleList(inheritedHandles, inheritedAttributes)) {
        freeStartupAttributeList(inheritedAttributes);
        closeSandboxDesktop(desktop);
        return 1;
    }
    startup.lpAttributeList = inheritedAttributes.list;

    std::wstring commandLine = buildCommandLine(opts);
    PROCESS_INFORMATION process = {};
    DWORD flags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
    BOOL inheritHandles = FALSE;
    if (startup.lpAttributeList) {
        startup.StartupInfo.cb = sizeof(STARTUPINFOEXW);
        flags |= EXTENDED_STARTUPINFO_PRESENT;
        inheritHandles = TRUE;
    }
    BOOL ok = CreateProcessAsUserW(
        restrictedToken,
        opts.executable.c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        inheritHandles,
        flags,
        nullptr,
        opts.cwd.c_str(),
        &startup.StartupInfo,
        &process
    );
    freeStartupAttributeList(inheritedAttributes);

    if (!ok) {
        fail(L"CreateProcessAsUserW failed: " + win32Message(GetLastError()));
        closeSandboxDesktop(desktop);
        return 1;
    }

    HANDLE job = createKillOnCloseJob();
    if (!job) {
        fail(L"CreateJobObject failed: " + win32Message(GetLastError()));
        TerminateProcess(process.hProcess, 1);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        closeSandboxDesktop(desktop);
        return 1;
    }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        fail(L"AssignProcessToJobObject failed: " + win32Message(GetLastError()));
        TerminateProcess(process.hProcess, 1);
        CloseHandle(job);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        closeSandboxDesktop(desktop);
        return 1;
    }

    ResumeThread(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);

    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    closeSandboxDesktop(desktop);
    return static_cast<int>(exitCode);
}

static bool stringStartsWith(const std::wstring& value, const std::wstring& prefix) {
    return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

static bool isDigitsOnly(const std::wstring& value) {
    if (value.empty()) return false;
    return std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return ch >= L'0' && ch <= L'9';
    });
}

static bool isLegacyAppContainerProfileName(const std::wstring& name) {
    const std::vector<std::wstring> prefixes = {
        L"com.codia.sandbox.",
        // legacy compatibility: clean up AppContainer profiles created by old Codia builds.
        L"com.codia.sandbox.",
    };
    for (const auto& prefix : prefixes) {
        if (!stringStartsWith(name, prefix)) continue;
        std::wstring rest = name.substr(prefix.size());
        size_t dot = rest.find(L'.');
        if (dot == std::wstring::npos) return false;
        return isDigitsOnly(rest.substr(0, dot)) && isDigitsOnly(rest.substr(dot + 1));
    }
    return false;
}

static std::wstring sidToString(PSID sid) {
    LPWSTR sidText = nullptr;
    if (!sid || !ConvertSidToStringSidW(sid, &sidText)) return L"";
    std::wstring sidString = sidText;
    LocalFree(sidText);
    return sidString;
}

static std::wstring probeNamedObjectNamespace(HANDLE restrictedToken) {
    if (!ImpersonateLoggedOnUser(restrictedToken)) {
        return L"impersonate-failed:" + std::to_wstring(GetLastError()) + L":" + win32Message(GetLastError());
    }

    std::wstring name = L"Local\\codia-win-sandbox-diagnose-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(GetTickCount64());
    HANDLE mutex = CreateMutexW(nullptr, FALSE, name.c_str());
    DWORD rc = mutex ? ERROR_SUCCESS : GetLastError();
    if (mutex) CloseHandle(mutex);
    RevertToSelf();

    if (rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS) return L"ok";
    return L"error:" + std::to_wstring(rc) + L":" + win32Message(rc);
}

static int diagnoseRestrictedToken(const Options& opts) {
    HANDLE baseToken = nullptr;
    DWORD desired = TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_IMPERSONATE |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
    if (!OpenProcessToken(GetCurrentProcess(), desired, &baseToken)) {
        fail(L"OpenProcessToken failed: " + win32Message(GetLastError()));
        return 1;
    }

    std::vector<SID_AND_ATTRIBUTES> restrictingSids;
    std::vector<PSID> ownedRestrictingSids;
    bool ok = buildRestrictingSids(opts.writableRoots, baseToken, restrictingSids, ownedRestrictingSids);
    CloseHandle(baseToken);
    if (!ok) {
        freeOwnedSids(ownedRestrictingSids);
        return 1;
    }

    std::wcerr
        << L"codia-win-sandbox: diagnose-token"
        << L" cwd=\"" << opts.cwd << L"\""
        << L" executable=\"" << opts.executable << L"\""
        << L" writable-root-count=\"" << opts.writableRoots.size() << L"\""
        << L" restricting-sid-count=\"" << restrictingSids.size() << L"\""
        << std::endl;
    for (const auto& root : opts.writableRoots) {
        std::wcerr
            << L"codia-win-sandbox: diagnose-token-writable-root"
            << L" required=\"" << (root.required ? L"true" : L"false") << L"\""
            << L" path=\"" << root.path << L"\""
            << L" sid=\"" << root.sidString << L"\""
            << std::endl;
    }
    for (const auto& sid : restrictingSids) {
        std::wcerr
            << L"codia-win-sandbox: diagnose-token-restricting-sid"
            << L" sid=\"" << sidToString(sid.Sid) << L"\""
            << std::endl;
    }

    HANDLE token = createRestrictedWriteToken(opts.writableRoots);
    if (!token) {
        freeOwnedSids(ownedRestrictingSids);
        return 1;
    }
    std::wcerr
        << L"codia-win-sandbox: diagnose-token-base-named-objects-probe"
        << L" result=\"" << probeNamedObjectNamespace(token) << L"\""
        << std::endl;
    CloseHandle(token);
    freeOwnedSids(ownedRestrictingSids);
    return 0;
}

static bool isLegacyAppContainerSid(PSID sid, std::wstring* sidStringOut = nullptr) {
    std::wstring sidString = sidToString(sid);
    if (sidString.empty()) return false;
    bool legacy = stringStartsWith(sidString, L"S-1-15-2-");
    if (legacy && sidStringOut) *sidStringOut = sidString;
    return legacy;
}

static bool pushUniqueLegacyProfileName(std::vector<std::wstring>& out, const std::wstring& name) {
    if (!isLegacyAppContainerProfileName(name)) {
        fail(L"invalid legacy AppContainer profile name: " + name);
        return false;
    }
    auto it = std::find_if(out.begin(), out.end(), [&name](const std::wstring& existing) {
        return _wcsicmp(existing.c_str(), name.c_str()) == 0;
    });
    if (it == out.end()) out.push_back(name);
    return true;
}

static std::vector<std::wstring> uniqueLegacyProfileNames(const std::vector<std::wstring>& names, int* failures) {
    std::vector<std::wstring> out;
    for (const auto& name : names) {
        if (!pushUniqueLegacyProfileName(out, name) && failures) (*failures)++;
    }
    return out;
}

static std::vector<LegacyProfileSid> deriveLegacyProfileSids(
    const std::vector<std::wstring>& names,
    int* failures
) {
    std::vector<LegacyProfileSid> profiles;
    for (const auto& name : names) {
        PSID sid = nullptr;
        HRESULT hr = DeriveAppContainerSidFromAppContainerName(name.c_str(), &sid);
        if (FAILED(hr) || !sid) {
            fail(L"cannot derive legacy AppContainer SID for " + name +
                L": HRESULT " + std::to_wstring(static_cast<unsigned long>(hr)));
            if (failures) (*failures)++;
            continue;
        }
        profiles.push_back({ name, sidToString(sid), sid });
    }
    return profiles;
}

static void freeLegacyProfileSids(std::vector<LegacyProfileSid>& profiles) {
    for (auto& profile : profiles) {
        if (profile.sid) FreeSid(profile.sid);
        profile.sid = nullptr;
    }
}

static const LegacyProfileSid* findLegacyProfileBySid(
    PSID sid,
    const std::vector<LegacyProfileSid>& profiles
) {
    if (!sid) return nullptr;
    for (const auto& profile : profiles) {
        if (profile.sid && EqualSid(sid, profile.sid)) return &profile;
    }
    return nullptr;
}

static bool revokeSidsFromPath(const std::wstring& path, const std::vector<PSID>& sids, PACL oldDacl) {
    if (sids.empty()) return true;
    std::vector<EXPLICIT_ACCESSW> entries;
    for (PSID sid : sids) {
        EXPLICIT_ACCESSW access = {};
        access.grfAccessMode = REVOKE_ACCESS;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
        entries.push_back(access);
    }
    PACL newDacl = nullptr;
    DWORD rc = SetEntriesInAclW(static_cast<ULONG>(entries.size()), entries.data(), oldDacl, &newDacl);
    if (rc != ERROR_SUCCESS) {
        fail(L"cannot build ACL cleanup for " + path + L": " + win32Message(rc));
        return false;
    }
    rc = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        newDacl,
        nullptr
    );
    if (newDacl) LocalFree(newDacl);
    if (rc != ERROR_SUCCESS) {
        fail(L"cannot clean ACL for " + path + L": " + win32Message(rc));
        return false;
    }
    return true;
}

static bool convertSidString(const std::wstring& sidString, PSID* sidOut) {
    *sidOut = nullptr;
    if (!ConvertStringSidToSidW(sidString.c_str(), sidOut)) {
        fail(L"cannot convert SID " + sidString + L": " + win32Message(GetLastError()));
        return false;
    }
    return true;
}

static MigrationResult cleanupCodiaWriteAcls(const std::vector<std::wstring>& paths) {
    MigrationResult result;
    for (const auto& path : paths) {
        std::vector<std::wstring> sidStrings = {
            sidForWritableRoot(path),
            sidForWritableRootLegacyCapabilityNamespace(path),
            sidForWritableRootLegacyAccountNamespace(path),
            sidForCodiaWritableRoot(path),
            sidForCodiaWritableRootLegacyAccountNamespace(path),
        };
        std::vector<PSID> ownedSids;
        for (const auto& sidString : sidStrings) {
            PSID sid = nullptr;
            if (convertSidString(sidString, &sid)) ownedSids.push_back(sid);
            else result.failures++;
        }
        if (ownedSids.empty()) continue;

        PACL dacl = nullptr;
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        DWORD rc = GetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            &dacl,
            nullptr,
            &descriptor
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"codia-write-acl-cleanup path=\"" + path + L"\" error=\"" + win32Message(rc) + L"\"");
            result.failures++;
            for (PSID sid : ownedSids) LocalFree(sid);
            continue;
        }

        std::vector<PSID> matchedSids;
        if (dacl) {
            for (DWORD i = 0; i < dacl->AceCount; i++) {
                void* rawAce = nullptr;
                if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
                ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
                if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;

                PSID aceSid = nullptr;
                if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                    auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
                    aceSid = reinterpret_cast<PSID>(&ace->SidStart);
                } else {
                    auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
                    aceSid = reinterpret_cast<PSID>(&ace->SidStart);
                }
                for (PSID ownedSid : ownedSids) {
                    if (!EqualSid(aceSid, ownedSid)) continue;
                    if (std::none_of(matchedSids.begin(), matchedSids.end(), [ownedSid](PSID existing) {
                        return EqualSid(existing, ownedSid);
                    })) {
                        matchedSids.push_back(ownedSid);
                    }
                }
            }
        }

        if (!matchedSids.empty()) {
            if (revokeSidsFromPath(path, matchedSids, dacl)) {
                result.findings += static_cast<int>(matchedSids.size());
                for (PSID sid : matchedSids) {
                    std::wcerr
                        << L"codia-win-sandbox: codia-write-acl-cleaned"
                        << L" path=\"" << path << L"\""
                        << L" sid=\"" << sidToString(sid) << L"\""
                        << std::endl;
                }
            } else {
                result.failures++;
            }
        }

        if (descriptor) LocalFree(descriptor);
        for (PSID sid : ownedSids) LocalFree(sid);
    }
    return result;
}

static MigrationResult diagnoseLegacyAcls(
    const Options& opts,
    const std::vector<LegacyProfileSid>& cleanupProfiles
) {
    MigrationResult result;
    for (const auto& path : opts.legacyAclDiagnosticPaths) {
        PACL dacl = nullptr;
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        DWORD rc = GetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            &dacl,
            nullptr,
            &descriptor
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"legacy-acl-diagnostic path=\"" + path + L"\" error=\"" + win32Message(rc) + L"\"");
            result.failures++;
            continue;
        }

        std::vector<PSID> legacySids;
        if (dacl) {
            for (DWORD i = 0; i < dacl->AceCount; i++) {
                void* rawAce = nullptr;
                if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
                ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
                if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;

                DWORD mask = 0;
                PSID sid = nullptr;
                std::wstring aceKind = L"unknown";
                if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                    auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
                    mask = ace->Mask;
                    sid = reinterpret_cast<PSID>(&ace->SidStart);
                    aceKind = L"allow";
                } else {
                    auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
                    mask = ace->Mask;
                    sid = reinterpret_cast<PSID>(&ace->SidStart);
                    aceKind = L"deny";
                }

                std::wstring sidString;
                if (!isLegacyAppContainerSid(sid, &sidString)) continue;
                result.findings++;
                const LegacyProfileSid* matchedProfile = findLegacyProfileBySid(sid, cleanupProfiles);
                std::wcerr
                    << L"codia-win-sandbox: legacy-appcontainer-acl"
                    << L" path=\"" << path << L"\""
                    << L" sid=\"" << sidString << L"\""
                    << L" profile=\"" << (matchedProfile ? matchedProfile->name : L"unmatched") << L"\""
                    << L" ace=\"" << aceKind << L"\""
                    << L" mask=\"" << mask << L"\""
                    << std::endl;
                if (opts.cleanupLegacyAcl && matchedProfile && std::none_of(legacySids.begin(), legacySids.end(), [sid](PSID existing) {
                    return EqualSid(existing, sid);
                })) {
                    legacySids.push_back(sid);
                }
            }
        }

        if (opts.cleanupLegacyAcl) {
            if (legacySids.empty()) {
                debug(L"legacy ACL cleanup found no Codia-owned AppContainer SID for " + path);
            } else if (!revokeSidsFromPath(path, legacySids, dacl)) {
                result.failures++;
            }
        }
        if (descriptor) LocalFree(descriptor);
    }
    return result;
}

static bool isMissingAppContainerProfile(HRESULT hr) {
    DWORD code = HRESULT_CODE(hr);
    return code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND || code == ERROR_NOT_FOUND;
}

static MigrationResult cleanupLegacyProfiles(const std::vector<std::wstring>& profileNames) {
    MigrationResult result;
    for (const auto& name : profileNames) {
        HRESULT hr = DeleteAppContainerProfile(name.c_str());
        if (SUCCEEDED(hr)) {
            result.findings++;
            std::wcerr
                << L"codia-win-sandbox: legacy-appcontainer-profile-cleaned"
                << L" name=\"" << name << L"\""
                << std::endl;
            continue;
        }
        if (isMissingAppContainerProfile(hr)) {
            debug(L"legacy AppContainer profile already absent: " + name);
            continue;
        }
        result.failures++;
        fail(L"cannot delete legacy AppContainer profile " + name +
            L": HRESULT " + std::to_wstring(static_cast<unsigned long>(hr)));
    }
    return result;
}

int wmain(int argc, wchar_t** argv) {
    Options opts;
    try {
        opts = parseArgs(argc, argv);
    } catch (const std::exception& err) {
        std::string narrow = err.what();
        std::wstring wide(narrow.begin(), narrow.end());
        std::wcerr << L"codia-win-sandbox: " << wide << std::endl;
        return 2;
    }

    if (!opts.codiaWriteAclCleanupPaths.empty() ||
        !opts.legacyAclDiagnosticPaths.empty() ||
        !opts.legacyProfileNames.empty() ||
        !opts.legacyProfileCleanupNames.empty() ||
        opts.cleanupLegacyAcl) {
        int failures = 0;
        std::vector<std::wstring> profileNames = uniqueLegacyProfileNames(opts.legacyProfileNames, &failures);
        std::vector<std::wstring> cleanupProfileNames = uniqueLegacyProfileNames(opts.legacyProfileCleanupNames, &failures);
        std::vector<std::wstring> sidProfileNames = profileNames;
        for (const auto& name : cleanupProfileNames) {
            auto it = std::find_if(sidProfileNames.begin(), sidProfileNames.end(), [&name](const std::wstring& existing) {
                return _wcsicmp(existing.c_str(), name.c_str()) == 0;
            });
            if (it == sidProfileNames.end()) sidProfileNames.push_back(name);
        }
        std::vector<LegacyProfileSid> profileSids = deriveLegacyProfileSids(sidProfileNames, &failures);

        MigrationResult codiaWriteResult;
        if (!opts.codiaWriteAclCleanupPaths.empty()) {
            codiaWriteResult = cleanupCodiaWriteAcls(opts.codiaWriteAclCleanupPaths);
        }

        MigrationResult aclResult;
        if (!opts.legacyAclDiagnosticPaths.empty()) {
            aclResult = diagnoseLegacyAcls(opts, profileSids);
        }
        failures += codiaWriteResult.failures + aclResult.failures;

        MigrationResult profileResult;
        if (failures == 0) {
            profileResult = cleanupLegacyProfiles(cleanupProfileNames);
            failures += profileResult.failures;
        } else if (!cleanupProfileNames.empty()) {
            debug(L"skipping legacy AppContainer profile cleanup because ACL cleanup failed");
        }
        int findings = codiaWriteResult.findings + aclResult.findings + profileResult.findings;

        freeLegacyProfileSids(profileSids);
        if (failures > 0) return 1;
        return findings > 0 ? 3 : 0;
    }

    int exitCode = 1;
    std::vector<AclRestore> aclRestores;
    if (!convertRootSids(opts.writableRoots)) {
        freeRootSids(opts.writableRoots);
        return 1;
    }
    if (opts.diagnoseToken) {
        int diagnosticExitCode = diagnoseRestrictedToken(opts);
        freeRootSids(opts.writableRoots);
        return diagnosticExitCode;
    }
    if (!applyWriteAcls(opts.writableRoots, opts.denyWritePaths, aclRestores)) {
        restoreAcls(aclRestores);
        freeRootSids(opts.writableRoots);
        return 1;
    }

    HANDLE token = createRestrictedWriteToken(opts.writableRoots);
    if (token) {
        exitCode = runSandboxed(opts, token);
        CloseHandle(token);
    }

    restoreAcls(aclRestores);
    freeRootSids(opts.writableRoots);
    return exitCode;
}
