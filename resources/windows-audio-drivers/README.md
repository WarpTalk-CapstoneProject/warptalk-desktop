# Windows bridge audio cables

The Windows installer sets up the two virtual audio cables the Google Meet bridge uses, so
downloading WarpTalk is the whole setup:

| Cable | Role | Setup, as run by `install-cables.ps1` |
| --- | --- | --- |
| VB-CABLE | carries the translated voice into the meeting (Meet mic = CABLE Output) | `vbcable/VBCABLE_Setup_x64.exe -i -h` |
| Hi-Fi Cable | carries the meeting back to WarpTalk (Meet speaker = Hi-Fi Cable Input) | `hifi/HiFiCableAsioBridgeSetup.exe -h -i -H -n` |

Both are made by VB-Audio Software (V. Burel), <https://vb-audio.com/Cable/>, and are
**donationware**: free for end users, who are welcome to support VB-Audio. They are redistributed
unmodified. VB-CABLE A+B / C+D are not included and must not be — VB-Audio does not allow those to
be bundled. Distributing to companies or institutions is a different case that needs a paid licence
from VB-Audio.

`vbcable/` and `hifi/` are filled by the release workflow (step "Fetch VB-Audio bridge cables"),
which downloads the official packs and checks their SHA-256. A local build without them still
packages; the installer then skips the cables and the in-app setup wizard links to VB-Audio.

`resources/installer.nsh` runs the script once, elevated, at the end of an interactive install.
Silent installs - which is how auto-updates run - skip it, so an update never raises a UAC prompt.
