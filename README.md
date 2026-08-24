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
  3-state toggle via the SEND button (note 41): sends 1-8 -> sends 9-16 ->
  back to Mixer.
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
(including closing a Device-mode plugin window it's leaving, and
resetting `sendBankPage`/`isToolVolumeMode` on entry) and then calls
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
`None`, plus every key of `FKEY_FUNCTIONS` in the code (currently 38
entries: `Duplicate`/`Cut`/`Copy`/`Paste`/`Delete`/`Rename`/`Select All`/
`Select None`/`Undo`/`Redo`/`Consolidate`, all 22 of Bitwig's own
**Editing** category actions, all 11 of its **File** category actions,
`Select item at cursor` from its **Selection** category, and
`Click button` from its **General** category (a keyboard-focus click -
activates whatever UI element currently has focus, not a mouse-position
click) - see `bitwig-actions-reference.txt` for the full names).
Defaults: F1 =
`Duplicate`, F2 = `Consolidate`, F3-F8 = `None`.

Every press shows the action name **twice**: as a Bitwig on-screen popup
(`host.showPopupNotification`, same as the orange state's `Device N`
popup) *and* as a momentary LCD popup on that F-key's own channel strip
(`showBottomRowPopup`, truncated to 7 characters like every other LCD
popup, then reverting to normal track info after the usual timeout) - so
it's visible both on-screen and on the hardware which function just ran.

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

### Mixer settings (Controller Preferences panel)

Bitwig Studio -> Settings -> Controllers -> this controller -> Preferences
-> **Mixer** category. **Pan Snap to Center** (on/off, default ON) - the
pan encoders have no physical detent, so landing exactly on dead center by
turning alone is fiddly; once the encoder comes to **rest** (no further
tick for **Pan Snap Idle Delay (ms)**, default 300) within **Pan Snap
Range (+/- %)** (default 2%, range 0-10%) of exact center, it snaps the
rest of the way there (`target.set(0.5)`) instead of leaving it at
whatever the last increment produced. Mixer mode only (real track pan and
`TRLVL`'s Pan macro when `isToolVolumeMode` is active - both centered at
the normalized value 0.5) - deliberately **not** applied to `MODE_DEVICE`
remote-control macros, which have no guaranteed center value to snap to,
or to `MODE_SENDS` levels. Doesn't replace the existing encoder-push pan
reset (note 87/case in `handleButtonPress` - "Pan only - centers the pan,
nothing else") - that's still there as an exact, always-available reset;
this just makes turning the encoder itself land on center more often,
without needing the separate push. Turn the range down to 0% to disable
snapping without touching the on/off toggle, or use the toggle directly.

Went through two earlier designs that both failed on hardware before
landing on the idle-based one above:

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
what actually matters is where the pan ends up once you stop turning.
`schedulePanSnapCheck()` re-arms a `host.scheduleTask()` check on every
tick (bumping a per-encoder generation token, same debounce pattern
`revealPanTemporarily()` already uses for the bottom-row LCD reveal, so
only the LAST scheduled check for a turn ever actually runs) and only
evaluates the resting value once nothing has moved that encoder for
**Pan Snap Idle Delay (ms)** - sidestepping both the trapping and the
overshoot-past-the-zone problem, since it no longer matters how big or
small each individual MIDI message's step was. Not yet tested on
hardware since this redesign.

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
| 41 | SEND | 3-state Sends mode toggle |
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
| 82 | (Live label: MARKER) | Add cue marker at playhead |
| 83 | (Live label: FOLLOW) | Toggle playback follow (SHIFT = toggle metronome) |
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
| 104-111 | Fader touch 1-8 | Not currently used for anything (logged only) |
| CC 16-23 | Rotary encoders 1-8 | Mode-dependent (pan/send/macro), SHIFT = fine adjust |
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
