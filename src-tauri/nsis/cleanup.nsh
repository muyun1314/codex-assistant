; Custom NSIS header for Codex Assistant
; Deletes user/ folder during uninstall if requested

!macro customUnInstall
  ; Remove user data directory (contains API keys and config)
  RMDir /r "$INSTDIR\user"
  ; Remove runtime temp files
  Delete "$INSTDIR\.ui-port"
!macroend
