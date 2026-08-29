# Midiplus UP - Bitwig Controller Script

**File:** `MidiplusUP-MCU.control.js`
**Hardware mode:** standard **MCU mode** (see the unit's manual, section 3.3
and section 8) - not one of the Logic/Cubase/Live "customized" modes. Only
the **top piece** of the plastic Ableton Live overlay has been removed -
the left and right pieces are still in place - so buttons under the top
piece show their real printed labels, while buttons under the left/right
pieces still show their Live-overlay labels.
**Bitwig API version:** 25 (minimum) - intended for **Bitwig Studio 6.x**;
confirmed unchanged in 6.1.
**Author:** Sternenlicht / Claude
**Credits:** based on Mossgraber's DrivenByMoss SSL UF8 script, with
additional ideas from Sternenlicht, built with Claude Code. Also shown
in Controller Preferences -> **About** category.
**Current script version string:** `3.0.0-native-faders` (shown in Bitwig's
Settings -> Controllers panel - check this after every reload to confirm
Bitwig is actually running the current file, not a stale cached copy).
**Bitwig action reference:** `bitwig-actions-reference.txt` - a complete,
human-readable dump of `application.getActionCategories()`/`getActions()`
(781 actions across 20 categories, verified complete against the dump's
own total). Check here before guessing an action id for
`safeInvokeAction()`/`application.getAction()` (like the Consolidate
F-key function needed, see Function Keys settings below) instead of a
fresh diagnostic dump.

## Status: faders fixed, button-assignment audit still open

The long-standing "motorized faders don't move" bug is **fixed** (see
below). What's left for next session is finishing the audit of button
assignments in the higher note range (74-90) now that the Live overlay's
top piece is off and the real printed labels there are different from
what the script's comments still say - see **Open Items** below.

## Architecture

### Faders (the part that was broken all last session)

Two independent halves, both required:

- **Input** (physical fader move -> Bitwig parameter): native Bitwig
  hardware-binding API. `host.createHardwareSurface()` +
  `hwSurface.createHardwareSlider(id)` + `slider.setAdjustValueMatcher(
  midiIn.createAbsolutePitchBendValueMatcher(channel))` +
  `slider.setBinding(parameter)`. See `hwFaders`/`hwMasterFader` (globals)
  and `rebindFaders()`, which re-points each of the 8 sliders at whichever
  parameter it should currently control (track volume/pan, sends, device
  macros, or a `TRLVL` gain-staging tool device - see `getFaderTarget()`)
  whenever mode/flip/bank state changes.

- **Output** (Bitwig value change -> physical motor movement): **not**
  automatic just because a slider is bound via `setBinding()` - this was
  the actual bug. Confirmed against both Ableton's own shipped
  "MackieControl" driver and Jürgen Mossgraber's open-source DrivenByMoss
  MCU driver: motor feedback requires explicitly polling each fader's
  current value and calling `sendPitchbend()` whenever it's changed. Done
  here in `updateFaderOutputs()`, called every `flush()` (Bitwig calls this
  periodically on its own), de-duplicated against `lastSentFaderValue` so
  it doesn't flood MIDI. Because `flush()` runs continuously rather than
  only on discrete button events, this covers hardware input, mouse drags,
  automation playback, and mode/bank switches alike.

**Fader-vs-group-volume bug (found, bisected, and fixed)**: reported as
"the fader moves but the volume doesn't update" - console logs proved a
value really was changing live, but on a group's first CHILD track, the
hardware fader was actually reading/writing the GROUP's own volume
instead of the child's, even though the LCD correctly showed the child's
name. First suspected as a Mixer Snapshots regression (see "Reverted /
abandoned" below) - reverting that feature entirely did NOT fix it, so
the user went back to progressively older working versions and
confirmed bidirectional fader sync was solid on the exact version right
after the original fader fix above (`a543d30`, long before Mixer
Snapshots or even the "Deactivated Tracks in Bank" feature existed).
Comparing that confirmed-good version against current directly (rather
than guessing) found the real cause: `a543d30` bound faders/encoders
straight to `trackBank.getItemAt(i).volume()`/`.pan()` - a plain bank
item, no `CursorTrack` involved. `c9bd10e` ("Add Deactivated Tracks in
Bank setting") replaced that everywhere, even in the default Show All
mode, with `mainTrackCursors[i]` - 8 persistent `CursorTrack` objects
re-pointed via `selectChannel()`, needed so Hide mode can skip
deactivated slots (something a plain `TrackBank` can't do per-slot).
That commit's own message says "not yet tested on hardware" for exactly
this path. The `CursorTrack` indirection turned out fine for reads like
`name()` (matches what the LCD showed), but apparently unreliable for
`volume()`/`pan()` specifically on a track nested inside a group.

Fixed with a new `faderTrackAt(i)` helper (used only by
`getFaderTarget()`/`getEncoderTarget()`, not the shared `activeTrackAt()`
used everywhere else) that binds straight to `trackBank.getItemAt(i)`
again whenever Hide mode isn't actually active - restoring the exact
confirmed-working pre-`c9bd10e` binding for the common case - and only
falls back to the `mainTrackCursors` indirection when Hide mode is on
(where it's structurally required, and hasn't been reported broken).
`trackBank`'s own 8 items now also get `volume()`/`pan()` `markInterested()`
directly in `init()`, matching exactly what the confirmed-working version
did before `mainTrackCursors` existed.

**First hardware retest confirmed the fader fix itself worked** (the
group child's volume updated correctly) **but crashed shortly after** -
"Either call markInterested() or add at least one observer in init in
order to access the current value", from Fader Snap to Zero's
`target.discreteValueCount().get()` against one of these `trackBank`
items. The first pass only marked `.value()` interested - enough for
basic fader motion, but missing everything else
`applyEncoderStep()`/`resolveOrigin()`/Fader Snap to Zero also call on a
fader/encoder target: `discreteValueCount()`, `discreteValueNames()`,
`getOrigin()`, `name()`, `displayedValue()`. `setupChannelStripObservers()`
already marks this full set for `mainTrackCursors`/`effectTrackBank`
items - now mirrored for `trackBank`'s own items too, matching exactly
(one `markInterested()` call per sub-accessor; there's no "interest
inherited from the parent Parameter" shortcut - each has to be marked
individually). **Confirmed working on hardware after this second fix.**

**Consistency review, requested directly**: asked whether the same bug
could affect other sections/modes, since REC ARM, SOLO, MUTE, and the
Mixer-mode encoder-push Pan Reset all read/write a track parameter
through the exact same `activeTrackAt(i)`-through-`mainTrackCursors`
pattern that was confirmed broken for volume/pan on a group-nested
track. Pan Reset (`.pan().reset()`) is essentially the identical
operation to the fader bug, just triggered by a button press instead of
physical fader movement - very likely to have the same issue. REC
ARM/SOLO/MUTE (`.arm()`/`.solo()`/`.mute()`, all `SettableBooleanValue`
rather than `Parameter`) share the identical cursor mechanism but were
never separately hardware-confirmed broken - given a wrong-track
SOLO/MUTE/ARM on a group is a worse silent mistake than a fader glitch,
all four were switched to the same `directTrackAt(i)` helper
proactively (renamed from `faderTrackAt()` now that it covers more than
faders) rather than waiting for each to be reported separately.
`trackBank`'s own items also got `arm()`/`solo()`/`mute()`
`markInterested()` in `init()`, alongside the existing volume()/pan()
set.

Left unchanged, lower risk/lower stakes: SELECT (notes 24-31, including
its double-press group-fold check), fader-touch select-on-touch, bank-
scroll's own track selection, and the per-channel track-color LED/LCD
output - all still go through `activeTrackAt()`. Selection-related ones
(`selectInMixer()`/`selectInEditor()`/`cursorTrack.selectChannel()`,
`isGroup()`/`isGroupExpanded()`) got extensive hardware testing earlier
this session (see "Bank scrolling selects a track" below) with no
reported misdirection issue, and track color is cosmetic only (wrong
color, not a wrong control) - both worth keeping an eye on, but not
proactively changed without evidence they're actually affected.

**First hardware test of this pass showed faders not responding to
input at all - reverted.** Turned out to be a false alarm: the real
cause (see the startup race condition immediately below) was an
unrelated, pre-existing bug that happened to be triggered by whatever
Hide-mode state was active during that specific test, not by this
change. Re-applied once the actual race condition was found and fixed -
**confirmed correct on hardware**: REC ARM, SOLO, MUTE, and encoder-push
Pan Reset all now act on the intended track (tested on both a group's
child track and a plain ungrouped track), not the enclosing group.

**Second bug found, unrelated to the group/CursorTrack issue above -
a genuine startup race condition**: reported as "faders don't move
Bitwig's level" being inconsistent between reloads - worked if
"Deactivated Tracks in Bank" (Hide mode) was off at startup, or toggled
on manually mid-session, but never worked if Hide mode was *already* the
persisted setting when the script started. Root cause: `activeTrackRawIndices`
(which Hide mode needs to know which slots have a track) is only
populated by a background scan that first completes ~100ms after `init()`
returns (`mainMappingTick()`'s scheduled task). But when Hide mode is
already the persisted Controller Preferences value at startup, its
`addValueObserver()` fires immediately during `init()` registration -
standard Bitwig behavior - calling `rebindFaders()` while
`activeTrackRawIndices` is still empty. Every slot looks like "no track"
(`isMainSlotEmpty()`), so all 8 fader bindings get cleared via
`hwFaders[i].clearBindings()`. `recomputeActiveTrackIndices()` (the
function that finally populates the list for real, ~100ms later) only
ever called `refreshMainCursors()` afterward - it never called
`rebindFaders()` again, so the faders stayed cleared indefinitely, with
nothing left to ever re-bind them. Fixed by also calling
`refreshDisplayText()`/`rebindFaders()` from `recomputeActiveTrackIndices()`
whenever Hide mode is active and currently in Mixer mode - matches
exactly what the Controller Preferences setting's own observer already
does when toggled live. **Confirmed fixed on hardware** - faders now
work immediately on restart even with Hide mode already enabled from a
previous session.

**Third bug found in the same area, smaller**: with Hide mode active,
hiding a track correctly shifts the remaining tracks up/down and the
fader/motor immediately follows the newly-shifted-in track's real
value - but the LCD text (name + level) kept showing the *previous*
occupant's stale text until the channel was manually clicked/selected.
Cause: `refreshMainCursors()` re-points `mainTrackCursors[i]` via
`selectChannel()`, but the newly-selected track's `name()`/
`displayedValue()` aren't reliably available to a synchronous `.get()`
in the very same tick - the immediate `refreshDisplayText()` call added
by the previous fix could read the old track's still-cached data before
Bitwig had actually delivered the new one. The fader/motor output
doesn't have this problem since it re-polls continuously via `flush()`
rather than reading once; `refreshDisplayText()` is exactly that kind of
one-shot read. Fixed with a short delayed follow-up call (75ms,
debounce-token-guarded so hiding/showing several tracks in quick
succession doesn't pile up stale scheduled calls) that re-reads the text
once Bitwig has actually caught up. **Not yet re-tested on hardware
since this fix.**

### Modes (`currentMode`)

- `MODE_MIXER` (default) - faders/encoders control track volume/pan (or a
  `TRLVL` tool device's Gain/Pan, if `isToolVolumeMode` is active - see PAN
  button, note 42).
- `MODE_SENDS` - faders/encoders control the focused track's sends.
  Toggle via the SEND button (note 41): sends 1-8 -> sends 9-16 -> back to
  Mixer by default, or sends 1-8 -> back to Mixer directly if
  **Send/Return Bank Size** (Mixer settings below) is set to `8` - see
  there. SHIFT+SEND always jumps straight to sends 9-16 regardless of
  that setting.
- `MODE_DEVICE` - encoders **always** control the selected device's 8
  remote control macros, regardless of FLIP. Faders control track volume
  by default and swap to the macros when FLIP is on (press again to
  revert to volume) - i.e. FLIP only affects the faders in this mode, not
  the encoders. Entered via PLUG-INS (note 44 - see the button-map
  correction below), or via F1-F8 in their default/orange state (notes
  54-61), which also jump directly to device 1-8 on the chain and open
  that device's own plugin window. Requested directly: pressing the SAME
  F-key again for the device that's *already* selected toggles that
  window closed (and open again on a further press) instead of
  reselecting it - `cursorDevice.position().get()` is checked live
  against the pressed key's index, so this stays correct even if the
  selection changed some other way in the meantime (the mouse in Bitwig
  itself, PLUG-INS, wheel-stepping), not just "whichever F-key was
  pressed last". Pressing a *different* F-key still selects that device
  and opens its window as before.
- `MODE_SCENE` - entered via the button printed B.T.A. on the old Live
  overlay (note 79, not 80 - see the button-map correction below): shows
  the clip launcher, switches Bitwig to the Mix panel layout, and the jog
  wheel selects/launches scenes instead of its usual transport scrub.

FLIP (note 43, not 50 - see the button-map correction below) swaps faders
and encoders between volume and pan in `MODE_MIXER`, and faders (only -
see `MODE_DEVICE` above) between volume and macros in `MODE_DEVICE`.

Every button that changes `currentMode` (or the `isToolVolumeMode`/
`isViewingReturns`/`sendBankPage` state that acts like a sub-mode of it) -
TRACK/IO, SEND, PAN, PLUG-INS, RETURNS, F1-F8, the CTRL "expanded view"
shortcut, and B.T.A./Scene mode - fully resolves the new state first
(resetting `sendBankPage`/`isToolVolumeMode` on entry) and then calls
`applyModeChange()` exactly once, which re-syncs the mode LEDs, LCD text,
channel-strip LEDs, and fader/encoder bindings together as a single unit.
This replaced a bunch of hand-rolled per-button sequences that didn't
always agree with each other - e.g. pressing RETURNS while already in
Sends mode used to update `isViewingReturns` and the channel-strip LEDs
immediately but skip `rebindFaders()` (it was gated on "only if already
in Mixer mode"), leaving the faders bound to the old target - a real
input/output desync, not just a cosmetic LED glitch, for as long as you
stayed in that mode. Jumping directly between any two modes (Sends ->
Returns, Plugin -> Sends, etc.) now always lands in one fully-consistent
state instead of layering the new mode on top of leftover old state.

Closing a `MODE_DEVICE` plugin window on the way out is `applyModeChange()`'s
job too now, not each button's own - via `previousMode` (tracks
`currentMode` as of the last call to `applyModeChange()`; the function
closes the window whenever `previousMode` was `MODE_DEVICE` and the new
`currentMode` isn't). Every mode-changing button used to carry its own
`if (currentMode === MODE_DEVICE) { cursorDevice.isWindowOpen().set(false);
}` check by hand, duplicated six times (TRACK/IO, SEND, PAN, RETURNS,
B.T.A., PLUG-INS) right before reassigning `currentMode` - reported as not
reliably closing the window on every path, the same class of bug
`applyModeChange()` was originally created to eliminate for
`rebindFaders()`. Centralizing it removes any chance of a future
mode-changing button forgetting the check, since leaving `MODE_DEVICE`
now closes the window automatically no matter which button caused the
transition.

### Plugin Mode settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Plugin Mode** category. All 4 modifier buttons (SHIFT/OPTION/CTRL/ALT,
notes 70-73) are still always-available held modifiers for their existing
combos (fine adjust, jog-wheel loop shift/scale, tempo nudge, device
navigation, etc, regardless of these settings) - these settings only
control each button's *standalone tap* action, i.e. what happens if you
press and release one without using it to modify anything else:

- **Expanded Device View Button** (CTRL / ALT / OPTION / SHIFT / None,
  default **None** - was CTRL, changed per direct feedback) - which
  button's tap toggles `cursorDevice.isExpanded()`. Reported as confusing
  on CTRL specifically: CTRL is the most ergonomic modifier and already
  heavily used for jog-wheel combos, so a long-press mode-switch/window-
  open living on the same button could fire unintentionally while just
  trying to use CTRL+wheel, and F1-F8 (direct device select + open
  window) already covers the same need without that risk. Off by
  default now; still fully available by picking any modifier here.
- **Expanded Device View Trigger** (Long Press / Instant Tap, default Long
  Press) - whether that tap needs to be held for the duration below, or
  fires immediately on release.
- **Long Press Duration (Expanded Device View)** (200-2000ms, default
  500ms) - only relevant when Trigger is Long Press.
- **Expanded Device View Also Opens Plugin Window** (on/off, default ON) -
  when on, the tap also opens/closes the plugin window in lockstep with
  the expanded-view state, and switches into `MODE_DEVICE` if needed (a
  one-press shortcut into the expanded view from any mode - selects the
  first device if none was selected yet, same as PLUG-INS). Press again
  to collapse the view and close the window. When off, the tap only
  toggles the expanded-view flag and never touches the window, and only
  does anything while already in `MODE_DEVICE` (original behavior).
- **Macro Bank Cycle Button** (ALT / CTRL / OPTION / SHIFT / None, default
  ALT) - which button's tap calls `remoteControls.selectNextPage()`. If
  set to the same button as Expanded Device View, that button's tap always
  triggers Expanded Device View, never the macro cycle.
- **Close Other Plugin Windows** (on/off, default OFF) - when on, opening
  a device's plugin window (via PLUG-INS, F1-F8 direct select, EQ Mode, or
  the Expanded Device View action) first closes every *other* device's
  window on the current track's chain, for an "only one plugin window open
  at a time" workflow. Scoped to the current track's 8-slot device chain
  (`cursorDeviceBank`) - there's no Controller API way to enumerate open
  plugin windows project-wide, so windows on other tracks aren't affected,
  and a device past slot 8 (only reachable via EQ Mode's deeper search,
  see below) won't have its window closed by this either.
- **EQ Device Name Keywords** (text, default `eq,pro-q`) - see **EQ Mode**
  below.

**EQ Mode** (SHIFT+PLUG-INS, note 44) - requested directly: jump straight
to whichever EQ is **last** in the selected track's chain (several
different EQs might be stacked - a corrective one early, a tonal one
late - "last in chain" is deliberately the one picked, not "first
match"), for a quick peek-modify-leave workflow. **Unlike F1-F8** (notes
54-61), which toggles the already-selected device's window,
SHIFT+PLUG-INS pressed again while that same EQ is already selected
exits straight back to Mixer mode instead (same as PLUG-INS' own
toggle) - closing the window is then just a side effect of leaving
`MODE_DEVICE` (the existing plugin-window-auto-close behavior), not
something this handles itself. A third press jumps straight back to the
same EQ, same as the first - so the whole gesture is a clean two-state
toggle: SHIFT+PLUG-INS to peek at the EQ and adjust it, SHIFT+PLUG-INS
again to leave.

Bitwig has no usable device-category metadata for this -
`Device.deviceType()` only distinguishes `AUDIO_FX`/`INSTRUMENT`/
`NOTE_FX`, not "EQ" vs. any other audio effect - and third-party plugin
names vary by vendor, so this uses the same name-keyword-matching
approach as **Auto-Detect Centered Macros by Name** above:
`findLastEqDeviceIndex()` scans a dedicated, deeper `eqDeviceBank` (32
devices into the chain, `EQ_DEVICE_SCAN_DEPTH`) and matches each
device's name against the comma-separated **EQ Device Name Keywords**
list (default `eq,pro-q`).

Matching is **leading-boundary only** (`\bkeyword`, not the full
`\bkeyword\b` the Bipolar Macro Name Keywords case uses) - deliberately,
because of a real naming collision: `eq` needs a leading boundary so it
doesn't accidentally match mid-word (e.g. "Sequence", "Note Sequencer" -
neither should count as an EQ), but a *trailing* boundary would break on
the version-suffix-with-no-space naming plugins commonly use ("EQ-2",
"Pro-Q4" - the `q` butts straight up against a digit, so `\bpro-q\b`
would not match "Pro-Q4" the same way `\btune\b` correctly excludes
"Detune"). `eq` alone (leading-boundary) already covers Bitwig's own
built-in EQ+/EQ-2/EQ-5 and any "Equalizer"-named device; `pro-q` covers
FabFilter Pro-Q 3/4 by name specifically, since - as directly reported -
that's the EQ actually in daily use, and it wouldn't match a bare `eq`
keyword at all (the letters "e" and "q" aren't even adjacent in
"Pro-Q"). Verified with a standalone test before shipping: `EQ+`/`EQ-2`/
`EQ-5`/`Equalizer`/`FabFilter Pro-Q 3`/`Pro-Q4`/`Pro-Q 4` all match;
`Sequence`/`Note Sequencer`/`Compressor`/`Waves API 550` correctly don't.
Add your own keywords (comma-separated) for any other EQ that doesn't
happen to match either default.

If no device in the chain matches, shows "EQ Mode: No EQ Found in Chain"
and does nothing else. Not yet tested on hardware.

### Function Keys settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Function Keys** category. F1-F8's green-lit state (notes 62-69,
toggled by SMPTE/BEATS - see note 53; the orange/default state, 54-61,
still directly selects device 1-8 and isn't affected by this) is
configurable per-key via 8 dropdowns, **F1 Function (Green State)**
through **F8 Function (Green State)**, each offering the same list -
`None`, plus every key of `FKEY_FUNCTIONS` in the code (currently 40
entries: `Duplicate`/`Cut`/`Copy`/`Paste`/`Delete`/`Rename`/`Select All`/
`Select None`/`Undo`/`Redo`/`Consolidate`, all 22 of Bitwig's own
**Editing** category actions, all 11 of its **File** category actions,
`Select item at cursor` from its **Selection** category, `Click button`
from its **General** category (a keyboard-focus click - activates
whatever UI element currently has focus, not a mouse-position click), and
`Add Cue Marker at Playhead`/`Toggle Follow Playhead` (moved here off
notes 82/83 once those turned out to be printed "PAGE (left/right
arrow)" under the Ableton overlay and got repurposed to page device
macro banks instead - see the button map above and note 82/83's code
comments) - see `bitwig-actions-reference.txt` for the full names).
Defaults: F1 =
`Duplicate`, F2 = `Consolidate`, F3-F8 = `None`.

Every press shows the pressed key's action name as a Bitwig on-screen
popup (`host.showPopupNotification`, the full name, same as the orange
state's `Device N` popup) plus a brief LCD popup of just that one key's
own abbreviated name on its own channel strip - a lightweight "here's
what I just did" confirmation, same as any other one-shot LCD popup, not
a big learning overlay on every single tap.

Only an actual **hold** past **F-Key Hold Threshold (ms)** (Function Keys
category, default 400, range 100-2000) escalates to something bigger: the
LCD reveals **all 8 F-keys' assignments at once**, not just the one held -
each channel strip's bottom row shows what *that* channel's F-key is
currently mapped to (`showAllFKeyAssignments()`), so holding down any
single F-key doubles as a "what could I press" reference for the whole
row. Requested specifically so holding a button reveals to the user what
they could possibly do with the others, without having to constantly
reference the manual - while a normal quick press still just confirms the
one action it actually performed, same as before. Unassigned keys
(`None`) show `-`, so it's clear they're deliberately empty rather than
not yet revealed.

`handleFKeyPress()`/`handleFKeyRelease()` implement the split: press
invokes the assigned function and shows the brief single-key popup
immediately (unconditionally - it doesn't yet know whether this press
will turn into a hold), then arms a `host.scheduleTask()` check after
**F-Key Hold Threshold (ms)**; if the button is *still* held when that
check fires, it escalates to `showAllFKeyAssignments()` (which then
displays with **no** auto-revert timeout, unlike the tap-sized popup - see
`showBottomRowPopupWhileHeld()`), and release only needs to revert all 8
rows (`revertAllFKeyAssignments()`) if that escalation actually happened;
otherwise the tap's own popup already scheduled its own ordinary revert
and there's nothing further to do. A per-key generation token (same
debounce pattern used everywhere else in this file) cancels the pending
hold-check the moment the button is released early, so a normal tap never
triggers the full reveal even for an instant. This needed intercepting
notes 62-69 directly in `onMidi` (both press *and* release) instead of
leaving them to `handleButtonPress()`'s switch like the orange state
(54-61) still does, since that switch only ever sees presses. If two
F-keys were ever held past the threshold at once (unlikely with one hand
on this hardware), releasing one reverts all 8 rows, including the
still-held key's own channel - which would immediately re-populate
correctly on the next tick anyway, so not worth extra bookkeeping to
prevent.

The LCD is still only 7 characters per cell, and the real action names
are often much longer - plain left-truncation collided for several of
them (`Select All`/`Select None`/`Select item at cursor` all truncated to
the identical `Select `; the three `Toggle...` entries all truncated to
`Toggle `), which would defeat the point of a name you can actually read.
`FKEY_SHORT_NAMES` hand-picks a distinct <=7-character abbreviation (e.g.
`SelAll`/`SelNone`/`SelCurs`, `TglMute`/`TglHold`/`TglOnOf`) for every
entry that needs one, used for both the tap popup and the hold reveal;
the on-screen Bitwig popup always shows the real full name regardless,
since that one isn't width-constrained.

**F-Key Popup Duration After Release (ms)** (Function Keys category,
default 300, range 0-2000) - once the hold reveal has actually kicked in, it doesn't
necessarily vanish the instant the button is released: `revertBottomRowPopup()`
(called per-channel by `revertAllFKeyAssignments()`) keeps it up this
much longer past release before reverting, same debounce-generation-token
pattern used everywhere else in this file (a fresh press before the
linger elapses cancels the pending revert, same as re-pressing during any
other timed popup). Only pads out the *minimum* - a long hold already
gets however long it was actually held, unaffected by this setting; a
plain tap's own brief popup is unaffected too, since it never escalates
to the hold reveal at all. Set to 0 to revert the instant the button is
released, no linger at all.

Ten entries (`Duplicate` through `Redo`) call a dedicated, typed
`Application` method (`application.duplicate()`, `.cut()`, `.remove()`
for Delete, etc.) - guaranteed correct, not guessed, straight from the
Controller API Javadoc. Everything else (`Consolidate` and all 33 Editing/
File actions) has no dedicated method anywhere in the Controller API, so
it goes through `safeInvokeAction(actionId, null)` (the same generic
`application.getAction(id).invoke()` helper DRAW's tool-cycling uses for
its own real, confirmed action ids - see `ARRANGER_TOOL_ACTIONS`) with
every `actionId` copied verbatim from `bitwig-actions-reference.txt`, not
guessed - unlike Consolidate's first attempt (`"consolidate_time_selection"`,
a wrong snake_case guess before the real id, the plain word
`"Consolidate"`, was console-confirmed - see git history). **Not yet
tested on hardware** for the 33 newly-added actions - if any of them
don't fire, check the console for a `safeInvokeAction`
"unavailable"/error log naming the id that failed.

Worth noting before assigning it: `Quit` is in the list because it's a
real Bitwig action and was explicitly requested, but binding it to an
F-key means one wrong press quits Bitwig outright - no confirmation
dialog stands in the way from a script-invoked action.

The request was for each dropdown to remove an already-picked function
from the other 7 (so you can't double-assign one), but **Bitwig's
`getEnumSetting()` dropdowns have no API to change their option list at
runtime** - confirmed against the Javadoc, `SettableEnumValue` only has
`set(value)`, nothing to reduce the choices. All 8 dropdowns therefore
independently offer the full list; `warnIfDuplicateFKeyFunctions()` is
the closest available substitute - it re-scans all 8 whenever one
changes and, if two keys end up with the same function, prints a console
warning and shows a Bitwig popup naming which two keys collided. It
doesn't prevent the duplicate, just flags it immediately instead of
leaving it to be discovered by a key silently doing nothing.

**SHIFT+CTRL Wheel Action** and **ALT+CTRL Wheel Action** (also in the
Function Keys category, since they're configurable-action settings even
though they drive the jog wheel rather than an F-key) pick what each of
those two combos does - see the full writeup under Jog wheel modifier
combos below. Both dropdowns offer the same 5 options: `Scale Clip Size`,
`Duplicate/Delete Clip`, `Duplicate Clip` (**SHIFT+CTRL's default**),
`Duplicate/Delete Track` (**ALT+CTRL's default**), or `Duplicate Track`.
Freely invertible - set either dropdown to either action, e.g. swap so
SHIFT+CTRL duplicates the track and ALT+CTRL scales the clip instead.

The two plain `Duplicate Clip`/`Duplicate Track` options (as opposed to
their `Duplicate/Delete` counterparts) turn left into an **unconditional,
always-on no-op** - never gated by the delete kill switch below, since
the whole point is a self-contained safe choice that doesn't depend on
also remembering to turn that separate setting off. Default changed to
`Duplicate Clip` for **SHIFT+CTRL Wheel Action** specifically (was `Scale
Clip Size`), per direct request for a safer out-of-the-box default that
doesn't rely on the user separately configuring delete-denial too.

**Wheel Combos: Allow Delete (Turn Left)** (on/off, default ON) - shared
by both combos above, only relevant when either is set to a
`Duplicate/Delete` option (**not** the plain `Duplicate Clip`/`Duplicate
Track` options, which never delete regardless of this setting). On,
turning left deletes the selection (clip or track, the original
behavior). Off, turning left in that mode is a no-op and only turning
right (duplicate) does anything - the safer choice if a slightly-wrong
turn deleting something outright is too risky; flagged as a "could be
shaky" concern when requested. Picking one of the plain `Duplicate`
options directly is the more self-contained way to get that same safety
without depending on this toggle too.

### Seeking while playing

Every playhead jump in this script (default jog wheel scrub, HOME/END,
Mixer Mode PAGE) goes through a shared `setTransportPosition(beats)`
helper rather than calling `transport.getPosition().set()` directly.
Reported: jog-wheel scrub did nothing while the transport was playing,
even though it worked fine while stopped - meanwhile the dedicated
REWIND/FAST FORWARD buttons (which call `transport.rewind()`/
`.fastForward()`, a different API path) kept working during playback.
Root cause: `transport.getPosition()` is the *live* playback position,
continuously re-driven by the audio engine every processing cycle while
playing, so a script-side `.set()` on it races against that engine
update and gets stomped almost immediately - the jump technically
happens but is overwritten before it's ever visible or audible.
`setTransportPosition()` instead sets `transport.playStartPosition()`
(Bitwig's own "play-start" marker, not continuously re-driven, and kept
in sync with the current position while stopped) and, only while
`transport.isPlaying()`, additionally calls
`transport.jumpToPlayStartPosition()` to force the actual jump - the
same workaround used by the well-tested DrivenByMoss controller
framework for this identical issue. Applies to every position-jump
feature in the script, not just the jog wheel - not yet confirmed on
hardware.

### Flush workaround (ported from DrivenByMoss)

Reviewed the [DrivenByMoss](https://github.com/git-moss/DrivenByMoss)
controller framework's Bitwig-specific code (`ModelImpl.java`,
`TransportImpl.java`, `ArrangerImpl.java`, and its actual MCU protocol
implementation) for any other Bitwig Controller API quirks it works
around that this script doesn't yet handle, since it just took several
rounds to track down the `getPosition()`-while-playing issue above.

Found one applicable, currently-unhandled one: `ModelImpl.flushWorkaround()`
documents that since Bitwig 3.1, `flush()` (the callback that pushes
hardware-bound output state - faders, LED rings, colors, etc. - out to
the wire) is only invoked when a subscribed value actually changes
("intended, not a bug"). While the transport is stopped and otherwise
idle, if nothing happens to change, `flush()` might not run at all -
which could leave any hardware output that depends on this script's own
internal state (rather than directly mirroring an observed Bitwig value)
stale until something unrelated triggers the next flush. DrivenByMoss
works around it with a periodic forced flush; ported the same fix here
as `flushWorkaroundTick()` - calls `host.requestFlush()` once every
100ms while `transport.isPlaying()` is false (skipped while playing,
since enough flushes already happen naturally then - the playhead
position alone keeps changing every cycle). Not confirmed this was
actually causing a visible symptom on this hardware, but it's the exact
same defensive fix a mature, widely-used controller framework carries
for every one of its supported controllers, so it's included
preventively.

Everything else found while reviewing (a clip-launcher-grid-scroll
workaround in `SlotBankImpl`/`TrackImpl`, a note-clip-type crash
workaround in `CursorClipImpl`, a hardware-API value-routing shim in
`RangedValueImpl`) is specific to session-view clip launching, note clip
content, or DrivenByMoss's own internal hardware-abstraction layer - none
of which this script touches, so nothing else applied.

### SHIFT+HOME: auto-named cue markers

Note 89 (the button printed HOME under the Ableton overlay) normally
jumps the playhead to the project start. **SHIFT+HOME instead adds a cue
marker at the current playhead position, automatically named "Bar N"**
for whatever bar it's actually placed at - requested directly, for
quickly dropping named markers while working through a song without
reaching for the mouse or typing a name. This is a distinct feature from
the generic `Add Cue Marker at Playhead` F-key function (see Function
Keys above) - that one just inserts a marker with Bitwig's own default
name; this one both places AND names it in one press. No Controller
Preferences setting for this one - nothing about it seemed like it
needed to be configurable.

The bar number comes from the same `positionFormatter`
(`host.createBeatTimeFormatter(":", 3, 2, 2, 3)`) already used for the
segment display (`updateSegmentDisplay()`) - `transport.getPosition().
getFormatted(positionFormatter)` yields e.g. `"003:02:03:045"`
(Bars:Beats:Subdivision:Ticks), and the bar number is just its first
field, parsed with `parseInt()`.

Bitwig's Transport only exposes a bare `addCueMarkerAtPlaybackPosition()`
- no "add and return the new marker" or "add with this name" call - so
there's no direct way to name the marker at creation time. Instead,
`findAndRenamePendingCueMarker()` scans a dedicated 128-marker-deep
`cueMarkerBank` (`CUE_MARKER_SCAN_DEPTH`) for whichever marker's position
matches the playhead position captured right before the marker was
added, and renames that one. Since the new marker isn't guaranteed to be
visible in the bank within the same tick it was requested, the search
runs from a short `host.scheduleTask()` delay (`CUE_MARKER_RENAME_DELAY_MS`,
150ms) after creating it, rather than immediately - **not yet confirmed
on hardware whether this delay is long enough, or even necessary at
all**; if a real project shows markers not getting renamed reliably
(check the console for `"couldn't find the marker just created"`), raise
`CUE_MARKER_RENAME_DELAY_MS` in the code.

### Zoom settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Zoom** category.

**Cursor arrow note mapping correction**: an earlier round assumed the
printed labels matched notes 96/97 = LEFT/RIGHT and 98/99 = UP/DOWN.
Testing on real hardware showed the opposite: **96/97 are actually
UP/DOWN, and 98/99 are actually LEFT/RIGHT**. All four `case` handlers in
`onMidi()` were swapped to match - see the button map above for the
corrected mapping.

**ZOOM+LEFT/RIGHT** (notes 98/99 while ZOOM/note 100 is toggled) -
reported as unsatisfying: it previously fired `zoomToFit()`/
`zoomToSelection()` (two mismatched canned actions, not an actual
continuous zoom) as a workaround, after confirming on hardware that
`application.zoomIn()`/`zoomOut()` fire without error but never actually
change the arranger's horizontal zoom. Now uses a genuine relative
zoom instead: `Arranger` turns out to extend `TimelineEditor`, whose
`getHorizontalScrollbarModel()` exposes the real horizontal (timeline)
zoom as a `ScrollbarModel` (API version 21+, well within this script's
targeted 25) - `getContentPerPixel()` is a readable `DoubleValue` (zoom
level, content units per pixel - smaller means more zoomed in), and
`zoomAtPosition(position, distance)` adjusts it relatively, in powers of
2 (`distance = +1` doubles content-per-pixel = zoomed **out**, `-1`
halves it = zoomed **in**), centered on a given position. No absolute
"set to exactly this zoom level" call exists, but the relative adjuster
is enough for arrow-key zoom in/out. LEFT zooms out (`distance =
+ZOOM_ARROW_STEP`), RIGHT zooms in (`distance = -ZOOM_ARROW_STEP`) -
centered on the current playhead position (the only always-available
reference point; `ScrollbarModel` has no "current view center" query) -
an arbitrary but easily-reversible direction choice.

**ZOOM+Left/Right: Zoom Step (2^n per Press)** (default `1`, range
0.25-4) - how big a jump each press makes. `1` is a full double/halve per
press (matching the same exponential-step convention `OPTION+Wheel:
Ticks to Halve/Double Loop Length` already uses for the loop); lower for
finer per-press control (e.g. `0.5`), higher for coarser jumps.

**ZOOM+UP/DOWN** (notes 96/97 while ZOOM is toggled) is unchanged from
before this round - `arranger.zoomInLaneHeightsSelected()`/
`zoomOutLaneHeightsSelected()`, adjusting vertical track height rather
than horizontal zoom. Not reported as a problem, so left alone; only the
LEFT/RIGHT (horizontal) side was replaced.

Not yet confirmed on hardware.

### Encoders settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Encoders** category. Applies to every one of the 8 rotary encoders
(CC 16-23), whatever they currently control - track pan/volume in Mixer
mode, device macros in Device mode, or sends - via a single shared
handler, `applyEncoderStep()`.

**Is a macro a knob or a switch?** Answering a question raised alongside
this feature: yes, the Controller API can tell. Every `RangedValue`
(which `Parameter`/`RemoteControl`/`Send` all extend - covering pan,
volume, device macros, and sends alike) exposes `discreteValueCount()` -
the real number of discrete steps Bitwig itself knows the parameter has,
or `-1` for a genuinely continuous one - plus `discreteValueNames()`, the
actual label for each of those steps. `applyEncoderStep()` checks this
for whatever the encoder is currently pointed at: if it's a real
discrete/switch parameter, turning it always steps through its own native
states one at a time and pops up the resulting state's real name (e.g.
`On`/`Off`, or whatever the device itself calls that step) - regardless
of every other setting below, since there's no meaningful "fine" or
"stepped-by-percent" adjustment of something that only has 2 (or a
handful of) real states to begin with. This needed `discreteValueCount()`/
`discreteValueNames()` marked interested up front for every possible
encoder target (main + returns track pan/volume, the 8 remote-control
macro parameters, all 16 sends, and every scanned `TRLVL` tool-device
candidate) - added alongside each one's existing `markInterested()` calls
in `setupChannelStripObservers()`/`init()`/`scanTrackForToolDevice()`.

**`discreteValueCount()` is capped at 16 for "this counts as a switch"**
(`MAX_NATIVE_SWITCH_STEPS`). Confirmed on hardware: a macro reporting a
real but much finer native resolution (roughly 50 steps, i.e. 2% each)
also took the always-native-step branch above, and always jumped a full
native step (2%) per turn no matter what **Encoder Step Size** was
configured to (1% in the report) - "can't select value 1, it always
jumps to +2 or -2". Two separate resolutions were being conflated here:
this hardware's own MIDI wire protocol (the encoders send relative,
sign-magnitude ticks - 1-63 increment, 65-127 decrement - which is about
how a *turn* is reported, not how finely any given *parameter* can be
set) and Bitwig's own reported native resolution for that specific macro
(`discreteValueCount()`, entirely independent of the MIDI side). A
parameter with only a handful of real states (an on/off switch, a short
mode list) genuinely IS best served by native single-step-per-turn
behavior; a knob-shaped macro that merely happens to be internally
quantized to ~50 steps is not the same thing and shouldn't be treated
identically. Above the cap, `discreteCount` now falls through to the
Stepped/Fine handling below instead, so the configured step size and
acceleration are respected - Bitwig may still snap the result to its own
nearest valid native value if the requested one doesn't land on it
exactly, but at least the setting drives the intent rather than being
silently overridden by an unrelated device's native grid. A console
message (`"Encoder target has discreteValueCount() N (> 16) - treated as
continuous, native grid ignored"`) logs the real count whenever this
matters, to help confirm/recalibrate the cap against further hardware
findings if some other macro still doesn't land where expected.

For a genuinely continuous target (pan, volume, a continuous macro, a
send level), a **plain** turn always stays today's existing smooth
behavior, unchanged - only **SHIFT+turn**'s behavior is selectable, via
**SHIFT+Encoder Mode**:

- `Stepped` (**default**) - jumps in fixed **Encoder Step Size (%)**
  increments (default 10%, range 1-50%), landing exactly on round
  multiples - e.g. pan moves in clearly audible, evenly-spaced jumps
  rather than a smooth sweep, easier to judge by ear than tiny continuous
  nudges. Directly inspired by how electronic instrument hardware often
  prefers stepped encoder behavior for exactly that reason - broader,
  more clearly-audible jumps are easier to judge than minimal continuous
  increases.
- `Fine` - SHIFT's older role instead: precise, 0.2x-scaled continuous
  adjustment. Pick this if SHIFT should stay a precision override rather
  than become the stepping gesture.

**Encoder Acceleration (%)** (default 0 = off, range 0-100) - a
continuous dial, not fixed presets, so it can be tuned to the user's own
dexterity. Maps to an exponent from 1.0 (0%, no curve at all - matches
the raw hardware behavior exactly) to 2.0 (100%, strongest).

Applied to a **time-based velocity ratio**, not the raw per-message tick
count alone - inspired by a paper on encoder velocity/acceleration
estimation (Merry et al., IFAC 2008, "time stamping" concept): the same
raw tick count can arrive 5ms after the last message (a fast flick) or
200ms after it (a slow, deliberate turn whose ticks just happened to
batch into one message), and those shouldn't accelerate the same amount.
`computeEncoderVelocityRatio()` captures a `Date.now()` timestamp per
encoder every time a CC 16-23 message arrives (`lastEncoderTickTime`) and
computes ticks-per-second from the gap to the previous one, relative to
an estimated baseline (`ENCODER_VELOCITY_BASELINE_TICKS_PER_SEC`, not yet
hardware-calibrated) - turning at or below that baseline rate leaves the
ratio at 1 (no boost) regardless of the curve setting, so a careful turn
always feels identical; only a turn faster than baseline gets boosted
further. **Purely event-driven** - this only runs inside the same
`onMidi()` call a message would be processed by anyway, using a
timestamp already captured at that moment; no timer, no polling loop, no
added background cost of any kind.

**0% is a real, supported "no acceleration" option**, not just a low
setting - the curve is skipped entirely rather than approximated, so it's
bit-for-bit identical to the pre-acceleration behavior (and the timing
history is still tracked even while off, so turning it on mid-session has
a warm history immediately rather than a cold first read).

Only scales the regular **Fine/plain continuous** adjustment (`.inc()`) -
deliberately **not** Stepped mode's jumps, which always move exactly one
**Encoder Step Size (%)** increment per message regardless of this
setting. Stepping in fixed percentage jumps is already its own, much
coarser form of "acceleration" over a fine continuous nudge; compounding
the acceleration curve on top of that (letting a fast turn jump several
steps at once) would accelerate an already-accelerated gesture.

**Allow Stepped Encoders While Recording Automation** (default OFF) -
Stepped mode (SHIFT+Encoder Mode) falls back to Fine while Arranger
Automation Write is enabled (`transport.isArrangerAutomationWriteEnabled()`
in `applyEncoderStep()`), since recording abrupt stepped jumps into
automation is usually not what's wanted - flagged as an inconsistency
worth calling out explicitly rather than silently hardcoding, since
someone might genuinely want hard, quantized automation steps recorded
on purpose. Turning this on lets Stepped mode keep working even while
Automation Write is enabled.

**Auto-Detect Centered Macros by Name** (on/off, default ON) +
**Centered Macro Keywords** (text, default `pan,tune,fine,ftun,offset`)
- `getOrigin()` turns out to only be reliably `0.5` for parameters Bitwig
itself classifies internally as pan-like; a genuinely bipolar (centered)
plugin parameter that Bitwig merely wraps generically - confirmed on
hardware with Serum 2's oscillator Fine Tune macros - reports `0`
instead, even though its real "no detune" center sits at `0.5`.
Diagnostic logging added during the Finer Resolution Near Center
investigation below caught it directly: the macro's value hovered around
`0.50` on every logged tick while `getOrigin()` reported a flat `0.0000`
the entire time, so both Finer Resolution Near Center and Encoder Snap
to Origin were silently checking distance to the wrong point and never
activating anywhere near the actual center being aimed for.

The first fix (treating ANY reported origin of `0` as `0.5`,
unconditionally) was flagged as too broad: only a handful of controls on
an instrument like Serum 2 are actually bipolar/centered (fine tune,
oscillator pan) - most of a device's other macros with origin `0` are
genuinely, correctly zero-based. Checked the Controller API for a more
precise signal to key off instead of a blanket override:
`RemoteControl`/`Parameter` (both extend `RangedValue`) expose only
`name()`, `discreteValueCount()`/`discreteValueNames()`, `getOrigin()`,
and `displayedValue()` - no unit, type, or "is bipolar" flag anywhere in
the API. `name()` is the only stable enough signal to use.
`nameSuggestsBipolar()` matches the macro's own name (as mapped/labeled
on the Remote Controls page - either the plugin's own reported parameter
name, or a custom label if you've renamed the slot yourself, both work
identically) against the comma-separated **Centered Macro Keywords**
list. `resolveOrigin()` (shared by both features) only applies the `0.5`
override when the origin is `0` **and** the name matches - so a
zero-origin macro that isn't named anything bipolar keeps its
correctly-reported `0`, while a fine-tune or oscillator-pan macro gets
treated as centered. Can't make Pan or a correctly-reported bipolar
parameter any worse either way, since both already alias to `0.5`
regardless of this setting.

A bare `tun` (an earlier default) was flagged as still too unspecific.
Rather than guess a replacement, checked the actual manuals for five
target instruments - Serum 2, u-he Hive, Diva, Zebra 2/3, and Repro - for
their real pitch-tuning control names:

- **Serum**: pitch-section labels are literally **"Fine"**/**"Coarse"**
  (not "Tune" at all - confirmed straight from the official manual), plus
  **"Noise Fine"** and mod-matrix entries like "A Pan".
- **Diva**: the fine-tune automation parameter is abbreviated **"FTun"**
  (range -24..+24, confirmed bipolar).
- **Hive**: u-he's own documentation describes "separate parameters...
  for octave, semi and **fine tune**" (that literal phrase).
- **Zebra 3**: has a standalone bipolar **"Tune"** (+/-48 semitones,
  oscillator pitch offset) as well as its own **"Fine Tune"**.
- **Repro**: Repro-1 has a **"Fine Tuning"** trimmer (+/-20 cents),
  Repro-5 has **"OSC B Fine Tune"**.
- **Zebra 2/3 and others**: also turned up plain **"Detune"** - a genuine
  trap, not a name to blindly add. In Single oscillator mode it's a
  bipolar per-oscillator fine-tune (±50 cents); in Dual/Quad/Eleven mode
  the *exact same parameter name* becomes a unison voice-spread amount (0
  = tight, max = wide - not centered at all, correctly zero-origin
  already). The same ambiguity applies to Serum's own "Unison Detune" and
  Hive/Repro-5's "Detune"/"Voice Detune" knobs.

Reintroducing plain `tune` (to catch Zebra 3's standalone "Tune") would
normally reopen the exact "tun" problem, since a raw substring can't tell
"Tune" apart from "Detune" - `tune` is a substring of both. Fixed
properly instead of dodged: `nameSuggestsBipolar()` now does a
**word-boundary** match (`\bkeyword\b`, pre-compiled into
`bipolarNameRegexes` by `rebuildBipolarNameRegexes()` rather than
rebuilt every tick) instead of a raw substring. "tune" as a whole word
matches "Tune" and "Fine Tune" (both have "Tune" as its own word) but
does **not** match "Detune" (no word boundary before "tune" there) - so
`tune` is safe to include without reopening the Detune trap, and the
2-word `fine tune` keyword from an earlier round becomes redundant
(already covered by `tune` + `fine` individually) and is dropped from the
default. Word-boundary matching also means `detune` is now a clean,
independent, deliberate opt-in if you ever want it - add it to your own
keyword list only if you know it's safe for how you actually use it, and
it won't accidentally arrive as a side effect of wanting `tune`.

Default `pan,tune,fine,ftun,offset` covers all five instruments' real
control names precisely without touching unison/spread-style "Detune"
controls. Add your own plugin's naming conventions (comma-separated) if a
bipolar control there doesn't happen to match any of these.

**How Bitwig gets a macro's name in the first place**: whatever string
the plugin itself reports through its native parameter API (VST3's
`ParameterInfo::title`, or the equivalent in CLAP/AU) - there's no
standardization across vendors, it's entirely up to each plugin. If
you've renamed a Remote Controls page slot yourself (typed a custom
label), that custom text is what gets matched instead - so your own
naming conventions work here too, not just each plugin's originals.

**Encoder Snap to Origin** - encoders have no physical detent, so landing
exactly on a parameter's own "home" value by turning alone is fiddly.
Originally just "Pan Snap to Center" (Mixer-mode pan only, hardcoded to
0.5) - generalized after confirming Bitwig's Controller API exposes the
REAL origin of any `RangedValue` via `getOrigin()`, not just pan's: 0.5
for a bipolar/centered parameter (pan, or e.g. an oscillator fine-tune
macro - turn right to pitch up, left to pitch down, centered means no
detune), 0 for a plain level. Once the encoder comes to **rest** (no
further tick for **Encoder Snap Idle Delay (ms)**, default 300, shared
across contexts - a hardware turn-debounce timing, not a "where to snap"
choice) within its context's snap range, it snaps the rest of the way
there (`target.set(resolveOrigin(target))`) instead of leaving it at
whatever the last increment produced. Applies to whatever the encoder
currently targets in **any** mode - Mixer pan/volume, Device/Plugin
macros, Sends - not just Mixer-mode pan; skipped only for a genuine
discrete/switch target (see `applyEncoderStep()`), which has no
continuous "close to origin" to land on. Doesn't replace the existing
Mixer-mode encoder-push pan reset (notes 32-39 - "Pan only - centers the
pan, nothing else", see **Encoder Push Behavior** below for Device mode's
own version of this gesture) - that's still there as an exact,
always-available reset; this just makes turning the encoder itself land
on the origin more often, without needing the separate push.

**Enable and range are configured independently for two contexts**, after
feedback that a single shared toggle/range made Device mode and Mixer mode
interfere with each other - dialing in the range for how a macro's
fine-tune behaves in Device mode also silently changed how pan snapped in
Mixer mode, with no way to tune one without affecting the other:

- **Encoder Snap to Origin (Device/Plugin Mode)** (on/off, default ON) +
  **Encoder Snap Range - Device/Plugin Mode (+/- %)** (default 2%, range
  0-10%) - governs Device mode's 8 macro knobs only.
- **Encoder Snap to Origin (Mixer Mode)** (on/off, default ON) + **Encoder
  Snap Range - Mixer Mode (+/- %)** (default 2%, range 0-10%) - governs
  everything else the encoders can target: Mixer-mode pan/volume and
  Sends. `isDeviceModeContext()` (`currentMode === MODE_DEVICE`) is the
  only thing that decides which pair applies - Sends is bundled with
  Mixer rather than broken out further since it's only ever reached via
  Mixer-mode navigation.

Turn a context's range down to 0% to disable snapping there without
touching its own on/off toggle, or use the toggle directly.

Went through two earlier designs that both failed on hardware before
landing on the idle-based one above (back when this was still pan-only):

1. **Per-tick, checked after every turn.** Snapped as soon as *any*
   tick's resulting value fell inside the range, with no regard for
   where the pan was a moment before. Once pan sat at/near center, every
   following tick's own tiny increment (normally smaller than even a 1%
   range) *also* landed inside the zone and got yanked straight back to
   exactly 0.5 - the pan became permanently trapped at center, unable to
   move in either direction no matter how much the encoder was turned
   (reported as "pan does not move in any direction now").
2. **Per-tick, but only on crossing into the zone from outside it**
   (i.e. only snapping when the value was beyond the range before that
   specific tick and inside it after). This fixed the trapping, but then
   usually didn't snap at all on real hardware: the MCU protocol batches
   several physical clicks into a single MIDI message's step count, so
   an ordinary-speed turn typically jumps clean across the whole zone in
   one message and its value is never actually observed sitting inside
   it mid-turn - there's no tick to catch the crossing on.

Both problems share the same root cause: reacting to *every individual
tick* mid-turn, whether by value or by transition, is the wrong signal -
what actually matters is where the value ends up once you stop turning.
`scheduleEncoderSnapCheck()` re-arms a `host.scheduleTask()` check on
every tick (bumping a per-encoder generation token, same debounce
pattern `revealPanTemporarily()` uses for the bottom-row LCD reveal, so
only the LAST scheduled check for a turn ever actually runs) and only
evaluates the resting value once nothing has moved that encoder for
**Encoder Snap Idle Delay (ms)** - sidestepping both the trapping and the
overshoot-past-the-zone problem, since it no longer matters how big or
small each individual MIDI message's step was. Pan specifically was
confirmed working on hardware under the idle-based design before this
round's generalization to `getOrigin()`; the generalized (any mode, any
target) version is not yet re-tested.

None of this is yet tested on hardware, except where individually noted
above.

**Finer Resolution Near Center** (on/off, default ON) - reported live
from hardware: with 8 macro knobs mapped to Serum 2 in bank 1 and
oscillator fine-tune macros (osc1/osc2/osc3/noise) in bank 2, turning
slowly to land back on exact center was nearly impossible - "it jumps
between +1 and -1". The cause: even the plain turn's finest resolution
(128) still moves in steps of roughly 0.8% of the full range per tick,
which on a narrow, origin-centered macro like fine-tune is already
coarser than the "close to center" window a careful hand is aiming for -
so every tick either overshoots past 0 or undershoots back away from it,
with nothing in between. `isNearOrigin()` checks, on every tick, whether
the target's *current* value sits within **Finer Resolution Range (+/-
%)** (default 5%, range 0.5-20%) of its real `getOrigin()`; when it does,
the resolution argument passed to `target.inc()` in
`applyEncoderStep()`'s two continuous (Fine-mode) branches is multiplied
by **Finer Resolution Multiplier** (default 4x, range 2-16x) - a higher
resolution value means a *smaller* step per tick (`inc(delta,
resolution)` moves `delta/resolution` of the full range), so ticks taken
near center land far more precisely than ticks further out, without
changing anything about how the encoder behaves once back out in the
normal range. Stacks independently with SHIFT's own resolution bump (512
vs. the plain turn's 128) - near-origin SHIFT ticks get sharpened too.
Skipped for the same two cases **Encoder Snap to Origin** skips: a
genuine discrete/switch target (no "near origin" concept for an enum, and
that branch returns before reaching this code anyway) and Stepped mode
(which already lands exactly on the origin whenever the configured
**Encoder Step Size (%)** divides evenly into it, e.g. 10% steps hit
50%/origin=0.5 exactly, so there's nothing to sharpen). Works well
together with **Encoder Snap to Origin** above - this feature makes it
possible to carefully creep toward center by hand, and the idle-based
snap still cleans up the last fraction of a percent once the encoder
comes to rest nearby.

First hardware round after shipping this: reported as still just as
jumpy, with zero observable change from raising **Finer Resolution
Range** 5% -> 10% or **Finer Resolution Multiplier** 4x -> 16x - a strong
signal the near-origin branch wasn't running at all, not that it was
under-tuned. Diagnostic logging confirmed it: for these exact fine-tune
macros, `target.get()` sat around `0.50` while `target.getOrigin()`
reported a flat `0.0000` throughout, so `isNearOrigin()` was comparing
distance to the wrong point and staying `false` the whole time no matter
how wide the range or how high the multiplier went - see **Auto-Detect
Centered Macros by Name** above (now on by default) for the fix.

**Encoder Push Behavior (Device/Plugin Mode)** (`Fine Resolution` /
`Reset to Default` / `Open/Close Plugin Window`, default `Fine
Resolution`) + **Encoder Push Fine Resolution Multiplier** (default 8x,
range 2-32x) - requested directly: in Mixer mode, pressing an encoder
resets pan to center immediately ("more useful there", per direct
feedback - see **Encoder Snap to Origin** above, unaffected by this
setting and not configurable). In Device mode, the exact same physical
gesture - pushing an encoder's own click - now has three mutually
exclusive choices instead, only ever one active at a time:

- **`Fine Resolution`** (the preferred default) - press and *hold* an
  encoder down while turning it, and the resolution passed to
  `target.inc()` is scaled by **Encoder Push Fine Resolution Multiplier**
  (default 8x - so an encoder normally moving in ~0.8% steps per tick
  moves in ~0.1% steps instead) for exactly as long as it's held, on top
  of whatever Finer Resolution Near Center/SHIFT would otherwise apply. A quick
  tap that never actually turns the encoder does nothing (no reset) -
  that's deliberately the "Reset to Default" choice's job, not blended
  into this one. Takes priority over SHIFT if somehow both are held at
  once (a more specific, single-encoder gesture) rather than combining
  the two scalings.
- **`Reset to Default`** - keeps the classic single-press-to-reset
  behavior (`remoteControls.getParameter(index).reset()`, the same call
  Mixer mode's own encoder push already uses) for anyone who'd rather
  Device mode match Mixer mode's gesture for consistency, instead of
  gaining the fine-turn gesture.
- **`Open/Close Plugin Window`** - pressing any of the 8 encoders toggles
  `cursorDevice.isWindowOpen()` (the same object `applyModeChange()`
  already closes automatically on leaving Device mode, described near the
  top of this document) instead of touching the macro at all - a quick
  way to pop the plugin's own GUI open or closed without the mouse. It's
  a device-wide toggle, so which of the 8 encoders you press doesn't
  matter.

Implemented via a dedicated press/release interception for notes 32-39 in
Device mode (same pattern as Fader Touch/F-Keys - intercepted before the
standard press-only dispatch so both directions are available), separate
from Mixer/Sends' own note 32-39 handling, which is untouched and still
fires immediately on press exactly as before.

### Mixer settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Mixer** category. (Pan's own snap-to-center behavior lives under
**Encoder Snap to Origin** in the Encoders settings above now, alongside
the other encoder-turn behaviors it was generalized to work with.)

**Send/Return Bank Size** (`8` or `16`, default `16`) - how many sends a
normal SEND-button (note 41) press cycles through before exiting back to
Mixer: `16` is the older 3-state cycle (Sends 1-8 -> Sends 9-16 -> Mixer),
`8` toggles straight between Sends 1-8 and Mixer (one press in, one press
out) - less paging for anyone who rarely touches more than 8 sends per
track. Only changes the button's own paging logic (`sendBankConfiguredPages`)
- the underlying send bank itself is always created at the full 16
(`MAX_SENDS`, unchanged), so this takes effect live with no reload
needed, and doesn't cap what's actually reachable: **SHIFT+SEND** always
jumps straight to Sends 9-16 from anywhere regardless of this setting, so
choosing `8` for less everyday paging doesn't lock anyone out of the rest
when they actually need them.

**Mixer Mode PAGE: Loop Behavior** (`Keep Loop Length` / `Loop Between
Markers`, default `Keep Loop Length` - matches normal workflow, per
direct feedback) - requested directly: PAGE
left/right (notes 82/83) already page the device macro bank in Device
mode; in **Mixer mode** the same two buttons now jump the playhead to
the previous/next cue marker **and** move the arranger loop to follow
it, for quickly hopping between song sections and looping just the one
currently being worked on.

- **`Loop Between Markers`** - the loop is set to span from the target
  marker to the very next one chronologically (regardless of which
  direction PAGE was pressed - looping "this section" always means
  target-to-next, not target-to-wherever-you-came-from). If the target
  is the **last** marker in the timeline, there's nothing to loop up to
  by definition - Bitwig's Controller API has no direct query for "end
  of arrangement content" (no way to scan every track's longest clip),
  only the `jump_to_end_of_arrangement` **action**, which moves the
  playhead as a side effect. `jumpToMarkerAndSetLoop()` invokes that
  action, reads the resulting position back after a short
  `host.scheduleTask()` delay (150ms, `CUE_MARKER_RENAME_DELAY_MS` -
  shared with SHIFT+HOME's cue marker naming above, same "not
  guaranteed to be reflected in the same tick" reasoning), and only
  *then* moves the playhead to the actual target marker - landing at the
  end of the arrangement was never the point, only measuring it was.
  **Not yet confirmed on hardware.**
- **`Keep Loop Length`** - instead of following markers at all, the loop
  just relocates to start at the target marker, keeping whatever length
  it already had (e.g. a 4-bar loop stays 4 bars, just moves).

Implemented via `findAdjacentMarkerPosition()`, which scans
`cueMarkerBank` directly for the closest marker before/after the
playhead (same bank SHIFT+HOME's naming feature uses) rather than
`transport.jumpToNext/PreviousCueMarker()` - scanning first means the
target position is already known synchronously, with no read-after-jump
timing concern in the common case (only the end-of-arrangement fallback
above needs one).

### Deactivated Tracks in Bank

Reported: a track deactivated and hidden in Bitwig itself (used for
backup/experimental tracks kept around but not wanted in the way) still
showed up in the 8-channel bank here. Investigated whether a hidden
track's state could be read directly - confirmed there's no
`isVisible()`/`isHidden()` anywhere in the Controller API at all (checked
every type in it), so there's no way to detect Bitwig's own Arranger/
Mixer "eye icon" hide state from a controller script. `Channel.isActivated()`
*is* readable, so that's the property this filters on instead - matches
the reported case (deactivated-and-hidden backup tracks) even though it
isn't literally the same flag.

**Deactivated Tracks in Bank** (`Show All (Dim Name)` / `Hide (Skip and
Shift)`, Mixer category, default `Show All (Dim Name)`) - Main tracks
only; Returns/effect tracks are unaffected either way (not requested, and
much lower-risk to leave on Bitwig's plain fixed-window bank).

- **`Show All (Dim Name)`** - matches how
  [DrivenByMoss](https://github.com/git-moss/DrivenByMoss) (the most
  mature open-source Bitwig controller framework, supporting dozens of
  controllers) handles this itself - checked its code specifically
  before building anything here, and confirmed `isActivated()` is only
  ever used there to dim a channel strip in place (e.g. its Push driver
  passes it straight into the display call as a dim flag), never to
  filter a bank; there's no existing precedent anywhere in it for
  actually removing a deactivated track from view. This hardware's LCD is
  monochrome text-only, so "dim" here means the deactivated track's name
  and volume text go blank in its slot - the fader, pan, arm/solo/mute
  and its real LEDs all keep working normally if you do touch it, since
  Bitwig itself still allows editing a deactivated track's settings.
- **`Hide (Skip and Shift)`** - fully excludes deactivated tracks from
  the bank; the next activated track shifts up to fill the gap, same as
  Bitwig's own hide behavior looks in the Arranger/Mixer. No precedent
  for this anywhere (see above) - it needed a from-scratch design, since
  a plain `TrackBank` always maps physical slot *i* to a fixed,
  contiguous position in the underlying track list; there's no way to
  make slot 3 skip ahead to the next activated track while slots 1-2
  stay exactly where they are using a bank object alone. The only way to
  get that per-slot independence is 8 separate `CursorTrack` objects
  (`mainTrackCursors`), each manually pointed at an arbitrary real track
  via `selectChannel(track)` - confirmed this API call exists and does
  exactly that ("Points the cursor to the given channel") - instead of
  the plain bank's own `getItemAt(i)`. A large (128-track), permanently
  unscrolled background bank (`mainTrackScanBank`) continuously scans
  `exists()`/`isActivated()`/`name()` across every track in the project -
  not just the 8 currently visible - building `activeTrackRawIndices`,
  the ordered list of activated tracks; `mainBankScrollOffset` is this
  mode's own logical scroll position into that list (replacing the plain
  bank's native scroll methods, which don't apply once the "bank" is a
  filtered array rather than a contiguous window), and the 8 cursors are
  re-pointed to match on every scroll and every recompute
  (`refreshMainCursors()`). Every part of the script that used to read a
  Main track via `trackBank.getItemAt(i)` now reads through
  `mainTrackCursors[i]` instead (via `activeTrackAt(i)`), transparently
  covering either mode - channel strip display/LEDs, fader/encoder
  bindings, VU meters, track colors, and the Tool Volume Mode gain/pan
  helper-device tracking all "just work" without needing separate logic
  per mode, since a cursor keeps firing its already-registered observers
  correctly no matter what real track it's re-pointed at. Fewer than 8
  activated tracks in the whole project leaves trailing slots genuinely
  empty (blank LCD text, LEDs off, fader/encoder unbound, black channel
  color) rather than falling back to Bitwig's usual "off the end of the
  list" defaults - and every button (Rec Arm/Solo/Mute/Select/Pan Reset/
  fader-touch-select) is a no-op on one of those empty slots, so an empty
  -looking channel strip can't accidentally act on some other,
  off-screen deactivated track behind the scenes. **Not yet tested on
  hardware** - this is a substantially bigger, from-scratch piece of
  script architecture than most other features here, so expect to need a
  round of real-world testing/iteration.

Bug found and fixed right after shipping this (Show All mode, the
default): expanding/collapsing a group track didn't reveal its children
on the hardware. Root cause - `mainTrackCursors` only get re-pointed at
`trackBank.getItemAt(i)` at explicit trigger points (scroll, RETURNS
toggle, the mode toggle itself, init), unlike the plain
`bank.getItemAt(i)` pattern used everywhere before this feature, which
auto-updates no matter *why* a different track lands at that slot.
Expanding a group reflows the whole flat list (children appear/disappear
inline) without the user triggering any of those explicit refresh points,
so the cursors just stayed stale. Fixed with a `name()` observer on each
of `trackBank`'s own 8 slots (Show All mode only - Hide mode already
self-heals via `mainTrackScanBank`'s own name-change tracking) that
calls `refreshMainCursors()` whenever a different real track lands at
that slot for any reason, not just an explicit scroll.

### Bank scrolling selects a track, so Bitwig's view follows

Reported: moving the bank on the hardware (BANK PREV/NEXT, CHANNEL
PREV/NEXT, and their SHIFT jump-to-first/last variants) didn't make
Bitwig's own Arranger/Mixer follow along, so the two could show
completely different tracks. Every one of the 6 scroll helpers
(`scrollActiveBankToStart/ToEnd/PageBackward/PageForward/
StepBackward/StepForward`) now selects a track in the new window right
after moving it - the same two calls the SELECT button (notes 24-31)
already made (`track.selectInMixer()` plus the real
`cursorTrack.selectChannel(track)` - `cursorTrack` was created with
`shouldFollowSelection=true`, so this genuinely changes Bitwig's own
track selection, not just a local flag). Bitwig scrolls its own view to
keep a newly selected track visible, the same as clicking it would, so
the two views now stay in sync on every bank move.

**Which slot gets selected depends on scroll direction**, per direct
feedback: scrolling left/backward (`ToStart`/`PageBackward`/
`StepBackward`) selects a configurable slot near the window's left side
(`selectFirstTrackOfBank()`); scrolling right/forward (`ToEnd`/
`PageForward`/`StepForward`) selects one near its right side
(`selectLastTrackOfBank()`) - selecting a track in the direction just
scrolled *toward* keeps Bitwig's view following the newly-revealed
tracks, rather than always snapping back to the window's left edge
regardless of which way it just moved.

**Bank Scroll Left: Select Track #** / **Bank Scroll Right: Select Track
#** (Mixer category, range 1-8, default `1`/`8` - the original
hardcoded first-slot/last-slot behavior) - requested directly: always
jumping to the window's extreme edge (track 1 or track 8) can feel
jarring in Bitwig's own view; a slot nearer the center (e.g. `3` on the
left, `6` on the right) might land Bitwig's scrolled-into-view result
somewhere less abrupt. Exposed as a setting rather than a fixed redesign
specifically to experiment with different values on hardware. Both
`selectFirstTrackOfBank()`/`selectLastTrackOfBank()` funnel through
`selectBankSlotNear(index)`, which scans backward from the configured
slot toward slot 0 if that exact one turns out empty (Hide mode can
leave fewer than 8 activated tracks in the window - empty slots only
ever trail towards slot 7 there, never lead, so backward/toward-0 is the
correct search direction for either the left or the right setting; Show
All mode and Returns never hit the empty-slot case at all). Guarded by
`isMainSlotEmpty()` for the one case where there's genuinely nothing to
select at all (Hide mode, zero activated tracks left in the whole
project). Applies to both Main and Returns; the RETURNS toggle itself
and the Hide/Show mode toggle are unchanged (not requested, and less
clearly "moving the bank" the same way scrolling is).

**Blink Armed Track's SELECT LED** (on/off, default ON) - the SELECT LEDs
(notes 24-31) normally just show which track is currently selected
(solid on/off). With this on, any channel whose track is armed for
recording blinks its SELECT LED instead - **regardless of whether it's
also the selected track** - so the SELECT row doubles as an
always-visible "which tracks are armed" overview, not just current
selection. A track that's both selected and armed shows the blink (arm
state takes priority over the plain selection indicator there); the
`nameForTrackColor()` popup on selection - see the button map above -
still fires normally either way, so selection itself is never ambiguous.
**Confirmed working on hardware.** Originally requested after noticing
the hardware's own RECORD-button overlay (a separate, apparently
local-firmware-only behavior recoloring the SELECT row on the physical
unit, unrelated to this and not something the script can see or control)
doesn't show anything until you actually press RECORD - this gives a
persistent version driven entirely by the script.

A 4-step bright -> dim -> off -> dim "breathing" version was tried next,
using velocity 1 for "dim" - real and documented on this hardware, but
for a DIFFERENT button function (the UP/UP+ manual's Pro Tools
AUTO/INSERT section: "these buttons will illuminate dimmed Blue"/"dimmed
Orange"). **Confirmed on hardware NOT to work for the SELECT LEDs** - no
dim step was visible cycling through at all. Likely explanation: this
row may have its own local record-arm LED behavior in firmware (matching
the light-red/dark-red SELECT-row recoloring already observed when
physically pressing RECORD) that overrides or ignores a plain velocity-1
Note-On rather than treating it as a genuine dim state, unlike the
AUTO/INSERT buttons. Reverted to the simpler, already-confirmed-working
2-state flash rather than keep guessing at velocity values with no fast
hardware feedback loop.

`selectLedVelocityFor()` computes the correct velocity for both the
resync path (`refreshChannelStripLEDs()`, used after mode/RETURNS
changes) and each per-track observer's own direct-send path
(`track.arm()`, `addIsSelectedInMixerObserver`), so all three stay in
agreement. `armedLedBlinkTick()` is a self-rescheduling
`host.scheduleTask()` loop (started once in `init()`, same pattern as
`displayFlushTask()`) that advances one shared `armedLedBlinkPhase` step
index (through `ARMED_LED_BLINK_VELOCITIES`, now just `[127, 0]`) and
re-sends the SELECT LED for every currently-armed channel on the active
bank - every armed channel blinks in sync rather than drifting
independently. Turning the setting off immediately restores every SELECT
LED to its plain `isSelected` state via `refreshChannelStripLEDs()`,
rather than leaving a channel stuck showing whatever step it was on.

**Armed SELECT LED Blink Rate (ms)** (default 1000, range 100-2000) - the
duration of each of the 2 steps, not the full cycle - so the default is
a full on/off cycle of 2 seconds (2x 1000ms). Lower for a faster blink,
higher for slower. Confirmed on hardware that the original 400ms
half-period (800ms full cycle) felt too fast; 1000ms per step is the
adjusted default.

**Select Channel on Fader Touch** (on/off, default ON) - touching one of
the motorized faders (notes 104-111 for channels 1-8, note 112 for the
master fader - a separate Note-On/Off the hardware sends independent of
the pitch-bend position data, previously logged only, see the button map
above) selects that channel's track, the same `selectInMixer()`/
`cursorTrack.selectChannel()` call the SELECT1-8 buttons already use.
Named and modeled directly after the identically-named setting in
Mossgraber's DrivenByMoss MCU driver (see its manual's Mackie MCU
"Workflow" preferences). The 8 channel faders only select while in
`MODE_MIXER` - in `MODE_SENDS`/`MODE_DEVICE` all 8 faders act on the same
cursor track's sends or on device macros rather than one distinct track
per fader, so there's no per-channel track to select there; the master
fader always selects the master track regardless of mode, since its
binding never changes with mode (see `hwMasterFader` in `init()`).

**Select Channel on Fader Touch Delay (ms)** (default 0 = select
immediately, range 0-1000) - requested alongside the toggle above with
riding multiple faders together in mind: grabbing several faders in quick
succession touches each one a few milliseconds apart, and selecting
immediately on every touch would make the selected track (and anything
that follows it, like the device panel) flicker through each channel
during the grab instead of settling on one. `scheduleSelectChannelOnTouch()`
implements the delay as one shared, gesture-wide debounce (not
per-fader) - every touch on *any* of the 9 faders bumps a single
generation token and (re)arms a `host.scheduleTask()` check after the
delay; only the touch that's still the most recent one once the delay
elapses without a further touch actually fires the selection. At the
default of 0 it selects synchronously with no debounce at all, identical
to the immediate behavior described above.

**Held-fader focus lock** - first tested on hardware, the delay setting
alone wasn't enough: holding a single fader steady still kept reselecting
a *different* channel, which the delay can't fix since it only debounces
a fast burst of genuinely-intended touches, not a stray touch arriving
for a fader that isn't actually being held (whether that stray touch is a
deliberate second hand, or a touch-sense quirk on this particular unit -
not established which, but the fix works regardless of the cause).
Fixed via `isFaderTouchLocked()`: whichever fader touches down *first*
holds the channel-selection focus - any other fader's touch is ignored
for selection purposes (logged to the console, `"Fader touch ignored for
selection - ..."`, to help tell a genuine multi-touch apart from a
hardware artifact) until the held one is released, however many other
touch messages arrive in the meantime. **Confirmed working on hardware**
- fader-driven channel selection "feels better now", and the delay
setting ("pickup sensitivity") stays as-is alongside it.

**Fader Snap to Zero** (on/off, default ON) - requested directly, the
motorized-fader counterpart to **Encoder Snap to Origin** above: landing a
fader exactly on true `-inf` ("true volume zero") by hand is just as
fiddly as landing an encoder on its origin, for the same reason (no
detent - you can get close, but not exact). When on, **releasing** a
fader that's currently sitting within **Fader Snap to Zero Range (%)**
(default 3%, range 0-10%) of the bottom arms a check
`scheduleFaderSnapZeroCheck()` runs **Fader Snap to Zero Delay (ms)**
later (default 500ms, range 100-3000ms); if the fader is **still
untouched** at that point (re-touching it during the delay cancels the
pending check, and the check itself re-verifies `faderTouchHeld` even if
it does fire) and still within range, it snaps the rest of the way down
to exactly `0`.

Deliberately **release-triggered**, not checked continuously while the
fader is moving, unlike the encoder version: a motorized fader's position
during a drag is exactly wherever the hand physically put it, so there's
nothing to correct until the hand actually lets go - an encoder, by
contrast, has no absolute position of its own and can only be nudged
relative to wherever it last landed, which is what made an idle-based
check necessary there. "Only if it's not currently controlled" is
enforced twice: once by only ever arming the check on touch-*release* in
the first place, and again by the check itself bailing out if
`faderTouchHeld` for that fader has gone back to `true` by the time the
delay elapses.

Applies to whatever the fader is **currently bound to** - Volume in
Mixer mode, Send level in Sends mode, or (under FLIP) Pan/device macros -
the same generalization **Encoder Snap to Origin** uses, via
`getFaderSnapZeroTarget()` (identical to `getFaderTarget()`, plus the
master fader, which `getFaderTarget()` itself doesn't cover since it's
always bound straight to `masterTrack.volume()` regardless of mode).
Skipped for a genuine discrete/switch target, which has no continuous
"close to the bottom" to land on. Not yet tested on hardware.

### Debug settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Debug** category. Requested directly: this script had several
`println()` calls sprinkled through it for verifying key presses/wheel
behavior/modifier state while developing against real hardware, each
either always-on or manually commented out - no single place to see or
control all of them. Centralized into `debugLog(category, message)` (see
the `DEBUG_*` globals near the top of the script) instead, with one
setting per category:

- **Enable Debug Logging** (default ON) - the master switch. Off silences
  every category below regardless of its own setting, and also
  `hide()`s their individual checkboxes from this panel via Bitwig's own
  `Setting.hide()`/`show()` API - turning this off collapses the whole
  section down to just itself, previewing what fully retiring debug
  logging later (once the project is more mature and end users shouldn't
  see any of this) would look like.
- **Log Raw MIDI (Controller Input)** (default ON) - every incoming CC not
  otherwise handled, and every Note-On (the main "what does this physical
  button/wheel actually send" tool, e.g. the note-87/101 jog-wheel-click
  mixup earlier in this doc was found this way).
- **Log Button Dispatch** (default ON) - "Button pressed - Note: N", once
  a Note-On has passed modifier filtering and actually reached
  `handleButtonPress()` - lets "the hardware sent something" (raw MIDI,
  above) be told apart from "the script recognized and dispatched it".
- **Log Modifier State (SHIFT/OPTION/CTRL/ALT) in Raw MIDI** (default ON)
  - whether the raw Note-On line above also appends the live
  `[SHIFT=... OPTION=... CTRL=... ALT=... ZOOM=... SCRUB=...]` state
  suffix - its own toggle since that's the noisiest part of an already
  noisy line, only really needed when chasing a modifier-dependent bug.
- **Log LCD Display SysEx** (default ON) - the exact text sent to each
  half of the two-row MCU LCD via `sendMCUSysex()`, so a display
  formatting bug can be read straight from the console instead of
  eyeballing tiny hardware LCD characters. New this session - there was
  no LCD-specific debug logging before.
- **Log Encoder Target Classification** (default ON) - reports a
  pointed-at parameter's real `discreteValueCount()` whenever it exceeds
  `MAX_NATIVE_SWITCH_STEPS` and gets treated as continuous instead of
  stepped - for calibrating that constant against real hardware/device
  values.
- **Channel 8 Meter Test Mode** (default `LED + LCD (default, mode 3)`) -
  moved here from its own former "Diagnostics" category, per request, for
  consistency - it's a live hardware-experimentation control like
  everything else in this hub, so it belongs alongside it. Live-switches
  which of the 4 real MCU VU-meter modes channel 8's strip uses, by
  re-sending `F0 00 00 66 14 20 07 <mode> F7` with a different mode byte
  the moment you change the dropdown - no reload needed. The 4 values are
  confirmed against Mossgraber's `switchVuMode()`/`VUMODE_*` in
  `MCUControlSurface.java` (not guessed): `0` = all off, `1` = LED meter
  only, `3` = LED + VU-meter on the LCD (what all 8 channels normally use,
  see below), `6` = VU-meter on the LCD only, no LED. Scoped to channel 8
  only - the other 7 strips stay on the confirmed-working mode 3
  regardless of this setting. **Result so far: on this hardware, the
  on-screen LCD bar reacted to real level in every one of the 4 modes,
  including `0`/off** - so this unit doesn't appear to distinguish
  between the mode byte values the way genuine Mackie hardware does; the
  LCD meter bar seems to always be driven directly by the incoming
  Channel Pressure level data regardless of the mode SysEx. Didn't reveal
  anything new yet, but left in as a live knob in case there's still more
  to get out of the LCD worth revisiting later, rather than concluding
  this hardware categorically can't do anything more with it. Conclusion
  below.

Real error/warning logging (caught exceptions, invalid action ids,
duplicate F-key assignments, a cue marker that couldn't be found to
rename, etc.) is deliberately **not** gated by any of this - those always
print, so a genuine problem can never be accidentally silenced by a
debug setting. Not yet tested on hardware (the `hide()`/`show()` toggle
behavior especially).

### LCD / meters / LEDs

Standard MCU SysEx: `F0 00 00 66 14 12 <offset> <ASCII...> F7` for the two
56-character text rows (`renderLCDDisplays()`), `F0 00 00 66 14 20 <strip>
<mode> F7` (mode=3) to enable per-channel metering, and metering level sent
as Channel Pressure (status `0xD0`, always MIDI channel 1, one data byte
packing `(stripIndex<<4)|level`) - all cross-checked against Ableton's own
`ChannelStrip.py`. Button LEDs are plain Note On/Off (`midiOut.sendMidi(
0x90, note, 127/0)`).

**Per-channel LCD meter bar: confirmed working, and confirmed NOT
independently paintable for color.** Console-verified: `track idx 7`'s
Channel Pressure level fluctuated correctly (2-6, tracking real playback)
while the on-screen bar visibly moved in sync, on all 8 channels,
including channel 8 (the earlier "channel 8 not updating" report turned
out to be no audio actually routed to that track yet, not a script bug).
The Channel 8 Meter Test Mode experiment (see Debug settings above) then
showed the bar reacting to level in every one of the 4 documented VU
modes, including notionally "off" - meaning this bar isn't a separate
paintable display region gated by that mode byte, it's a genuine VU meter
directly driven by the Channel Pressure value, full stop. Repurposing it
to show track color instead of level isn't achievable through this
mechanism: sending fake "level" values to force a certain color band
would mean giving up real metering on that channel, and would still only
get whatever green/yellow/red gradient this hardware's firmware bakes
into level rendering - not arbitrary RGB. The earlier "blue bar" question
that kicked this off was very likely about a different, unrelated
display entirely - the segment display (see below) - not this meter.

Separately, there's a totally distinct hardware display - the transport
position ("segment display", confirmed via Mossgraber's
`MCUSegmentDisplay.java`: 10 digits, each driven by its own CC 0x40-0x49)
- that showed "BEATS" and its own idle graphic before this script sent it
anything, which is exactly what a genuine MCU's segment display looks
like at idle: it's the display's real, intended purpose, not something to
repurpose. **Now implemented** (`updateSegmentDisplay()`, polled every
`flush()` like the other outputs): `transport.getPosition().getFormatted(
positionFormatter)` (a real, non-deprecated Controller API method -
`host.createBeatTimeFormatter(":", 3, 2, 2, 3)`, called once in `init()`)
yields a `Bars:Beats:Subdivision:Ticks` string (e.g. `"003:02:03:045"`),
3+2+2+3 = 10 digits total, matching this display's 10 cells exactly. The
string is translated into the segment protocol by porting Mossgraber's
`writeLine()` logic verbatim: walking the text right-to-left, a `:`
doesn't consume a digit cell - it flags the *next* (further left) digit
to get `+0x40` added to its ASCII code, which is how this protocol
encodes "this digit has a decimal dot after it" on a 7-segment display.
Per-digit de-duped against `segmentDisplayBuffer` so only cells that
actually changed get re-sent. **Confirmed working on hardware** -
consistent bars:beats numbers, updating live while playing. The "blue"
from the original question turned out to be this display's fixed
background/backlight color, sitting behind white digits - not something
the data content controls, and not something to chase further.

**Assignment row (notes 40/41/42/44/45 - TRACK/IO, SEND, PAN, PLUG-INS,
RETURNS) LEDs are hardware-managed and inconsistent about clearing each
other - our own plain note-off is always ignored, and even lighting a
sibling doesn't reliably clear a given note.** Console-tested: pressing
PLUG-INS a second time (to exit Device mode) correctly runs
`updateModeLEDs()`, which sends note-off for 44 - but the LED stays lit;
pressing SEND afterward (lighting note 41) clears it as a side effect,
same as the already-documented BANK/CHANNEL LED quirk - and pressing SEND
also clears a stuck RETURNS LED (note 45) the same way. But lighting
TRACK/IO (note 40) does **not** reliably clear a stuck RETURNS LED
(confirmed: pressing RETURNS a second time correctly reverts
`isViewingReturns`/`currentMode` back to plain Mixer internally, but the
note-45 LED itself stayed lit) - so unlike genuine Mackie Control
hardware, this unit's 5 assignment LEDs aren't all equally capable of
clearing one another; a first attempt at forcing it by briefly flashing a
sibling LED (`flashLed(40, 60)`) backfired the same way for the same
reason (TRACK/IO's own "off" got ignored too, just moving the stuck-LED
problem onto a different note).

`updateModeLEDs()` now tracks the last note it lit (`lastAssignmentNote`)
and, whenever the target changes, sends an explicit note-off for that
specific note in addition to the note-on for the new one - cheap, and
gives the hardware the best available chance of clearing it regardless of
which internal mechanism it's actually using, without relying solely on
sibling-clears-sibling behavior that's now known to be inconsistent.

Each encoder also has its own small position-indicator LED ring (a single
lit dot moving around it), separate from the 2-row text display - real MCU
protocol per Mossgraber's DrivenByMoss driver: CC `(0x30 + channel)` with a
value packing the display mode (single dot/boost-cut/wrap/spread, bits
4-5) and a 0-11 rescaled position (bits 0-3). Wired up in
`updateVPotRingOutputs()` (called every `flush()`, same polling-and-diff
pattern as the fader motor output) to show whatever `getEncoderTarget()`
currently returns for that channel - i.e. **always** what the encoder
itself controls (pan in Mixer mode, sends in Sends mode, always the macro
in Device mode regardless of FLIP), matching the physical V-Pot ring's
own encoder rather than the fader.

**Per-channel LCD/strip colors, matching each track's own Bitwig color,
via `updateChannelColorOutput()` - confirmed NOT working on this hardware.**
Sends one SysEx `F0 00 02 4E 16 14 <8x R,G,B (0-127)> F7` covering all 8
channels at once (the "ICON"-vendor variant of this MCU extension, per
Mossgraber's driver). Tested live: channel colors don't change at all, so
this protocol variant is wrong for this unit. There are at least two other
known vendor-specific variants (e.g. Behringer's single-byte 3-bit color
index) that haven't been tried yet - this isn't documented in the Midiplus
manual at all, so it's trial and error. The code is still in place
(harmless no-op on this hardware) in case a future firmware or a different
variant turns out to work.

### Momentary bottom-row LCD popups

The bottom LCD row normally always shows the track's volume in Mixer mode
(see `setupChannelStripObservers`) - two things temporarily override it,
then revert back to whatever's normally shown (via `refreshDisplayText()`)
after `LCD_OVERRIDE_TIMEOUT_MS` (800ms) of no further activity on that
channel:

- **Turning an encoder to adjust pan** (Mixer mode, unflipped) reveals the
  live pan value instead of volume for as long as you keep turning it -
  see `revealPanTemporarily()` / `isShowingPanTemporarily`.
- **Pressing SOLO or MUTE** shows a one-shot `SOLO`/`UNSOLO` or
  `MUTE`/`UNMUTE` popup (reflecting the *resulting* state, not what it
  was before the press) - see `showBottomRowPopup()`. Works regardless of
  which mode is currently active (Mixer/Sends/Device), since Solo/Mute
  themselves aren't mode-specific.
- **Switching modes** (TRACK/I/O, SEND, PLUG-INS/F1-F8, RETURNS) shows a
  whole-strip announcement - `PLUGIN`/`SENDS`/`RETURNS`/`MIXER` repeated
  across all 8 channels' bottom row - on entry to that mode and again when
  it's left back to Mixer, via `showModePopup()`. Paging within Sends
  (1-8 -> 9-16) doesn't re-announce, since that's not a mode change.
- **Selecting a track** (SELECT button, or clicking it in Bitwig) shows
  its color as a human-readable name (`ORANGE`, `LTORANG`, `PURPLE`, etc)
  on that channel's bottom row, via `nameForTrackColor()` - there's no
  color-name API (`ColorValue` only exposes raw `red()`/`green()`/
  `blue()`). `NAMED_COLORS` is Bitwig's actual 27-entry default
  track-color palette, ported verbatim (exact RGB, not guessed) from
  Mossgraber's `DAWColor.java`, which reverse-engineers this same grid for
  color-matching in his own controller drivers - since a track's color is
  almost always one of these 27 swatches, matches are usually exact or
  near-exact, not approximate (an earlier, smaller made-up palette
  couldn't tell e.g. Orange from Light Orange apart - this one can, since
  both are real distinct entries in it). Names are abbreviated from
  Mossgraber's original labels (see the code comments for the full
  originals) to fit the 7-character LCD cell limit. Makes it easier to
  spot which track just became selected at a glance, since Bitwig's own
  selection highlight isn't otherwise visible on this hardware.

All four share one per-channel debounce mechanism (`lcdOverrideGeneration`)
so they can't race each other, plus a separate single shared token
(`modePopupGeneration`) for the whole-strip mode announcements specifically
(so per-channel activity elsewhere doesn't cut it short). Bitwig's
`scheduleTask` has no way to cancel an earlier still-pending timer - each
trigger bumps the relevant token(s), and a scheduled revert only actually
happens if nothing bumped it again in the meantime.

## Confirmed button map

Live-tested this session (pressing every button in MCU mode and reading the
console's `RAW Note-On received` log against both Ableton's driver and
Mossgraber's DrivenByMoss MCU driver's note constants). **Key finding:**
switching the hardware from Live mode (with the overlay) to standard MCU
mode (overlay off) did **not** change any note number for any button
tested - only the manual's documented LED/local-firmware behavior differs
between modes. So every binding below, originally derived while the unit
was still in Live mode, is confirmed still correct.

| Notes | Function | Bitwig behavior |
|---|---|---|
| 0-7 | Rec Arm 1-8 (only sent by the SEL row while the standalone REC button, bottom-left, is toggled on - REC itself sends no note) | `track.arm().toggle()` |
| 8-15 | Solo 1-8 | `track.solo().toggle()` |
| 16-23 | Mute 1-8 | `track.mute().toggle()` |
| 24-31 | Select 1-8 (double-press folds/unfolds a group track) | `selectInMixer()` / `isGroupExpanded().toggle()` |
| 32-39 | Encoder push-click | Center pan (Mixer) / reset send (Sends) / Device: hold + turn = fine resolution, reset macro, or open/close plugin window - see Encoder Push Behavior |
| 40 | I/O (TRACK on the bare Logic-label printing) | Toggle Track Inspector, or switch to Mixer mode |
| 41 | SEND | Sends mode toggle, 2 or 3 states depending on Send/Return Bank Size (SHIFT = jump straight to Sends 9-16) |
| 42 | PAN | Toggle `TRLVL` tool-device Gain/Pan control |
| 43 | FLIP | Swap faders/encoders - moved here from note 50 after console-log confirmation that the overlay's printed FLIP button actually sends this note, not 50 |
| 44 | PLUG-INS (SHIFT = EQ Mode) | Toggle Device mode (first device, opens panel; second press also closes the panel) - confirmed via console testing that the Live overlay's "PLUG-INS" sticker is over this note, not 43. SHIFT+PLUG-INS jumps to the last EQ in the chain instead; pressed again while already there, exits to Mixer mode - see EQ Mode below |
| 45 | RETURNS | Swap channel strips to/from the Return Tracks bank - moved here from note 51 after console-log confirmation (the bare-label "INST" binding that used to live here was never actually reachable under this overlay) |
| 46 | BANK PREV | Page track bank back (SHIFT = jump to first) |
| 47 | BANK NEXT | Page track bank forward (SHIFT = jump to last) |
| 48 | CHANNEL PREV | Nudge one channel back (CTRL = prev device / tempo down) |
| 49 | CHANNEL NEXT | Nudge one channel forward (CTRL = next device / tempo up) |
| 50 | UNDO | `application.undo()` - moved here from note 76 after console-log confirmation that the overlay's printed UNDO button actually sends this note, not 76 |
| 51 | REDO | `application.redo()` - moved here from note 79, same confirmation as UNDO/note 50 above |
| 52 | NAME/VALUE | Unbound (no Bitwig equivalent) |
| 53 | SMPTE/BEATS | Pure mode key, deliberately unbound - toggles the F1-F8 row's backlight red/green (and which note range F1-F8 sends) entirely in hardware firmware; no longer bound to Automation Write |
| 54-61 | F1-F8 (default/orange-lit state) | Select device 1-8 directly on the current track (enters `MODE_DEVICE` if needed), opening its window; pressing the already-selected device's key again toggles its window closed/open instead |
| 62-69 | F1-F8 (green-lit state, toggled via SMPTE/BEATS) | Configurable editing function per key, see Function Keys settings above (defaults: F1=Duplicate, F2=Consolidate, F3-F8=None) |
| 70-73 | SHIFT / OPTION / CTRL / ALT | Modifier hold state; standalone tap action is configurable, see Plugin Mode settings above |
| 74 | (Live label: SESS/ARR) | Toggle clip launcher / arranger view |
| 75 | (Live label: CLIP/FX) | Toggle device / clip view |
| 76 | DRAW | Cycle the 6 arranger edit tools; SHIFT+DRAW toggles Arranger Automation Write (popup shows `Automation Write: ENABLED`/`DISABLED`) - moved here from note 81 after console-log confirmation that the overlay's printed DRAW button actually sends this note, not 81 |
| 77 | (Live label: BROWSER) | Toggle browser panel |
| 78 | (Live label: DETAIL) | Toggle note/automation editor panel |
| 79 | B.T.A. | Toggle `MODE_SCENE` - moved here from note 80 after console-log confirmation that the overlay's printed B.T.A. button actually sends this note, not 80 |
| 80 | Unconfirmed - previously (wrongly) assumed to be B.T.A. | Unbound - needs testing |
| 81 | Unconfirmed - previously (wrongly) assumed to be DRAW | Unbound - needs testing |
| 82 | Printed "PAGE (left arrow)" under the Ableton overlay (confirmed via console - previously wrongly assumed "MARKER") | `MODE_DEVICE`: page macro bank back. `MODE_MIXER`: jump to previous cue marker and move the loop to follow it - see Mixer Mode PAGE below |
| 83 | Printed "PAGE (right arrow)" under the Ableton overlay (previously wrongly assumed "FOLLOW") | `MODE_DEVICE`: page macro bank forward. `MODE_MIXER`: jump to next cue marker and move the loop to follow it - see Mixer Mode PAGE below |
| 84 | - | Jump to previous cue marker |
| 85 | - | Jump to next cue marker |
| 86 | (Live label: LOOP) | Toggle arranger loop |
| 87 | Unconfirmed - previously (wrongly) assumed to be Jog Wheel Push | Unbound - needs testing |
| 88 | (Live label: PUNCH OUT) | Toggle punch-out (CTRL = set loop end from playhead) |
| 89 | (Live label: HOME), SHIFT = add "Bar N" cue marker | Jump playhead to project start; SHIFT+HOME adds a cue marker at the current position, auto-named for its bar number - see Cue Marker Naming below |
| 90 | (Live label: END) | Jump playhead to loop start |
| 91-95 | Transport: REWIND/FF/STOP/PLAY/RECORD | Standard transport |
| 96 | Cursor UP | Arrow key up, or zoom in track height (while ZOOM/note 100 toggled) |
| 97 | Cursor DOWN | Arrow key down, or zoom out track height (while ZOOM toggled) |
| 98 | Cursor LEFT | Arrow key left, device select previous in `MODE_DEVICE`, or zoom out timeline (while ZOOM toggled) - see Zoom below |
| 99 | Cursor RIGHT | Arrow key right, device select next in `MODE_DEVICE`, or zoom in timeline (while ZOOM toggled) - see Zoom below |
| 100 | ZOOM | Toggle zoom mode for cursor arrows |
| 101 | Jog wheel push - moved here from note 87 (confirmed via console log: the wheel's own click always sends 101, never 87 - see "Wheel-assignment button investigation" below) | Momentary "Pan Mode" hold; ALT+press = select item at playhead; SHIFT+CTRL+press = same, one-shot; launches selected scene in `MODE_SCENE` |
| 104-111 | Fader touch 1-8 | Optionally selects that channel's track, see Mixer settings below |
| 112 | Fader touch (Master) | Optionally selects the master track, see Mixer settings below |
| CC 16-23 | Rotary encoders 1-8 | Mode-dependent (pan/send/macro); SHIFT = stepped or fine adjust, see Encoders settings above |
| CC 60 | Jog wheel | Arranger scrub, or bar/loop/tempo nudge with modifiers held, or scene navigation in `MODE_SCENE` |
| Pitch bend ch 0-7 / 8 | Faders 1-8 / Master | See Architecture above |

### Jog wheel modifier combos

In priority order (each returns before the next is checked, so only one
applies per turn): `MODE_SCENE` active (move the scene cursor) >
**SHIFT+CTRL** (configurable, see below) > **ALT+CTRL** (configurable,
see below) > **CTRL alone** (device-mode: step devices; otherwise: select
next/previous arranger clip/item, see below) > **SHIFT+ALT** (nudge the
selected arranger item, see below) > **ALT alone** (adjust the
last-clicked GUI parameter, see below) > PLUG-INS held (step devices) >
BANK held (page remote-control pages) > OPTION alone (halve/double loop
length) > SHIFT alone (shift loop by a bar) > wheel held down (note 101 -
see "Wheel-assignment button investigation" below; `isScrubToggled` is
currently dead, no known hardware note sets it) (jump by a bar, or
select-at-cursor with ALT or SHIFT+CTRL held, see below) > default
(scrub, **Wheel (No Modifier): Playhead Jump per Tick
(bars)** per **Wheel (No Modifier): Ticks per Bar** accumulated raw
ticks - default 1 bar per 8 ticks, configurable, see below - no longer
ALT-modified).

**SHIFT+CTRL + Jog Wheel** and **ALT+CTRL + Jog Wheel** (turn, as opposed
to SHIFT+CTRL + Jog Wheel *Press* further below - same two modifiers as
one of these, different gesture, different action) each independently
run whichever action their own Controller Preferences dropdown is set to
(**SHIFT+CTRL Wheel Action** / **ALT+CTRL Wheel Action**, Function Keys
category, see above) - freely invertible, since both dropdowns offer the
identical 5-option list:

- `Scale Clip Size` - turn right doubles the selected clip's content
  (Bitwig's real `"Scale 200%"` action, id `scale_time_double`), turn
  left halves it (`"Scale 50%"`, id `scale_time_half`), confirmed from
  `bitwig-actions-reference.txt`.
- `Duplicate/Delete Clip` - turn right duplicates the selection
  (`application.duplicate()`), turn left deletes it
  (`application.remove()`).
- `Duplicate Clip` (**SHIFT+CTRL's default**) - turn right duplicates the
  selection, same as above; turn left is **always** a no-op, regardless
  of the delete kill switch below - a self-contained safe choice for
  anyone who wants duplicate-only without also having to remember to turn
  that separate setting off. Requested directly as the safer default.
- `Duplicate/Delete Track` (ALT+CTRL's default) - turn right duplicates
  the current track (`cursorTrack.duplicateObject()`), turn left deletes
  it (`cursorTrack.deleteObject()`) - `Track` implements
  `DuplicableObject`/`DeleteableObject` directly, confirmed from the
  Controller API Javadoc, so this targets the current track specifically
  rather than depending on Bitwig's ambient selection the way
  `application.duplicate()`/`.remove()` do for the clip option.
- `Duplicate Track` - turn right duplicates the current track, same as
  above; turn left is always a no-op, same reasoning as `Duplicate Clip`.

The two `Duplicate/Delete` options pair duplicate/delete as deliberate
opposites, same pattern as grow/shrink scaling. Turning left deleting
something outright (rather than a harmless no-op) was flagged as
potentially too risky, so it's gated by the shared **Wheel Combos: Allow
Delete (Turn Left)** setting (default on, see above) - off, turning left
does nothing in either `Duplicate/Delete` option and only duplicate
(right) is live. The plain `Duplicate Clip`/`Duplicate Track` options
sidestep needing that toggle at all - turning left there is always a
no-op by design, not by configuration.

All five actions are repeat-accumulating (scaling is exponential per
repeat, duplicate/delete is additive - one extra duplicate or one more
delete per repeat), so each combo throttles via its own accumulate-then-
fire accumulator (`shiftCtrlWheelAccumulator`/`altCtrlWheelAccumulator` -
kept separate so partial progress on one combo can't spill into the
other if you switch which modifiers are held mid-turn), each with its
**own independently configurable tick threshold** - **SHIFT+CTRL+Wheel:
Ticks to Scale Clip / Duplicate / Delete** and **ALT+CTRL+Wheel: Ticks to
Scale Clip / Duplicate / Delete** (Wheel Options category, default 16
each, same range as "OPTION+Wheel: Ticks to Halve/Double Loop Length") -
the label names all 3 possible outcomes since the actual one depends on
the paired **SHIFT+CTRL Wheel Action**/**ALT+CTRL Wheel Action** dropdown
(Function Keys category) - rather than sharing one setting between them,
so each combo's sensitivity can be tuned on its own (e.g. a higher tick
count for `Duplicate/Delete` to make an accidental trigger less likely,
while keeping `Scale Clip Size` responsive). Plain CTRL's clip/track-select
stepping has its own matching setting too - **CTRL+Wheel: Ticks to Move
to Next/Prev Clip or Track** (Wheel Options category, default 4, range
1-32) - previously shared with device-
stepping's `PLUGIN_DEVICE_STEP_MESSAGES`, now independent. This all
fires instead of on every raw wheel message, which would compound (or
delete) far too fast. SHIFT+CTRL replaced an earlier "jump to first/last
item" behavior (which worked, but this was requested instead) - those
actions are no longer bound anywhere, freed
up if wanted again later. Both checked before the plain-CTRL branch so
neither is swallowed by it.

For anyone who'd rather manage one shared default than tune all three
separately, **Override Wheel Combo Thresholds** (Wheel Options category,
off by default) overrides all three of the settings above with a single
**Global Tick Threshold (All Combos)** count (Wheel Options category,
default 16, range 1-64) once switched on -
`applyWheelTickSettings()` re-derives `CLIP_SELECT_STEP_MESSAGES`/
`SHIFT_CTRL_WHEEL_THRESHOLD`/`ALT_CTRL_WHEEL_THRESHOLD` from either the
global value or each combo's own individual setting depending on this
toggle, called from every one of the five settings' observers so flipping
it (or changing any value while it's on) takes effect immediately. The
three individual settings stay visible and adjustable in the panel while
the toggle is on - they're just not the ones in effect - so switching it
back off picks up right where each one was left, nothing reset. Doesn't
touch **OPTION+Wheel: Ticks to Halve/Double Loop Length** (OPTION + Jog
Wheel's own setting, predates this round's independently-configurable-ticks
request and covers a different gesture) - only the three CTRL-combo
settings. Not yet tested on hardware.

**CTRL + Jog Wheel** (outside `MODE_DEVICE`, where it still steps devices
as before) selects the next/previous arranger clip/item instead of its
original job, nudging the project tempo - via Bitwig's real "Select Next
Item"/"Select Previous Item" actions (ids `"Select next item"`/`"Select
previous item"`, confirmed from `bitwig-actions-reference.txt`),
throttled once every **CTRL+Wheel: Ticks to Move to Next/Prev Clip or
Track** (default 4) wheel messages - its own dedicated setting, no longer
shared with device-stepping's `PLUGIN_DEVICE_STEP_MESSAGES`. Repurposed
per request - **tempo nudging no longer has a jog-wheel binding**
(CTRL+ALT no longer means "fine tempo nudge" either, since there's no
longer a continuous nudge to make fine - CTRL+ALT+wheel is now its own
separate combo, see above, no longer swallowed into plain CTRL's
behavior).

**Confirmed working on hardware, current behavior (post-revert)** - with
a clip selected, steps between clips on that track; with nothing
selected, steps track-to-track (above/below) instead - and that
track-to-track stepping also walks through any expanded automation
lanes on the way, not just track rows, since it's real Bitwig Arranger
navigation from the same action, not something this script special-cases
or filters. Whether
that fallback is welcome has flipped over the course of this session:
originally reported as a liked side effect ("gives freedom to move
around the arrangement") when it mostly only showed up with nothing
selected; then, once the `selectInEditor()` fix (see "Likely root cause
found and fixed" above) gave the Arranger a genuine, persistent
selection anchor for the first time, the same fallback started firing
far more often and was reported as actively breaking the expected "just
step along the current track" gesture. Briefly swapped to "Select item
to left"/"Select item to right" (mirroring LEFT/RIGHT arrow-key
navigation specifically, hoping for same-track-only stepping), then
**reverted after confirming on hardware that those two do nothing at
all**, even with a clip already selected - same non-functional pattern
already seen with `select_item_at_cursor` and `Select item above`/`Select
item below` (all real, named Bitwig actions that appear to do nothing
when invoked via the Controller API, regardless of exact wording).
"Select next item"/"Select previous item" is the only action in this
whole family confirmed to actually change the selection this way, so
it's back in place despite its own quirk - a working action with an
occasional side effect beats a "correct" one that does nothing.

Note this is a different thing from CHANNEL PREV/NEXT (notes 48/49) + CTRL,
which still independently nudges
tempo when this hardware's own CHANNEL wheel-assignment mode is active
(see case 48/49) - untouched, since that's a separate firmware-level
input path, not the plain jog wheel.

**OPTION + Jog Wheel** halves (turn left) or doubles (turn right) the
arranger loop length, accumulated across messages via
`loopScaleAccumulator`/**OPTION+Wheel: Ticks to Halve/Double Loop
Length** (see settings above) so it doesn't fire on every raw wheel
message. Capped at 256 bars on the doubling side so repeated doubling
can't run away forever; floored at **1 whole bar** (not a fixed tiny
note value like a 64th note, which is what it used to floor at) on the
halving side - found and fixed directly: starting from a non-power-of-2
loop length (e.g. 3 bars) used to keep halving straight past whole-bar
lengths into awkward fractional-bar ones instead of stopping cleanly at
1 bar.

**ALT + Jog Wheel** adjusts whatever parameter was last clicked in
Bitwig's own GUI - click any knob/slider/fader once in Bitwig
(`host.createLastClickedParameter()`, `lastClickedParamValue.inc(rawStep,
128)`), then hold ALT and turn the wheel to dial it in without touching
the mouse again. **Not literal continuous mouseover** - the Controller
API only exposes "last clicked" (confirmed against the
`LastClickedParameter` Javadoc: `.parameter()` tracks whatever was most
recently clicked, not live hover position), not a per-frame "what's under
the cursor right now" feed - but functionally close for the requested
workflow: click once to arm a control, then adjust freely with the wheel.
Shows the parameter's name as a Bitwig popup on every turn so it's always
clear what's currently armed. **Confirmed working on hardware** -
clicking a Drum Machine's own output-level knob and using this combo
correctly adjusted it; a circular on-screen overlay briefly appeared at
the same time, which turned out to be that same Drum Machine parameter
(commonly labeled "Master" inside instrument devices, unrelated to the
actual mixer master bus) rather than a second, unintended change - the
real master bus volume was confirmed unchanged.

This was originally SHIFT+OPTION together (OPT alone was already bound to
loop halve/double, so a still-free combo was needed), then moved to plain
ALT per request - which meant giving up ALT's old role of halving the
default scrub step (quarter note -> eighth note), now removed since ALT
alone is claimed earlier and that code was no longer reachable. CTRL+ALT
(fine tempo nudge) is unaffected, since CTRL is still checked first and
returns before the plain-ALT branch is ever reached.

**Default (no modifier) Jog Wheel** - reported as too slow at the fixed
one quarter note (beat) it shipped with; a follow-up beat-based version
(widened range, "up to 8 bars") was then reported as feeling
inconsistent, since an arbitrary beat count could land mid-bar instead
of scrolling cleanly bar-to-bar. Redone as **whole bars**, always
anchored on a bar start - never landing on an individual beat partway
through a bar, regardless of which mode below is active.

**Wheel (No Modifier): Playhead Jump per Tick (bars)** (Wheel Options
category, default `1`, range 1-8) controls how many whole bars the
playhead jumps per accumulated-tick threshold reached (see below) when
**Adaptive Wheel Scrub** (below) is off - `Math.round(position /
beatsPerBar)` snaps to the nearest bar boundary first, then moves by
this many bars, so it's always exactly on a bar line (same
compute-the-exact-target-position approach the bar-jump (Pan Mode)/
loop-shift combos already use), not a smooth but grid-imprecise scrub.
`getBeatsPerBar()` makes this time-signature-aware automatically, unlike
the earlier beat-based version's range (which could only assume 4/4).

Originally this branch fired once per raw wheel *message* using only
turn direction, ignoring how large that message's own tick value was -
reported back as feeling both "jumpy" and needing "too many ticks to
scroll 1 bar", since a fast flick (which the hardware batches into one
larger-magnitude message, same MCU behavior already handled correctly by
every other wheel combo above) moved exactly as far as the gentlest
possible nudge. Fixed the same way as those other combos:
`wheelScrubAccumulator` accumulates each message's signed raw tick value,
and only once it reaches **Wheel (No Modifier): Ticks per Bar** (Wheel
Options category, default `8`, range 1-64 - same range as
**OPTION+Wheel: Ticks to Halve/Double Loop Length** and the other combo
thresholds, but half their 16-tick default per direct feedback that 16
needed too much physical turning per bar) does a bar-jump actually fire,
via a `while` loop so a
single fast flick spanning several thresholds' worth of ticks can fire
multiple bar-jumps at once rather than being capped at one per message.
Any leftover ticks below the threshold carry over to the next message
instead of being discarded, so slow, gentle turning still accumulates
correctly instead of never quite reaching the threshold. Turning speed
now actually matters again - a slow turn needs more physical ticks per
bar-jump, a fast flick needs fewer (or fires several at once) - and
**Ticks per Bar** is the lever to tune exactly how many physical wheel
ticks map to one bar-jump, independent of **Adaptive Wheel Scrub:
Pixels per Tick** below (which only controls how many *bars* one
threshold-crossing moves at a given zoom level, a separate concern from
how many *ticks* it takes to cross that threshold in the first place).

**Adaptive Wheel Scrub (Scale with Zoom)** (on/off, default OFF) +
**Adaptive Wheel Scrub: Pixels per Tick** (default `50`, range 10-200) -
requested directly: a fixed bar count per tick feels tiny when zoomed
way out (barely visible movement across a wide timeline) and huge when
zoomed way in (jumping clean past what you're trying to land on). When
on, `effectiveWheelScrubBars()` computes the bar count from the **actual
live zoom level** instead of the fixed setting above -
`arrangerHorizontalScrollbar.getContentPerPixel()` (see Zoom settings
above) gives beats-per-pixel at the current zoom, divided by
`getBeatsPerBar()` to get bars-per-pixel, multiplied by **Pixels per
Tick** to get "how many bars correspond to N screen pixels of timeline
right now" - **translated to a whole-bar count up front** (`Math.round`,
floored at `1`), specifically so the result is always a whole number of
bars and can never land mid-bar, rather than scaling a raw pixel/beat
value that could produce a fractional step. The wheel then always moves
roughly the same *visual* distance per tick regardless of zoom -
naturally faster in absolute time when zoomed out (each pixel covers
more bars) and slower when zoomed in (each pixel covers less than a
bar, rounding up to the 1-bar floor), without any special-case logic -
it falls directly out of dividing by the live zoom value and rounding.
Off by default - an opt-in alternative to the fixed bar count above, not
a replacement, until confirmed on hardware.

**ALT + Jog Wheel Press** (push the wheel down while holding ALT - note
101, not 87, see "Jog-wheel 'mode' buttons" above) runs Bitwig's real
`select_item_at_cursor` action ("Select item at cursor" - same one the
Function Keys dropdowns offer, see `FKEY_FUNCTIONS`) - the wheel press
itself acts as the "click", so nothing needs an actual mouse click
first. The check only tests `isAltPressed` (not caring whether SHIFT is
also held), so it doubles as the first step of the SHIFT+ALT clip-drag
gesture below - the same press works whether you're holding just ALT or
SHIFT+ALT. Takes priority over the wheel-press's other use (launching
the selected scene in `MODE_SCENE`) when ALT is held. Not yet tested on
hardware since the note-87/101 fix - this combo had never actually
fired before that (see above), so this is effectively untested.

**SHIFT+ALT + Jog Wheel** nudges whatever's currently selected in the
arranger (a clip, automation point, etc.) left/right by one grid step per
wheel message, via the real `nudge_events_one_step_earlier`/`_later`
actions ("Nudge Events One Step Backward"/"Forward" - **not** the
similarly-named `nudge_events_one_bar_earlier`/`_later`, which despite
the "bar" in their id actually map to "Nudge Events Fine/Alternate Amount
Backward"/"Forward", a different and more ambiguous granularity per
`bitwig-actions-reference.txt`). The full gesture: hold SHIFT+ALT, press
the wheel to select whatever's at the cursor (see ALT + Jog Wheel Press
above - its check doesn't exclude SHIFT, so it fires the same way), then
keep holding and turn the wheel to "drag" it - no mouse click needed
anywhere in the sequence. Doesn't show a popup per tick (unlike the
plain-ALT combo above) since the clip visibly moving in Bitwig's own UI
is feedback enough. Checked before the plain-ALT branch so it isn't
swallowed by it - ALT alone (parameter adjust) still fires normally when
SHIFT isn't also held. Not yet tested on hardware.

**SHIFT+CTRL + Jog Wheel Press** was tried as a "select whichever clip is
closest to the playhead" gesture, reusing the same `select_item_at_cursor`
action as ALT + Jog Wheel Press above - re-tested after fixing the note
87/101 mixup, and **confirmed for real this time**: it does NOT select
the item at the playhead on whatever track is currently active. Test
performed: created a clip on one track, switched to a different track
(also containing a clip), then pressed ALT+wheel and SHIFT+CTRL+wheel -
neither changed the selection at all; the original clip (on the track
switched away from) stayed selected. So "cursor" in that action's name
really is a generic UI keyboard-focus position, not the arranger edit
cursor/playhead - `select_item_at_cursor` cannot do what was hoped here.

**Follow-up experiment, now also confirmed non-functional and retired**:
SHIFT+CTRL + press briefly called `Select item below`, and OPTION + press
called `Select item above` (both real action ids from
`bitwig-actions-reference.txt`'s Selection category), hoping to mirror
arrow-key UP/DOWN's "move selection to the adjacent track" behavior and
let clip selection follow a track switch without touching the mouse.
Confirmed on hardware: the popup fires for both, but neither actually
changes the selection - same dead end as `select_item_at_cursor` and
"Select item to left/right" (see "CTRL + Jog Wheel" above). Both bindings
have been removed; the "need to click with the mouse to target a clip"
problem itself remains unsolved (the Controller API's Selection-category
actions are largely non-functional here - only "Select next/previous
item", used by plain CTRL+wheel, genuinely works) - see "Bank scrolling
selects a track" and the hidden-track/Show-Hide-Chains dead ends
elsewhere in this document for the same underlying Controller API
ceiling.

**OPTION + Jog Wheel Press now does something different and unrelated**:
it toggles `LastClickedParameter.smartToggleLock()` (see "ALT + Jog
Wheel" above) - locks the ALT+wheel parameter-adjust combo onto whatever
parameter the mouse is currently hovering over, without needing an exact
click first, and if already locked and the mouse has since moved
elsewhere, re-locks to the new parameter instead of unlocking (Bitwig's
own "smart" behavior, straight from its Javadoc: "Toggle locked status,
but if we are already locked and the mouse points at a different
parameter now, lock to the new parameter instead."). Requested directly
after the plain click-then-ALT+wheel workflow was reported as "a bit too
fiddly" - this is worth playing around with as a hover-based alternative,
especially for small Inspector fields (e.g. clip Gain) that are easy to
mis-click. A popup notification ("Locked to: <name>" / "Unlocked:
<name>") fires on every lock-state change via an `isLocked()` value
observer, rather than reading the value back immediately after invoking
the toggle (which risks reading a stale, not-yet-updated cached value on
the same tick). **Not yet tested on hardware.**

**Likely root cause found and fixed**: reported that clicking a track's
header with the mouse produces a visible "white circle" indicator around
it, and that selecting a track from the hardware (SELECT button/bank
scroll) leaves the track selected but shows no white circle at all.
`Channel.select()` is deprecated with an explicit note: "Use
`selectInEditor()` or `Channel.selectInMixer()` instead" - confirming
these are two genuinely separate selection concepts (`selectInEditor()`:
"Selects the device chain in Bitwig Studio [Arranger/editors]" vs.
`selectInMixer()`: "...in the Bitwig Studio mixer"). This script had
only ever called `selectInMixer()` at every track-selection call site
(fader touch, bank scroll's `selectBankSlot()`, the SELECT button
handler) - very likely why the white circle never appeared and why
`select_item_at_cursor`/`Select item above`/`Select item below` never
had any anchor to work from, since those probably read the Arranger's
own (editor) selection state, not the Mixer's. `track.selectInEditor()`
now runs alongside `selectInMixer()` at all 4 of those call sites. Not
yet confirmed on hardware whether this actually produces the white
circle or unblocks the wheel-press clip-navigation experiments above -
if it does, that's the whole "need to click with the mouse to target a
clip" problem solved in one line per call site.

**Final result**: SHIFT+CTRL + press (`Select item below`) and OPTION +
press (`Select item above`) both visibly fired - their popups showed -
but neither ever changed the actual selection, confirmed on hardware.
Whether the white circle itself now appears from `selectInEditor()`
wasn't separately confirmed, but it no longer matters for this specific
gesture since both bindings were retired (see "Follow-up experiment, now
also confirmed non-functional and retired" above) - the vertical
(`above`/`below`) and horizontal (`to left`/`to right`) Selection-category
actions all turned out equally non-functional via the Controller API, so
there wasn't a same-track-vs-cross-track distinction to find after all.
OPTION + press now drives an unrelated feature instead (the
`smartToggleLock()` hover-lock combo, see above).

### Jog-wheel "mode" buttons (CURSOR / SCROLL / ZOOM / MASTER / MARKER /
NUDGE / BANK / CHANNEL, per the manual's "Multi-Purpose Jog Wheel Section")

Confirmed this session: most of these send **no MIDI message at all** when
pressed - they're purely local firmware state that changes what the jog
wheel itself sends when subsequently turned (e.g. the already-documented
BANK/CHANNEL quirk: while lit, turning the wheel sends repeated Note-On
46/47/48/49 instead of CC 60). ZOOM is the one confirmed exception - it
sends note 100 directly, same as the note 100 already bound above.

**Full systematic sweep, this session**: tested the wheel's own click
under every mode reachable so far (SCROLL/base, ZOOM, MARKER, BANK,
CHANNEL - CURSOR, MASTER, and NUDGE not yet tested):

| Mode | Mode button itself | Wheel click | Wheel turn |
|------|---------------------|-------------|------------|
| SCROLL (base/default - this script previously called it "SCRUB", the manual calls it SCROLL) | No MIDI at all | **Note 101** | CC 60 (normal scrub) |
| ZOOM | Note 100 (toggle) | Nothing | Note-On 96/97 (up/down) or 98/99 (left/right) - see Zoom below |
| MARKER | No MIDI at all | Nothing | Note-On 84/85 - already bound above to jump to previous/next cue marker, so this already works with no extra code |
| BANK | Note 46/47 (also its own PREV/NEXT press action) | Nothing | Note-On 46/47 - already documented above |
| CHANNEL | Note 48/49 (also its own PREV/NEXT press action) | Nothing | Note-On 48/49 - already documented above |

**Corrected a real bug from this sweep**: the wheel's own click was
previously assumed to be note 87, and note 101 was previously assumed to
be a dedicated "SCRUB Button" toggling `isScrubToggled`. Both were wrong.
The click is always note 101, but only in the SCROLL/base mode - never
87, under any mode tested. Since the note-101 handler used to intercept
and `return` immediately (toggling a fine-scrub flag on every press), it
was silently swallowing every wheel click before it could ever reach the
Jog Wheel Push logic (bound to the nonexistent note 87) - meaning Pan
Mode, ALT+press "select item at cursor", the SHIFT+ALT clip-drag
gesture's click step, and Scene-mode launch-by-press had never actually
fired on this hardware. Fixed: Jog Wheel Push is now on note 101 (see
button-map table above), the old note-101 interceptor is removed, and
note 87 is left as an unconfirmed placeholder. `isScrubToggled` is now
dead code (nothing on this hardware can set it - the real SCROLL/SCRUB
button sends no MIDI at all) but left in place rather than ripped out,
in case a real trigger for it turns up later.

**Re-tested**: the original "SHIFT+CTRL + Jog Wheel Press ... confirmed
on hardware NOT to [select the item at the playhead]" conclusion further
below was reached while this same bug was still active, so it was
worth re-testing once the binding reached its handler correctly. Result:
**re-confirmed negative** - see that section for the actual test
performed and the experimental `Select item below`/`Select item above`
replacement now in place instead.

## Open items for next session

0. **Notes 50 and 51 need testing with the current overlay placement.**
   Both FLIP and RETURNS turned out to be at different notes than
   originally assumed (43 and 45, not 50 and 51 - both confirmed via
   console log after the buttons stopped working as expected). The old
   note-43/45-are-unlabeled conclusions were reached before the overlay
   got reattached/repositioned and turned out wrong twice in a row - worth
   doing a fresh full sweep of the whole 40-53 range against the current
   overlay rather than trusting any more inherited assumptions. Notes 50
   and 51 are both currently unbound pending confirmation of what they
   actually do now.
1. **Green-state F1-F8 (notes 62-69) configurable, all defaults confirmed
   working on hardware.** See Function Keys settings above. `Duplicate`/
   `Cut`/`Copy`/`Paste`/`Delete`/`Rename`/`Select All`/`Select None`/
   `Undo`/`Redo` all use guaranteed-correct typed `Application` methods;
   `Consolidate` (F2's default) initially used a wrong best-guess action
   ID, now fixed and console-confirmed (see Function Keys settings above -
   the real id turned out to be the plain word `"Consolidate"`, not
   snake_case). The red/orange state (54-61) still directly selects
   device 1-8, unaffected. SMPTE/BEATS (note 53) toggles between
   the two states in hardware firmware only - it's not bound to anything
   in Bitwig itself (previously toggled Automation Write - removed per
   request, see git history).
2. **Metering confirmed working on hardware, all 8 channels.** Console +
   visual confirmation: Channel Pressure level data fluctuates correctly
   and the on-screen LCD bar tracks it in real time on every channel,
   including channel 8 (an earlier report of channel 8 "not updating" was
   just no audio routed to it yet, not a script bug).
3. Debug logging (`RAW Note-On received`, `RAW CC received`, `Button
   pressed - Note:`) is still left in intentionally - useful while wiring
   up the remaining F1-F8 slots (item 1). Fine to remove once that's done.
4. **Assignment-row LED explicit-off fix + unified mode switching -
   confirmed better on hardware.** The `applyModeChange()` choke point
   (every mode-changing button fully resolves state, then re-syncs LEDs/
   display/fader-bindings together in one call) and `updateModeLEDs()`'s
   explicit note-off for the previously-lit note are both live and
   user-confirmed improved. Not exhaustively re-tested against every
   possible mode-to-mode jump though - worth keeping an eye out for any
   remaining stuck-LED case.
5. **Channel colors: the LCD meter bar is confirmed NOT usable for this -
   only the direct color SysEx (ICON variant, confirmed not working) is
   still an open avenue, and only if this is still wanted.** The meter
   bar experiment (see LCD/meters/LEDs section) ruled out repurposing the
   per-channel VU meter for color - it's hardwired to real Channel
   Pressure level data regardless of the mode byte. `updateChannelColorOutput()`
   (the ICON-variant color SysEx, unrelated to the meter bar) is left in
   as a harmless no-op; the remaining untried option is a different
   vendor's color SysEx variant (e.g. Behringer's single-byte 3-bit color
   index) - worth trying only if track color on this hardware still
   matters enough to keep chasing.

### Mixer Snapshots (SHIFT+F1-F8 store / OPTION+F1-F8 recall)

Second attempt this session - see "Reverted / abandoned" below for what
happened to the first one and why it doesn't reflect on this rebuild.
SHIFT+F(n) stores the current 8-track bank window's Volume+Pan into slot
n (1-8, one per F-key); OPTION+F(n) recalls it. Both combos were free to
use - a plain F-key press ignores modifier state entirely, so SHIFT/
OPTION held during one previously did nothing extra.

Rebuilt on `directTrackAt()` (the same direct `trackBank.getItemAt(i)`
binding proven reliable for faders/encoders/ARM/SOLO/MUTE/Pan Reset
elsewhere in this file) instead of the original `activeTrackAt()`
(`mainTrackCursors` indirection) - avoids that whole class of risk from
the outset rather than only reacting to it. Each stored entry captures
its track's **absolute** `Track.position()` (Main tracks) rather than
its bank-window slot, then recall targets that exact position via
`mainTrackScanBank.getItemAt(pos)` - the same permanently-unscrolled,
128-deep scan bank used elsewhere in this file - so recall finds the
right track regardless of any scrolling, Hide/Show-All toggling, or
which bank is currently on screen in between store and recall. Returns
tracks keep simple bank-slot-relative recall (no equivalent unscrolled
scan bank exists for them, and Returns rarely exceeds 8 tracks anyway).
`mainTrackScanBank`'s `volume()`/`pan()` are deliberately left
un-`markInterested()`'d - the first attempt marked them anyway (~256
extra live-tracked values spanning group boundaries) and that was
suspected, probably wrongly, of destabilizing the fader path; recall
only ever `.set()`s through that bank, never `.get()`s, and only `.get()`
requires prior interest.

Stored via `host.getDocumentState()` (saved inside the Bitwig project
file itself, hidden from the Studio I/O panel via `Setting.hide()`) so a
snapshot travels with the song. Scoped to just Volume + Pan on the
currently visible 8-track window - not the whole project, not
Mute/Solo/Sends. Both store and recall show a corner popup
(`host.showPopupNotification()`) and briefly flash across all 8
channels' bottom LCD row via `showModePopup()` - "STORE n"/"RECALL n"/
"EMPTY n" (recalling a slot that's never been stored). **Not yet tested
on hardware.**

## Reverted / abandoned this session (for context, don't re-attempt without a new plan)

- **Encoder-click volume-to-dB reset** (three different implementation
  strategies, each broke something different on real hardware - wrong
  target value, broken automation recording, script freeze). Encoder click
  is pan-reset only now, deliberately.
- **Live fader-follow via manual `sendMidi()` from a value observer /
  `scheduleTask`** - never worked; superseded entirely by the `flush()`-
  polling approach described above, which does work.
- **Mixer Snapshots, first attempt** (SHIFT+F1-F8 store / OPTION+F1-F8
  recall a Volume+Pan mix balance) - fully reverted after its first real
  hardware test appeared to break the core fader-input path: moving a
  physical fader stopped updating Bitwig's volume. **Turned out to be a
  red herring** - the real cause (an unrelated Hide-mode startup race
  condition, see "Faders" above) predates this feature entirely and just
  happened to be triggered during that test. Rebuilt from scratch below
  using `directTrackAt()` instead of the original cursor-based
  `activeTrackAt()`, once the real cause was found and fixed elsewhere.
