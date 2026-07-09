' Launch the Hermes Diary bridge with no visible console window.
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run """" & scriptDir & "run-diary.cmd""", 0, False
