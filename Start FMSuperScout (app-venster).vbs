Option Explicit
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Environment("PROCESS")("FMSS_APP") = "1"
sh.Run """" & base & "\dist\runtime\node.exe"" """ & base & "\app\server.js""", 0, False
