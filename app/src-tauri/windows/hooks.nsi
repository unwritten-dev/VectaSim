; VectaSim – NSIS installer hooks (tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Tauri's installer.nsi inserts these macros into its own sections (Section Install /
; Section Uninstall), so everything here runs inside a section: DetailPrint, ExecWait and
; MessageBox work, $INSTDIR is the install folder and ${MAINBINARYNAME} the exe name
; ("vectasim"). $PassiveMode (/P, used by the in-app updater) is declared by the template,
; ${Silent} (/S) comes from LogicLib.
;
; SimConnect.dll is NOT bundled (MSFS SDK EULA, see DEVELOPMENT.md "SimConnect"). After a
; normal, interactive installation the hook asks once whether VectaSim should fetch it now from
; Microsoft's SDK server – the same verified download as Einstellungen → Simulator, run by the
; installed exe in its headless mode:
;   vectasim.exe --install-simconnect --check   exit 0 = a usable DLL is already there
;   vectasim.exe --install-simconnect           exit 0 = ok, 2 = network, 3 = checksum, 1 = other
; Log: %LOCALAPPDATA%\io.vectasim.app\logs\simconnect-install.log
; The error dialog shows the real log path: $3 = the LOCALAPPDATA environment variable of the
; installing user (the same folder the exe writes to). NSIS does not expand "%LOCALAPPDATA%" in
; strings. The question stays short; the exit code goes only into the logs (DetailPrint, simconnect-install.log).
; Nothing here can fail the installation, and silent/passive runs never download anything.
;
; Keep this file UTF-8 *with* BOM: makensis reads BOM-less files in the ANSI code page.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    ; no question without a dialog – and no download without the user's consent
    DetailPrint "SimConnect.dll: no download in silent/passive mode (VectaSim offers it under Settings → Simulator)"
  ${Else}
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --install-simconnect --check' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 = 0
      ${If} $LANGUAGE = 1031
        DetailPrint "SimConnect.dll ist bereits vorhanden."
      ${Else}
        DetailPrint "SimConnect.dll is already present."
      ${EndIf}
    ${Else}
      ReadEnvStr $3 LOCALAPPDATA
      ${If} $3 == ""
        StrCpy $3 "$PROFILE\AppData\Local"
      ${EndIf}
      ${If} $LANGUAGE = 1031
        StrCpy $1 "Für den Microsoft Flight Simulator braucht VectaSim die SimConnect.dll. Jetzt herunterladen?$\r$\n$\r$\nVectaSim lädt dafür das offizielle Microsoft-Paket (ca. 108 MB) und behält nur diese eine Datei. Es gelten die Lizenzbedingungen des MSFS SDK.$\r$\n$\r$\nNur X-Plane 12? Dann „Nein“. Später geht es auch in VectaSim unter Einstellungen → Simulator."
      ${Else}
        StrCpy $1 "For Microsoft Flight Simulator, VectaSim needs SimConnect.dll. Download it now?$\r$\n$\r$\nVectaSim fetches the official Microsoft package (about 108 MB) and keeps only this one file. The MSFS SDK licence terms apply.$\r$\n$\r$\nOnly X-Plane 12? Then choose “No”. You can also do this later in VectaSim under Settings → Simulator."
      ${EndIf}
      ; $2 = 1 when the user said yes (relative jump: no labels, the macro could be inserted twice)
      StrCpy $2 0
      MessageBox MB_YESNO|MB_ICONQUESTION "$1" /SD IDNO IDNO +2
      StrCpy $2 1
      ${If} $2 = 1
        ${If} $LANGUAGE = 1031
          DetailPrint "SimConnect wird heruntergeladen (ca. 108 MB) …"
        ${Else}
          DetailPrint "Downloading SimConnect (about 108 MB) …"
        ${EndIf}
        ClearErrors
        ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --install-simconnect' $0
        ${If} ${Errors}
          StrCpy $0 1
        ${EndIf}
        ${If} $0 = 0
          ${If} $LANGUAGE = 1031
            DetailPrint "SimConnect.dll heruntergeladen und geprüft."
          ${Else}
            DetailPrint "SimConnect.dll downloaded and verified."
          ${EndIf}
        ${Else}
          ${If} $LANGUAGE = 1031
            DetailPrint "SimConnect-Download fehlgeschlagen (Code $0)."
            MessageBox MB_OK|MB_ICONEXCLAMATION "Der SimConnect-Download ist fehlgeschlagen. Du kannst ihn jederzeit in VectaSim unter Einstellungen → Simulator wiederholen.$\r$\n$\r$\nProtokoll mit Fehlercode: $3\io.vectasim.app\logs\simconnect-install.log" /SD IDOK
          ${Else}
            DetailPrint "SimConnect download failed (code $0)."
            MessageBox MB_OK|MB_ICONEXCLAMATION "The SimConnect download failed. You can retry it any time in VectaSim under Settings → Simulator.$\r$\n$\r$\nLog with the error code: $3\io.vectasim.app\logs\simconnect-install.log" /SD IDOK
          ${EndIf}
        ${EndIf}
      ${Else}
        ${If} $LANGUAGE = 1031
          DetailPrint "SimConnect.dll nicht heruntergeladen (später unter Einstellungen → Simulator)."
        ${Else}
          DetailPrint "SimConnect.dll not downloaded (later under Settings → Simulator)."
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Uninstall: nothing to do – the downloaded DLL stays in %LOCALAPPDATA%\io.vectasim.app like
; the rest of the user data (Tauri removes that folder only when "Delete app data" is ticked).
!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
