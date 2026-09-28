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

# Align Hi-Fi Cable Input and Output to the same format so the cable passes sound.
#
# Hi-Fi Cable only forwards audio when both its endpoints share the exact same sample rate AND
# bit depth. Windows ships them to different defaults — the Playback side (Input) and Recording
# side (Output) often disagree — and that mismatch silences the inbound bridge leg with no error
# the user can see. The target is 2-channel, 24-bit PCM at 48 kHz, which is the highest quality
# both endpoints support in shared mode and the rate the WarpTalk pipeline already runs at.
#
# The format is stored as a WAVEFORMATEXTENSIBLE binary blob in the Windows audio device registry.
# Writing it requires elevation, which the NSIS installer already provides — this script runs as
# administrator, so no extra UAC prompt is needed here.
#
# WAVEFORMATEXTENSIBLE layout (little-endian):
#   WAVEFORMATEX  { wFormatTag=0xFFFE nChannels=2 nSamplesPerSec=48000
#                   nAvgBytesPerSec=288000 nBlockAlign=6 wBitsPerSample=24 cbSize=22 }
#   Extension     { wValidBitsPerSample=24 dwChannelMask=0x3 SubFormat=KSDATAFORMAT_SUBTYPE_PCM }
function Set-HiFiCableFormat {
  $formatKey  = '{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0'
  $targetBlob = [byte[]]@(
    0xFE, 0xFF,             # wFormatTag:          WAVE_FORMAT_EXTENSIBLE
    0x02, 0x00,             # nChannels:           2
    0x80, 0xBB, 0x00, 0x00, # nSamplesPerSec:     48000
    0xC0, 0x6D, 0x04, 0x00, # nAvgBytesPerSec:    288000  (48000 * 3 * 2)
    0x06, 0x00,             # nBlockAlign:         6       (3 bytes * 2 channels)
    0x18, 0x00,             # wBitsPerSample:      24
    0x16, 0x00,             # cbSize:              22
    0x18, 0x00,             # wValidBitsPerSample: 24
    0x03, 0x00, 0x00, 0x00, # dwChannelMask:       FL + FR
    # SubFormat: KSDATAFORMAT_SUBTYPE_PCM
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71
  )

  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
  )
  $fixed = 0
  foreach ($root in $roots) {
    try {
      Get-ChildItem -LiteralPath $root -ErrorAction Stop | ForEach-Object {
        $propsPath = Join-Path $_.PSPath 'Properties'
        $props     = Get-ItemProperty -LiteralPath $propsPath -ErrorAction SilentlyContinue
        $isHiFi    = $props.PSObject.Properties |
                     Where-Object { $_.Value -is [string] -and $_.Value -match 'Hi-Fi Cable' }
        if ($isHiFi) {
          Set-ItemProperty -LiteralPath $propsPath -Name $formatKey -Value $targetBlob -Type Binary
          $fixed++
        }
      }
    } catch {
      Write-Output "Hi-Fi Cable format: could not read $root — $($_.Exception.Message)"
    }
  }

  if ($fixed -gt 0) {
    Write-Output "Hi-Fi Cable format set to 24-bit 48 kHz on $fixed endpoint(s)."
    # Restart the audio service so the new format takes effect without a reboot.
    try {
      Restart-Service -Name AudioSrv -Force -ErrorAction Stop
    } catch {
      Write-Output "Hi-Fi Cable format: audio service restart failed — $($_.Exception.Message)"
    }
  } else {
    Write-Output 'Hi-Fi Cable format: endpoints not found in registry; skipping.'
  }
}

Set-HiFiCableFormat
exit 0
