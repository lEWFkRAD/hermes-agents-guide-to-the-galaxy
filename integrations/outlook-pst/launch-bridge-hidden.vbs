Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\HermesOutlookBridge\outlook_bridge.ps1") & """", 0, False
