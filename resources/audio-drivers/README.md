# audio-drivers

`WarpTalkMicrophone.driver` and `WarpTalkSpeaker.driver` land here when
`scripts/build-mac-audio-driver.sh` runs. They are build output and are not committed.

The folder itself is committed so the macOS `extraResources` entry always has something to copy.
A build that skipped the driver step still packages; the app then asks for upstream BlackHole
instead of installing its own devices.
