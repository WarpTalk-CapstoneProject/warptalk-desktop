# READ-ONLY: dump the Meet tab's UIA control-view tree as JSON (for test fixtures). No invoke, no focus, no keys.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$p = Get-Process chrome | Where-Object { $_.MainWindowTitle -match '^Meet - ' } | Select-Object -First 1
if (-not $p) { "no Meet window"; exit 1 }
$doc = $A::FromHandle($p.MainWindowHandle).FindFirst($TS::Descendants, $docCond)
function Node($e, $depth) {
  $c = $e.Current
  $pats = @($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern','' })
  $kids = @()
  if ($depth -lt 40) { $ch = $walker.GetFirstChild($e); while ($ch -ne $null) { $kids += (Node $ch ($depth + 1)); $ch = $walker.GetNextSibling($ch) } }
  [ordered]@{ type = ($c.ControlType.ProgrammaticName -replace 'ControlType.',''); name = $c.Name; className = $c.ClassName; automationId = $c.AutomationId; offscreen = $c.IsOffscreen; patterns = $pats; children = $kids }
}
$tree = Node $doc 0
$json = $tree | ConvertTo-Json -Depth 60
[System.IO.File]::WriteAllText($args[0], $json, (New-Object System.Text.UTF8Encoding($false)))
"written"
