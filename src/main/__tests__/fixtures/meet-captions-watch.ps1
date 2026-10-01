# READ-ONLY: sample Meet's captions group every 400 ms for N seconds and print (time, speaker, text) changes.
param([int]$Seconds = 60)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$AllCond = [System.Windows.Automation.Condition]::TrueCondition
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -match '^Meet - ' } | Select-Object -First 1
if (-not $p) { "no Meet window"; exit }
$doc = $A::FromHandle($p.MainWindowHandle).FindFirst($TS::Descendants, $docCond)
$capNames = @(('Ph' + [char]0x1EE5 + ' ' + [char]0x0111 + [char]0x1EC1), 'Captions')
$last = ""
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $groups = $doc.FindAll($TS::Children, $AllCond)
  $cap = $null
  $els = $doc.FindAll($TS::Descendants, $AllCond)
  for ($i = 0; $i -lt $els.Count; $i++) { $c = $els.Item($i).Current; if ($c.ControlType.ProgrammaticName -eq 'ControlType.Group' -and $capNames -contains $c.Name) { $cap = $els.Item($i); break } }
  $ms = $sw.ElapsedMilliseconds
  if ($cap) {
    $kids = $cap.FindAll($TS::Descendants, $AllCond)
    $parts = @()
    for ($k = 0; $k -lt $kids.Count; $k++) { $kc = $kids.Item($k).Current; if ($kc.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $kc.Name) { $parts += $kc.Name } }
    $line = ($parts -join ' || ')
    if ($line -ne $last) { "{0:HH:mm:ss.fff} read={1}ms | {2}" -f (Get-Date), $ms, $line; $last = $line }
  } else {
    if ($last -ne "<none>") { "{0:HH:mm:ss.fff} captions group not found (read={1}ms)" -f (Get-Date), $ms; $last = "<none>" }
  }
  Start-Sleep -Milliseconds 400
}
"done"
