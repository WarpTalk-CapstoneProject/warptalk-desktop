# READ-ONLY UIA probe of a live Google Meet tab: dumps the captions region and the CC toolbar button.
# Never invokes, toggles, focuses or sends keys.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$AllCond = [System.Windows.Automation.Condition]::TrueCondition
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)

function Short($s, $n) { if (-not $s) { return "" }; $s = $s -replace "\s+", " "; if ($s.Length -gt $n) { $s.Substring(0, $n) + "..." } else { $s } }

$found = $false
foreach ($p in (Get-Process chrome, msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle })) {
  $win = $A::FromHandle($p.MainWindowHandle)
  $docs = $win.FindAll($TS::Descendants, $docCond)
  for ($d = 0; $d -lt $docs.Count; $d++) {
    $doc = $docs.Item($d)
    $url = ""
    try { $vp = $doc.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $url = $vp.Current.Value } catch {}
    $title = $p.MainWindowTitle
    if (($url -notmatch "meet\.google\.com") -and ($title -notmatch "Meet")) { continue }
    $found = $true
    "=== WINDOW: $(Short $title 60) | doc url: $(Short $url 80)"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $all = $doc.FindAll($TS::Descendants, $AllCond)
    "descendants=$($all.Count) in $($sw.ElapsedMilliseconds)ms"

    # 1) captions-like regions
    for ($i = 0; $i -lt $all.Count; $i++) {
      $e = $all.Item($i); $c = $e.Current
      if ($c.Name -match "(?i)caption|phụ đề") {
        "--- [$i] $($c.ControlType.ProgrammaticName) name='$(Short $c.Name 80)' aria=$($c.AriaRole) offscreen=$($c.IsOffscreen) class=$(Short $c.ClassName 30)"
        $toggle = ""
        try { $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $toggle = "toggle=" + $tp.Current.ToggleState } catch {}
        if ($toggle) { "      $toggle" }
        if ($c.ControlType.ProgrammaticName -match "Group|Pane|Custom|Region|Document" -or $c.AriaRole -match "region") {
          $kids = $e.FindAll($TS::Descendants, $AllCond)
          "      region descendants=$($kids.Count)"
          for ($k = 0; $k -lt [Math]::Min($kids.Count, 60); $k++) {
            $kc = $kids.Item($k).Current
            if ($kc.Name) { "      [$k] $($kc.ControlType.ProgrammaticName) | '$(Short $kc.Name 90)' | aria=$($kc.AriaRole)" }
          }
        }
      }
    }
  }
}
if (-not $found) { "No Chrome/Edge window with an active Meet tab found (only the ACTIVE tab of each window is exposed)." }
