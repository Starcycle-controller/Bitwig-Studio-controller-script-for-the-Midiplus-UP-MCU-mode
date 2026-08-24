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
actually changed get re-sent. Not yet tested on hardware - next step is
confirming it actually renders bars/beats/ticks (and isn't, say, off by
a digit or using the wrong CC range for this specific unit).

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

All three share one per-channel debounce mechanism (`lcdOverrideGeneration`)
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
| 62-69 | F1-F8 (green-lit state, toggled via SMPTE/BEATS) | Unbound - 8 more function-key slots awaiting assignment |
| 70-73 | SHIFT / OPTION / CTRL / ALT | Modifier hold state; standalone tap action is configurable, see Plugin Mode settings above |
| 74 | (Live label: SESS/ARR) | Toggle clip launcher / arranger view |
| 75 | (Live label: CLIP/FX) | Toggle device / clip view |
| 76 | (Live label: UNDO) | `application.undo()` |
| 77 | (Live label: BROWSER) | Toggle browser panel |
| 78 | (Live label: DETAIL) | Toggle note/automation editor panel |
| 79 | (Live label: REDO) | `application.redo()` |
| 80 | (Live label: B.T.A.) | Toggle `MODE_SCENE` |
| 81 | (Live label: DRAW) | Cycle the 6 arranger edit tools |
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
1. **Green-state F1-F8 (notes 62-69) still unassigned.** The red/orange
   state (54-61) now selects device 1-8 directly. SMPTE/BEATS (note 53)
   toggles between the two states in hardware firmware only - it's not
   bound to anything in Bitwig itself (previously toggled Automation
   Write - removed per request, see git history).
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
