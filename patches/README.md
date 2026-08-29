# Patches

Reference patches for features that were shelved out of the main tree -
kept here instead of only in git history so they're easy to find and
reapply if someone picks the idea back up.

## mixer-snapshots.patch

The Mixer Snapshots feature (SHIFT+F1-F8 store / OPTION+F1-F8 recall a
bank window's Volume+Pan), as it stood at commit `efeeb43` - the last
attempt before the feature was shelved. See the main README's "Mixer
Snapshots" section for why: recall reliably failed to write a value to
any channel whose fader had been touched earlier in the same Bitwig
session, and every theory tried for it was individually disproven on
hardware. This patch is provided as a starting point for a *new* idea,
not something expected to work as-is.

To reapply on top of the current `MidiplusUP-MCU.control.js`:

```
git apply patches/mixer-snapshots.patch
```

If it no longer applies cleanly (the file has moved on since), use it as
a reference instead - `git show efeeb43:MidiplusUP-MCU.control.js` has
the full file as it stood with the feature included, and
`git log --oneline e1d4e2b..efeeb43` lists every commit across the whole
investigation, each with a detailed message explaining what was tried
and why it didn't work.
