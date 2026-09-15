; WarpTalk NSIS customisation (electron-builder `nsis.include`).
;
; Sets up the Google Meet bridge cables (VB-CABLE and Hi-Fi Cable, VB-Audio donationware) as part of
; installing WarpTalk. See resources/windows-audio-drivers/README.md.
;
; Interactive installs only. Auto-updates run this installer with /S, and a UAC prompt in the middle
; of a silent update is exactly what an update must never do; the cables are already there by then.
; One elevated PowerShell runs both setups, so the user sees one UAC prompt, not one per cable.

!macro customInstall
  ${IfNot} ${Silent}
    ${If} ${FileExists} "$INSTDIR\resources\windows-audio-drivers\install-cables.ps1"
      DetailPrint "Setting up the Google Meet bridge audio cables (VB-Audio)..."
      ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\windows-audio-drivers\install-cables.ps1"' SW_HIDE
    ${EndIf}
  ${EndIf}
!macroend
