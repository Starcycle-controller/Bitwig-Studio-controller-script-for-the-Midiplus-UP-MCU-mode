# Patches

Reference patches for features that were shelved out of the main tree -
kept here instead of only in git history so they're easy to find and
reapply if someone picks the idea back up.

## arranger-tool-cycle.patch

The arranger edit tool cycle (Pointer -> Time Selection -> Pencil ->
Spray Can -> Eraser -> Knife, one per press) that used to live on plain
DRAW (note 76), shelved when DRAW was made fully automation-centric
(plain DRAW now cycles the automation write mode, SHIFT+DRAW toggles
the write-enable arm, OPTION+DRAW shows/hides automation lanes - see
the main README's "DRAW" section). Not dropped because it's broken -
this hardware's limited clip-editing use just didn't justify keeping a
dedicated button for it right now, and the user has other MIDI
controllers this could plausibly land on instead.

Applies additively (adds `ARRANGER_TOOL_ACTIONS`/`cycleArrangerTool()`
back as their own standalone block - doesn't touch or conflict with
anything DRAW does now):

```
git apply patches/arranger-tool-cycle.patch
```

It does NOT wire `cycleArrangerTool()` up to any button on its own,
since DRAW is taken now - call it from whichever button/combo makes
sense on whichever controller this ends up on. The action ids
(`select_object_selection_tool` etc.) were confirmed via a real
`application.getActions()` dump filtered to names containing "tool"
back when this lived on DRAW; re-confirm the same way if this has been
a few major Bitwig versions since, or if reapplying on a different
Bitwig install shows anything different.

## mixer-snapshots.patch

The Mixer Snapshots feature (SHIFT+F1-F8 store / OPTION+F1-F8 recall a
bank window's Volume+Pan), as it stood at commit `efeeb43` - the last
attempt before the feature was first shelved. See the main README's
"Mixer Snapshots" section for the root cause found since (a missing
`Parameter.touch()` call) and its fix, and for why it was reintroduced -
this patch is now back in the main tree, kept here only as a rollback
point in case the current attempt needs shelving again.

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

### Follow-up lead: Bitwig's global Takeover Mode (untested to a
conclusion, approach with caution)

After shelving, a new lead surfaced: Bitwig Studio has its own global
**Takeover Mode** preference (Settings -> Controllers, separate from
this script's own Controller Preferences panel) - Pick Up (Catch) /
Jump (Immediate) / Value Scaling (Relative). Every hardware test during
the original investigation happened with it left on Pick Up; this
script's own `disableTakeOver()` call on each fader's `HardwareSlider`
is a per-control override that may not affect every code path the same
way this global preference does.

The patch was briefly reapplied (see git history around commits
`77ced51`..`2cc713d`) with Takeover Mode switched to Jump for a
retest. Result was genuinely ambiguous, not a clean confirmation or
disproof:
- The physical fader visibly moved to the recalled value, and Bitwig's
  own "modified" indicator (the dot next to the parameter) showed the
  value had changed.
- But this script's own `before`/`after` `.get()` readback, taken
  synchronously in the same tick as the `.set()` call, still reported
  the value as unchanged every time - even with delayed (50ms/500ms)
  re-checks added, and even reading `displayedValue()` (the same text
  source the LCD itself uses) instead of the raw value.
- Reintroducing the patch also triggered a **separate, serious
  regression**: the LCD's per-channel dB text stopped refreshing
  entirely after Mixer Snapshot code ran, even during completely
  unrelated fader touches with no recall ever triggered, persisting
  across a full Bitwig restart. Confirmed NOT a full script freeze -
  touches still registered, values still wrote correctly per Bitwig's
  own UI - specifically the LCD render/flush pipeline got stuck.
  Reverting the patch (back to the last known-good commit) resolved it
  immediately and confirmed the LCD keeps updating normally on the
  clean tree, so the freeze is real and tied to the reintroduced code
  (most likely the delayed diagnostic `scheduleTask` callbacks added
  during that retest) - root cause not isolated further.

Net: Takeover Mode = Jump is a real, distinct lead - not disproven the
way every other theory in the main investigation was - but it was
never cleanly confirmed either, and casually reintroducing this patch
to test it carries a real risk of the LCD freeze regression above.
Anyone revisiting this should: reapply the patch in a throwaway branch,
strip the delayed-scheduleTask diagnostic additions back out first
(they're the most likely freeze culprit and aren't needed to test the
core theory), and figure out why the physical/LCD state and this
script's own `.get()` readback disagreed before concluding anything
either way.

**Update: the live Bitwig preference was switched from Pick Up (Catch) to
Jump (Immediate)** for day-to-day use, not just a throwaway-branch retest.
This section (and API Feature Request #12) went through a full round trip
on whether that switch is Studio-wide or per-controller - see #12 in
`BITWIG-API-FEATURE-REQUESTS.md` for the whole back-and-forth. Landed on:
**Studio-wide, confirmed by checking a real Bitwig Studio 6.1 session's
Controllers panel icon by icon.** Bitwig's own documentation describes a
per-controller override icon, but it isn't reachable anywhere in the
actual 6.1 UI tested (the Midiplus UP entry's 5 icons were each clicked
and identified: settings, visualizations, an unrelated grid icon, a
color-tag, and a "scroll GUI to follow controller" crosshair - none of
them toggles Takeover Mode). So the global Settings -> Controllers ->
Takeover Mode dropdown is, in practice, the only lever available, and
switching it affects every connected controller.

Retesting this script's own behavior under the live Jump setting -
including whether the Mixer Snapshot readback/LCD-freeze symptoms above
still reproduce, or were specific to the diagnostic code removed since -
is planned but not yet done as of this note - update this section with
the result once that retest happens.
