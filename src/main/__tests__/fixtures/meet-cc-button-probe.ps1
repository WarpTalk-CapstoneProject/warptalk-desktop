# READ-ONLY: fingerprint every Button in the Meet tab (patterns, ids, classes, ancestors) to tell Meet's own CC button from extension-injected ones.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$AllCond = [System.Windows.Automation.Condition]::TrueCondition
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$btnCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -match '^Meet - ' } | Select-Object -First 1
if (-not $p) { "no Meet window"; exit }
$doc = $A::FromHandle($p.MainWindowHandle).FindFirst($TS::Descendants, $docCond)
$btns = $doc.FindAll($TS::Descendants, $btnCond)
function Short($s, $n) { if (-not $s) { return "" }; $s = $s -replace "\s+", " "; if ($s.Length -gt $n) { $s.Substring(0, $n) + "..." } else { $s } }
for ($i = 0; $i -lt $btns.Count; $i++) {
  $e = $btns.Item($i); $c = $e.Current
  $pats = ($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern','' }) -join ','
  $toggle = ""; try { $toggle = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch {}
  $anc = @(); $x = $walker.GetParent($e); $depth = 0
  while ($x -ne $null -and $depth -lt 6) { $xn = $x.Current.Name; $anc += ("{0}:{1}" -f ($x.Current.ControlType.ProgrammaticName -replace 'ControlType.',''), (Short $xn 24)); $x = $walker.GetParent($x); $depth++ }
  "[{0}] '{1}' | id='{2}' | class='{3}' | patterns={4} | toggle={5} | help='{6}' | accKey='{7}'" -f $i, (Short $c.Name 50), $c.AutomationId, (Short $c.ClassName 40), $pats, $toggle, (Short $c.HelpText 30), $c.AccessKey
  "      ancestors: " + ($anc -join ' < ')
}
