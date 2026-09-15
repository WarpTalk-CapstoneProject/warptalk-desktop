# Installs the WarpTalk bridge cables that are missing. Run elevated by resources/installer.nsh.
#
# Never throws: a machine where a cable could not be installed still gets a working WarpTalk, and
# the in-app setup wizard offers the download page. See README.md for what these are and why.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-SoundDevice([string]$pattern) {
  try {
    return @(Get-CimInstance Win32_SoundDevice -ErrorAction Stop | Where-Object { $_.Name -like $pattern }).Count -gt 0
  } catch {
    return $false
  }
}

function Install-Cable([string]$name, [string]$pattern, [string]$setup, [string[]]$arguments) {
  if (Test-SoundDevice $pattern) {
    Write-Output "$name is already installed."
    return
  }
  if (-not (Test-Path $setup)) {
    Write-Output "$name setup is not in this build; skipping."
    return
  }
  Write-Output "Installing $name..."
  try {
    Start-Process -FilePath $setup -ArgumentList $arguments -Wait -ErrorAction Stop
  } catch {
    Write-Output "$name setup failed: $($_.Exception.Message)"
  }
}

$cableSetup = if ([Environment]::Is64BitOperatingSystem) { 'VBCABLE_Setup_x64.exe' } else { 'VBCABLE_Setup.exe' }
Install-Cable 'VB-CABLE' '*VB-Audio Virtual Cable*' (Join-Path $root "vbcable\$cableSetup") @('-i', '-h')
Install-Cable 'Hi-Fi Cable' '*Hi-Fi Cable*' (Join-Path $root 'hifi\HiFiCableAsioBridgeSetup.exe') @('-h', '-i', '-H', '-n')
exit 0
