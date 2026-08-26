# Midiplus UP - Bitwig Controller Script

**File:** `MidiplusUP-MCU.control.js`
**Hardware mode:** standard **MCU mode** (see the unit's manual, section 3.3
and section 8) - not one of the Logic/Cubase/Live "customized" modes. The
plastic Ableton Live overlay has been removed, so the buttons show their
real printed labels.
**Bitwig API version:** 25
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
assignments in the higher note range (74-90) now that the Live overlay is
off and the real printed labels are different from what the script's
comments still say - see **Open Items** below.

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
  54-61), which also jump directly to device 1-8 on the chain.
- `MODE_SCENE` - entered via the button printed B.T.A. on the old Live
  overlay (note 80): shows the clip launcher, switches Bitwig to the Mix
  panel layout, and the jog wheel selects/launches scenes instead of its
  usual transport scrub.

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
  default CTRL) - which button's tap toggles `cursorDevice.isExpanded()`.
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
  a device's plugin window (via PLUG-INS, F1-F8 direct select, or the
  Expanded Device View action) first closes every *other* device's window
  on the current track's chain, for an "only one plugin window open at a
  time" workflow. Scoped to the current track's 8-slot device chain
  (`cursorDeviceBank`) - there's no Controller API way to enumerate open
  plugin windows project-wide, so windows on other tracks aren't affected.

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

Only an actual **hold** past **F-Key Hold Threshold (ms)** (Timing
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

**F-Key LCD Hold Linger (ms)** (Timing category, default 300, range
0-2000) - once the hold reveal has actually kicked in, it doesn't
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
combos below. Both dropdowns offer the same 3 options: `Scale Clip Size`
(SHIFT+CTRL's default), `Duplicate/Delete Clip`, or `Duplicate/Delete
Track` (ALT+CTRL's default). Freely invertible - set either dropdown to
either action, e.g. swap so SHIFT+CTRL duplicates the track and ALT+CTRL
scales the clip instead.

**Wheel Combos: Allow Delete (Turn Left)** (on/off, default ON) - shared
by both combos above, only relevant when either is set to a
`Duplicate/Delete` option. On, turning left deletes the selection (clip
or track, the original behavior). Off, turning left in that mode is a
no-op and only turning right (duplicate) does anything - the safer
choice if a slightly-wrong turn deleting something outright is too
risky; flagged as a "could be shaky" concern when requested.

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

**Assume Center (0.5) for Bipolar-Named Macros** (on/off, default ON) +
**Bipolar Macro Name Keywords** (text, default `pan,tun`) - `getOrigin()`
turns out to only be reliably `0.5` for parameters Bitwig itself
classifies internally as pan-like; a genuinely bipolar plugin parameter
that Bitwig merely wraps generically - confirmed on hardware with Serum
2's oscillator Fine Tune macros - reports `0` instead, even though its
real "no detune" center sits at `0.5`. Diagnostic logging added during the
Fine Zone Near Origin investigation below caught it directly: the macro's
value hovered around `0.50` on every logged tick while `getOrigin()`
reported a flat `0.0000` the entire time, so both Fine Zone Near Origin
and Encoder Snap to Origin were silently checking distance to the wrong
point and never activating anywhere near the actual center being aimed
for ("range 5%, then 10%, then resolution multiplier 4x, then 16x - no
visible behavior change" was the symptom that led to adding the logging).

The first fix (treating ANY reported origin of `0` as `0.5`, unconditionally)
was flagged as too broad on further hardware testing: only a handful of
controls on an instrument like Serum 2 are actually bipolar/centered (fine
tune, oscillator pan) - most of a device's other macros with origin `0`
are genuinely, correctly zero-based, and shouldn't get overridden just
because something else on the same instrument happens to be bipolar too.
Checked the Controller API for a more precise signal to key off instead of
a blanket override: `RemoteControl`/`Parameter` (both extend
`RangedValue`) expose only `name()`, `discreteValueCount()`/
`discreteValueNames()`, `getOrigin()`, and `displayedValue()` - no unit,
type, or "is bipolar" flag anywhere in the API. `name()` is the only one
that's a stable enough signal to use (`displayedValue()` is the live
formatted value, not a type descriptor, so it can't serve as a
classifier). `nameSuggestsBipolar()` now matches the macro's own name (as
labeled on its Remote Controls page slot) against the comma-separated
**Bipolar Macro Name Keywords** list, case-insensitively, as a substring -
default `pan,tun` catches "Pan", "Fine Tune", "Detune", "Tuning", etc.
`resolveOrigin()` (shared by both features) only applies the `0.5`
override when the origin is `0` **and** the name matches - so a
zero-origin macro that isn't named anything like pan/tune keeps its
correctly-reported `0`, while a fine-tune or oscillator-pan macro gets
treated as centered. Add your own plugin's naming conventions to the
keyword list (comma-separated) if a bipolar control there doesn't happen
to say "pan" or "tun". Can't make Pan or a correctly-reported bipolar
parameter any worse either way, since both already alias to `0.5`
regardless of this setting.

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
encoder-push pan reset (note 87/case in `handleButtonPress` - "Pan only -
centers the pan, nothing else") - that's still there as an exact,
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

**Fine Zone Near Origin** (on/off, default ON) - reported live from
hardware: with 8 macro knobs mapped to Serum 2 in bank 1 and oscillator
fine-tune macros (osc1/osc2/osc3/noise) in bank 2, turning slowly to land
back on exact center was nearly impossible - "it jumps between +1 and -1".
The cause: even the plain turn's finest resolution (128) still moves in
steps of roughly 0.8% of the full range per tick, which on a narrow,
origin-centered macro like fine-tune is already coarser than the "close to
center" window a careful hand is aiming for - so every tick either
overshoots past 0 or undershoots back away from it, with nothing in
between. `isNearOrigin()` checks, on every tick, whether the target's
*current* value sits within **Fine Zone Range (+/- %)** (default 5%, range
0.5-20%) of its real `getOrigin()`; when it does, the resolution argument
passed to `target.inc()` in `applyEncoderStep()`'s two continuous
(Fine-mode) branches is multiplied by **Fine Zone Resolution Multiplier**
(default 4x, range 2-16x) - a higher resolution value means a *smaller*
step per tick (`inc(delta, resolution)` moves `delta/resolution` of the
full range), so ticks taken near center land far more precisely than ticks
further out, without changing anything about how the encoder behaves once
back out in the normal range. Stacks independently with SHIFT's own
resolution bump (512 vs. the plain turn's 128) - near-origin SHIFT ticks
get sharpened too. Skipped for the same two cases **Encoder Snap to
Origin** skips: a genuine discrete/switch target (no "near origin" concept
for an enum, and that branch returns before reaching this code anyway) and
Stepped mode (which already lands exactly on the origin whenever the
configured **Encoder Step Size (%)** divides evenly into it, e.g. 10%
steps hit 50%/origin=0.5 exactly, so there's nothing to sharpen). Works
well together with **Encoder Snap to Origin** above - the fine zone makes
it possible to carefully creep toward center by hand, and the idle-based
snap still cleans up the last fraction of a percent once the encoder comes
to rest nearby.

First hardware round after shipping this: reported as still just as jumpy,
with zero observable change from raising **Fine Zone Range** 5% -> 10% or
**Fine Zone Resolution Multiplier** 4x -> 16x - a strong signal the
near-origin branch wasn't running at all, not that it was under-tuned.
Diagnostic logging confirmed it: for these exact fine-tune macros,
`target.get()` sat around `0.50` while `target.getOrigin()` reported a
flat `0.0000` throughout, so `isNearOrigin()` was comparing distance to
the wrong point and staying `false` the whole time no matter how wide the
range or how high the multiplier went - see **Assume Center (0.5) When
Reported Origin Is 0** above (now on by default) for the fix.

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

### Diagnostics settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Diagnostics** category.

- **Channel 8 Meter Test Mode** (default `LED + LCD (default, mode 3)`) -
  live-switches which of the 4 real MCU VU-meter modes channel 8's strip
  uses, by re-sending `F0 00 00 66 14 20 07 <mode> F7` with a different
  mode byte the moment you change the dropdown - no reload needed. The 4
  values are confirmed against Mossgraber's `switchVuMode()`/`VUMODE_*` in
  `MCUControlSurface.java` (not guessed): `0` = all off, `1` = LED meter
  only, `3` = LED + VU-meter on the LCD (what all 8 channels normally use,
  see below), `6` = VU-meter on the LCD only, no LED. Scoped to channel 8
  only - the other 7 strips stay on the confirmed-working mode 3
  regardless of this setting. **Result: on this hardware, the on-screen
  LCD bar reacted to real level in every one of the 4 modes, including
  `0`/off** - so this unit doesn't appear to distinguish between the mode
  byte values the way genuine Mackie hardware does; the LCD meter bar
  seems to always be driven directly by the incoming Channel Pressure
  level data regardless of the mode SysEx. Conclusion below.

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
The Channel 8 Meter Test Mode experiment (see Diagnostics above) then
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
| 32-39 | Encoder push-click | Center pan (Mixer) / reset send (Sends) / reset macro (Device) |
| 40 | I/O (TRACK on the bare Logic-label printing) | Toggle Track Inspector, or switch to Mixer mode |
| 41 | SEND | Sends mode toggle, 2 or 3 states depending on Send/Return Bank Size (SHIFT = jump straight to Sends 9-16) |
| 42 | PAN | Toggle `TRLVL` tool-device Gain/Pan control |
| 43 | FLIP | Swap faders/encoders - moved here from note 50 after console-log confirmation that the overlay's printed FLIP button actually sends this note, not 50 |
| 44 | PLUG-INS | Toggle Device mode (first device, opens panel; second press also closes the panel) - confirmed via console testing that the Live overlay's "PLUG-INS" sticker is over this note, not 43 |
| 45 | RETURNS | Swap channel strips to/from the Return Tracks bank - moved here from note 51 after console-log confirmation (the bare-label "INST" binding that used to live here was never actually reachable under this overlay) |
| 46 | BANK PREV | Page track bank back (SHIFT = jump to first) |
| 47 | BANK NEXT | Page track bank forward (SHIFT = jump to last) |
| 48 | CHANNEL PREV | Nudge one channel back (CTRL = prev device / tempo down) |
| 49 | CHANNEL NEXT | Nudge one channel forward (CTRL = next device / tempo up) |
| 50 | Unconfirmed - previously (wrongly) assumed to be FLIP | Unbound - needs testing, see Open Items |
| 51 | Unconfirmed - previously (wrongly) assumed to be RETURNS | Unbound - needs testing |
| 52 | NAME/VALUE | Unbound (no Bitwig equivalent) |
| 53 | SMPTE/BEATS | Pure mode key, deliberately unbound - toggles the F1-F8 row's backlight red/green (and which note range F1-F8 sends) entirely in hardware firmware; no longer bound to Automation Write |
| 54-61 | F1-F8 (default/orange-lit state) | Select device 1-8 directly on the current track (enters `MODE_DEVICE` if needed) |
| 62-69 | F1-F8 (green-lit state, toggled via SMPTE/BEATS) | Configurable editing function per key, see Function Keys settings above (defaults: F1=Duplicate, F2=Consolidate, F3-F8=None) |
| 70-73 | SHIFT / OPTION / CTRL / ALT | Modifier hold state; standalone tap action is configurable, see Plugin Mode settings above |
| 74 | (Live label: SESS/ARR) | Toggle clip launcher / arranger view |
| 75 | (Live label: CLIP/FX) | Toggle device / clip view |
| 76 | (Live label: UNDO) | `application.undo()` |
| 77 | (Live label: BROWSER) | Toggle browser panel |
| 78 | (Live label: DETAIL) | Toggle note/automation editor panel |
| 79 | (Live label: REDO) | `application.redo()` |
| 80 | (Live label: B.T.A.) | Toggle `MODE_SCENE` |
| 81 | (Live label: DRAW) | Cycle the 6 arranger edit tools; SHIFT+DRAW toggles Arranger Automation Write (popup shows `Automation Write: ENABLED`/`DISABLED`) |
| 82 | Printed "PAGE (left arrow)" under the Ableton overlay (confirmed via console - previously wrongly assumed "MARKER") | Page device macro bank back, `MODE_DEVICE` only; no-op otherwise |
| 83 | Printed "PAGE (right arrow)" under the Ableton overlay (previously wrongly assumed "FOLLOW") | Page device macro bank forward, `MODE_DEVICE` only; no-op otherwise |
| 84 | - | Jump to previous cue marker |
| 85 | - | Jump to next cue marker |
| 86 | (Live label: LOOP) | Toggle arranger loop |
| 87 | Jog wheel push | Momentary "Pan Mode" hold; launches selected scene in `MODE_SCENE` |
| 88 | (Live label: PUNCH OUT) | Toggle punch-out (CTRL = set loop end from playhead) |
| 89 | (Live label: HOME) | Jump playhead to project start |
| 90 | (Live label: END) | Jump playhead to loop start |
| 91-95 | Transport: REWIND/FF/STOP/PLAY/RECORD | Standard transport |
| 96-99 | Cursor arrows | Arrow keys, or zoom (while ZOOM/note 100 toggled), or device select in `MODE_DEVICE` |
| 100 | ZOOM | Toggle zoom mode for cursor arrows |
| 101 | SCRUB | Toggle fine-scrub mode for jog wheel |
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
length) > SHIFT alone (shift loop by a bar) > SCRUB toggle or wheel press
(jump by a bar, or select-at-cursor with ALT or SHIFT+CTRL held, see
below) > default (scrub, one quarter note per message, no longer
ALT-modified - see below).

**SHIFT+CTRL + Jog Wheel** and **ALT+CTRL + Jog Wheel** (turn, as opposed
to SHIFT+CTRL + Jog Wheel *Press* further below - same two modifiers as
one of these, different gesture, different action) each independently
run whichever action their own Controller Preferences dropdown is set to
(**SHIFT+CTRL Wheel Action** / **ALT+CTRL Wheel Action**, Function Keys
category, see above) - freely invertible, since both dropdowns offer the
identical 3-option list:

- `Scale Clip Size` (SHIFT+CTRL's default) - turn right doubles the
  selected clip's content (Bitwig's real `"Scale 200%"` action, id
  `scale_time_double`), turn left halves it (`"Scale 50%"`, id
  `scale_time_half`), confirmed from `bitwig-actions-reference.txt`.
- `Duplicate/Delete Clip` - turn right duplicates the selection
  (`application.duplicate()`), turn left deletes it
  (`application.remove()`).
- `Duplicate/Delete Track` (ALT+CTRL's default) - turn right duplicates
  the current track (`cursorTrack.duplicateObject()`), turn left deletes
  it (`cursorTrack.deleteObject()`) - `Track` implements
  `DuplicableObject`/`DeleteableObject` directly, confirmed from the
  Controller API Javadoc, so this targets the current track specifically
  rather than depending on Bitwig's ambient selection the way
  `application.duplicate()`/`.remove()` do for the clip option.

Both `Duplicate/Delete` options pair duplicate/delete as deliberate
opposites, same pattern as grow/shrink scaling. Turning left deleting
something outright (rather than a harmless no-op) was flagged as
potentially too risky, so it's gated by the shared **Wheel Combos: Allow
Delete (Turn Left)** setting (default on, see above) - off, turning left
does nothing in either `Duplicate/Delete` option and only duplicate
(right) is live.

All three actions are repeat-accumulating (scaling is exponential per
repeat, duplicate/delete is additive - one extra duplicate or one more
delete per repeat), so each combo throttles via its own accumulate-then-
fire accumulator (`shiftCtrlWheelAccumulator`/`altCtrlWheelAccumulator` -
kept separate so partial progress on one combo can't spill into the
other if you switch which modifiers are held mid-turn), each with its
**own independently configurable tick threshold** - **SHIFT+CTRL Wheel
Ticks** and **ALT+CTRL Wheel Ticks** (Timing category, default 16 each,
same range as "Loop Halve/Double Wheel Ticks") - rather than sharing one
setting between them, so each combo's sensitivity can be tuned on its
own (e.g. a higher tick count for `Duplicate/Delete` to make an
accidental trigger less likely, while keeping `Scale Clip Size`
responsive). Plain CTRL's clip/track-select stepping has its own
matching setting too - **CTRL Wheel: Clip/Track Select Ticks** (Timing
category, default 4, range 1-32) - previously shared with device-
stepping's `PLUGIN_DEVICE_STEP_MESSAGES`, now independent. This all
fires instead of on every raw wheel message, which would compound (or
delete) far too fast. SHIFT+CTRL replaced an earlier "jump to first/last
item" behavior (which worked, but this was requested instead) - those
actions are no longer bound anywhere, freed
up if wanted again later. Both checked before the plain-CTRL branch so
neither is swallowed by it.

For anyone who'd rather manage one shared default than tune all three
separately, **Use Global Wheel Ticks** (Timing category, off by default)
overrides all three of the settings above with a single **Global Wheel
Ticks** count (Timing category, default 16, range 1-64) once switched on -
`applyWheelTickSettings()` re-derives `CLIP_SELECT_STEP_MESSAGES`/
`SHIFT_CTRL_WHEEL_THRESHOLD`/`ALT_CTRL_WHEEL_THRESHOLD` from either the
global value or each combo's own individual setting depending on this
toggle, called from every one of the five settings' observers so flipping
it (or changing any value while it's on) takes effect immediately. The
three individual settings stay visible and adjustable in the panel while
the toggle is on - they're just not the ones in effect - so switching it
back off picks up right where each one was left, nothing reset. Doesn't
touch **Loop Halve/Double Wheel Ticks** (OPTION + Jog Wheel's own
setting, predates this round's independently-configurable-ticks request
and covers a different gesture) - only the three CTRL-combo settings.
Not yet tested on hardware.

**CTRL + Jog Wheel** (outside `MODE_DEVICE`, where it still steps devices
as before) now selects the next/previous arranger clip/item instead of
its previous job, nudging the project tempo - via Bitwig's real "Select
Next Item"/"Select Previous Item" actions (ids `"Select next item"`/
`"Select previous item"`, confirmed from `bitwig-actions-reference.txt`),
throttled once every **CTRL Wheel: Clip/Track Select Ticks** (default 4)
wheel messages - its own dedicated setting, no longer shared with
device-stepping's `PLUGIN_DEVICE_STEP_MESSAGES`. Repurposed per request -
**tempo nudging no longer has a jog-wheel binding** (CTRL+ALT no longer
means "fine tempo nudge" either, since there's no longer a continuous
nudge to make fine - CTRL+ALT+wheel is now its own separate combo, see
above, no longer swallowed into plain CTRL's behavior). **Confirmed
working on hardware** - steps between arranger clips
when one is selected; falls back to stepping between tracks (above/
below) when nothing's selected, which is real Bitwig behavior from the
same action, not something this script special-cases, and confirmed to
be a liked side effect ("gives freedom to move around the arrangement").
Note this is a different thing from CHANNEL PREV/NEXT (notes 48/49) + CTRL,
which still independently nudges
tempo when this hardware's own CHANNEL wheel-assignment mode is active
(see case 48/49) - untouched, since that's a separate firmware-level
input path, not the plain jog wheel.

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

**ALT + Jog Wheel Press** (push the wheel down while holding ALT) runs
Bitwig's real `select_item_at_cursor` action ("Select item at cursor" -
same one the Function Keys dropdowns offer, see `FKEY_FUNCTIONS`) - the
wheel press itself acts as the "click", so nothing needs an actual mouse
click first. The check only tests `isAltPressed` (not caring whether
SHIFT is also held), so it doubles as the first step of the SHIFT+ALT
clip-drag gesture below - the same press works whether you're holding
just ALT or SHIFT+ALT. Takes priority over the wheel-press's other use
(launching the selected scene in `MODE_SCENE`) when ALT is held. Not yet
tested on hardware.

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
action as ALT + Jog Wheel Press above - **confirmed on hardware NOT to do
that**. So "cursor" in that action's name is the generic UI keyboard-focus
reading, not the arranger edit cursor/playhead - it just repeats the
ALT-press behavior. Left bound for now (harmless, if redundant with
ALT+press) since nothing better has replaced it yet; the SHIFT+CTRL
*turn* combo above (jump to first/last item) covers a related but
different need instead. If jump-to-playhead-clip is still wanted, it
needs a different real action or approach - not yet found one.

### Jog-wheel "mode" buttons (CURSOR / SCROLL / ZOOM / MASTER / MARKER /
NUDGE / BANK / CHANNEL, per the manual's "Multi-Purpose Jog Wheel Section")

Confirmed this session: most of these send **no MIDI message at all** when
pressed - they're purely local firmware state that changes what the jog
wheel itself sends when subsequently turned (e.g. the already-documented
BANK/CHANNEL quirk: while lit, turning the wheel sends repeated Note-On
46/47/48/49 instead of CC 60). ZOOM is the one confirmed exception - it
sends note 100 directly, same as the note 100 already bound above.

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

## Reverted / abandoned this session (for context, don't re-attempt without a new plan)

- **Encoder-click volume-to-dB reset** (three different implementation
  strategies, each broke something different on real hardware - wrong
  target value, broken automation recording, script freeze). Encoder click
  is pan-reset only now, deliberately.
- **Live fader-follow via manual `sendMidi()` from a value observer /
  `scheduleTask`** - never worked; superseded entirely by the `flush()`-
  polling approach described above, which does work.
