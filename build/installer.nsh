; installer.nsh - NSIS custom hooks for the Codia installer
;
; Owns the Windows overlay boundary for Codia installs. The installer may
; replace Codia-owned program files, while user/runtime state stays outside
; $INSTDIR.

; Disable CRC integrity check. electron-builder's post-compilation PE editing
; (signtool + rcedit) corrupts the NSIS CRC when no signing cert is configured,
; causing "Installer integrity check has failed" on Windows.
CRCCheck off

!include LogicLib.nsh

!macro codiaFindProcess _NAME _RETURN
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C tasklist /FI "IMAGENAME eq ${_NAME}" /FO CSV | "$SYSDIR\find.exe" "${_NAME}"`
  Pop ${_RETURN}
!macroend

!macro codiaFindRunningProcesses _RETURN
  !insertmacro codiaFindProcess "Codia.exe" ${_RETURN}
  ${If} ${_RETURN} != 0
    !insertmacro codiaFindProcess "Codia.exe" ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    ; Preserve upgrade cleanup for installations created before the visible rename.
    !insertmacro codiaFindProcess "Codia.exe" ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    !insertmacro codiaFindProcess codia-server.exe ${_RETURN}
  ${EndIf}
!macroend

!macro codiaKillProcess _NAME _FORCE
  Push $0
  Push $1
  ${If} ${_FORCE} == 1
    StrCpy $0 "/F"
  ${Else}
    StrCpy $0 ""
  ${EndIf}
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C taskkill $0 /T /IM "${_NAME}"`
  Pop $1
  Pop $1
  Pop $0
!macroend

!macro codiaKillRunningProcesses _FORCE
  !insertmacro codiaKillProcess "Codia.exe" ${_FORCE}
  !insertmacro codiaKillProcess "Codia.exe" ${_FORCE}
  !insertmacro codiaKillProcess "Codia.exe" ${_FORCE}
  !insertmacro codiaKillProcess codia-server.exe ${_FORCE}
!macroend

!macro codiaWriteInstallDirProcessCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('CODIA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-CodiaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-CodiaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-CodiaPath $$_.ExecutablePath) -or (Test-CodiaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `} | ForEach-Object {$\r$\n`
  FileWrite $0 `  Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro codiaWriteInstallDirProcessFinder _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('CODIA_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 1 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-CodiaPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-CodiaCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$$matches = @(Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-CodiaPath $$_.ExecutablePath) -or (Test-CodiaCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `})$\r$\n`
  FileWrite $0 `$$matches | ForEach-Object {$\r$\n`
  FileWrite $0 `  Write-Output ("Codia-owned process still running: {0} pid={1} path={2}" -f $$_.Name, $$_.ProcessId, $$_.ExecutablePath)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$matches.Count -gt 0) { exit 0 } else { exit 1 }$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro codiaStopInstallDirProcesses
  ; Stop every process launched from this install root. This catches renamed
  ; helper processes and stale child processes that do not use fixed image names.
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\codia-stop-install-dir.ps1"
  !insertmacro codiaWriteInstallDirProcessCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "CODIA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
!macroend

!macro codiaFindInstallDirProcesses _RETURN
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\codia-find-install-dir.ps1"
  !insertmacro codiaWriteInstallDirProcessFinder "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "CODIA_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop ${_RETURN}
  Pop $1
  Pop $0
!macroend

!macro codiaBypassOldUninstallerForUpdate
  ${If} ${isUpdated}
    DetailPrint "Update mode detected; bypassing the previous uninstaller and preparing a Codia-owned overlay."
    !insertmacro codiaPrepareOwnedOverlay
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    ClearErrors
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro codiaRemoveLegacyShortcuts
  Delete "$DESKTOP\Codia.lnk"
  Delete "$SMPROGRAMS\Codia.lnk"
!macroend

!macro customInstall
  !insertmacro codiaRemoveLegacyShortcuts
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    HideWindow
    StrCpy $1 "--updated"
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  ${EndIf}
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customCheckAppRunning
  !insertmacro codiaBypassOldUninstallerForUpdate
  !insertmacro codiaStopInstallDirProcesses
  !insertmacro codiaFindInstallDirProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected a Codia-owned process in the install directory; closing it before install."
    Sleep 500
    !insertmacro codiaStopInstallDirProcesses

    StrCpy $R1 0
    codia_check_install_dir_processes:
      !insertmacro codiaFindInstallDirProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for Codia-owned install-directory processes to close."
        ${If} $R1 > 2
          DetailPrint "Codia-owned install-directory processes are still running; asking the user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY codia_retry_install_dir_close
          Quit
          codia_retry_install_dir_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro codiaStopInstallDirProcesses
        Sleep 1000
        Goto codia_check_install_dir_processes
      ${EndIf}
  ${EndIf}

  ${IfNot} ${isUpdated}
  !insertmacro codiaFindRunningProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected a Codia or local-service process; closing it before install."
    !insertmacro codiaKillRunningProcesses 0
    Sleep 500

    !insertmacro codiaFindRunningProcesses $R0
    ${If} $R0 == 0
      !insertmacro codiaKillRunningProcesses 1
      Sleep 1000
    ${EndIf}

    StrCpy $R1 0
    codia_check_processes:
      !insertmacro codiaFindRunningProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for Codia and local-service processes to close."
        ${If} $R1 > 2
          DetailPrint "Codia or local-service processes are still running; asking the user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY codia_retry_close
          Quit
          codia_retry_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro codiaKillRunningProcesses 1
        Sleep 1000
        Goto codia_check_processes
      ${EndIf}
  ${EndIf}
  ${EndIf}
!macroend

!macro codiaCleanBundledServer
  ; resources\server is generated on every build. Remove it before copying
  ; new files so a failed stale uninstall cannot leave mixed bundle/deps/native files.
  IfFileExists "$INSTDIR\resources\server\*.*" 0 +3
    DetailPrint "Removing old bundled server resources"
    RMDir /r "$INSTDIR\resources\server"
!macroend

!macro codiaRemoveOwnedInstallTrees
  DetailPrint "Removing Codia-owned install files"
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR\resources\server"
  RMDir /r "$INSTDIR\resources\git"
  RMDir /r "$INSTDIR\resources\screenshot-themes"
  RMDir /r "$INSTDIR\resources\app"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\app-update.yml"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\Codia.exe"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\uninstallerIcon.ico"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\*.ico"
!macroend

!macro codiaPrepareOwnedOverlay
  !insertmacro codiaStopInstallDirProcesses
  !insertmacro codiaRemoveOwnedInstallTrees
  ClearErrors
!macroend

!macro customInit
  !insertmacro codiaStopInstallDirProcesses
  ; Wait for file handles to release.
  Sleep 2000
!macroend

!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint `Previous uninstaller could not be launched; preparing a Codia-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous uninstaller exited with code $R0; preparing a Codia-owned overlay.`
  ${EndIf}
  !insertmacro codiaPrepareOwnedOverlay
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${If} ${Errors}
    DetailPrint `Previous current-user uninstaller could not be launched; continuing with a Codia-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous current-user uninstaller exited with code $R0; continuing with a Codia-owned overlay.`
  ${EndIf}
  !insertmacro codiaPrepareOwnedOverlay
  ClearErrors
!macroend

!macro customRemoveFiles
  !insertmacro codiaStopInstallDirProcesses
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro codiaRemoveOwnedInstallTrees
  RMDir "$INSTDIR"
!macroend

!macro customUnInit
  !insertmacro codiaStopInstallDirProcesses
  Sleep 2000
!macroend
