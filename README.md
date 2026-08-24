# Midiplus UP - Bitwig Controller Script

Custom Bitwig Studio controller extension for the Midiplus UP (MCU-protocol
DAW controller: 8 motorized touch-sensitive faders, 8 clickable rotary
encoders, RGB-backlit buttons, jog wheel).

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
- `MODE_DEVICE` - faders/encoders control the selected device's 8 remote
  control macros. Entered via PLUG-IN (note 43).
- `MODE_SCENE` - entered via the button printed B.T.A. on the old Live
  overlay (note 80): shows the clip launcher, switches Bitwig to the Mix
  panel layout, and the jog wheel selects/launches scenes instead of its
  usual transport scrub.

FLIP (note 50) swaps faders and encoders between volume and pan (or, in
`MODE_DEVICE`, between device macros and volume) within whichever mode is
active.

### LCD / meters / LEDs

Standard MCU SysEx: `F0 00 00 66 14 12 <offset> <ASCII...> F7` for the two
56-character text rows (`renderLCDDisplays()`), `F0 00 00 66 14 20 <strip>
<mode> F7` (mode=3) to enable per-channel metering, and metering level sent
as Channel Pressure (status `0xD0`, always MIDI channel 1, one data byte
packing `(stripIndex<<4)|level`) - all cross-checked against Ableton's own
`ChannelStrip.py`. Button LEDs are plain Note On/Off (`midiOut.sendMidi(
0x90, note, 127/0)`).

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
| 40 | TRACK / I/O | Toggle Track Inspector, or switch to Mixer mode |
| 41 | SEND | 3-state Sends mode toggle |
| 42 | PAN | Toggle `TRLVL` tool-device Gain/Pan control |
| 43 | PLUG-IN | Toggle Device mode (first device, opens panel) |
| 44 | EQ | No Bitwig equivalent - shows a popup only (was crashing before this session's fix) |
| 45 | INST | Select first track instrument / next device page |
| 46 | BANK PREV | Page track bank back (SHIFT = jump to first) |
| 47 | BANK NEXT | Page track bank forward (SHIFT = jump to last) |
| 48 | CHANNEL PREV | Nudge one channel back (CTRL = prev device / tempo down) |
| 49 | CHANNEL NEXT | Nudge one channel forward (CTRL = next device / tempo up) |
| 50 | FLIP | Swap faders/encoders |
| 51 | RETURNS | Swap channel strips to/from the Return Tracks bank |
| 52 | NAME/VALUE | Unbound (no Bitwig equivalent) |
| 53 | SMPTE/BEATS | Pure mode key, deliberately unbound - toggles the F1-F8 row's backlight red/green (and which note range F1-F8 sends) entirely in hardware firmware; no longer bound to Automation Write |
| 54-61 | F1-F8 (red state) | Unbound - 8 function-key slots awaiting assignment |
| 62-69 | F1-F8 (green state) | Unbound - 8 more function-key slots awaiting assignment |
| 70-73 | SHIFT / OPTION / CTRL / ALT | Modifier hold state |
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

1. **16 F-key slots need assignment.** The Ableton Live overlay foil is
   back on for the main/left button area (so those buttons are referred to
   by their Live-overlay labels again, per the table above), but the top
   F1-F8 overlay strip has been left off deliberately - those 8 keys are
   meant to become general-purpose function buttons. Confirmed this
   session: SMPTE/BEATS (note 53) is *not* bound to anything in Bitwig
   anymore (previously toggled Automation Write - removed per request, see
   git history) - pressing it is now purely a hardware-local mode toggle
   that flips the F1-F8 row's backlight red/green and which of two note
   ranges F1-F8 sends (red = 54-61, green = 62-69, confirmed via console
   testing) - giving 16 independent, currently-unbound function-key slots.
   Still need: what should each of the 16 actually trigger?
2. **Metering re-enabled but not re-tested this session** - it was
   disabled for several sessions while diagnosing the (unrelated) fader
   bug; restored to its intended state (`mode=3` SysEx + Channel Pressure
   send) as part of a cleanup pass, but worth confirming the LCD/LED
   meters still behave correctly now that faders work again.
3. Debug logging (`RAW Note-On received`, `RAW CC received`, `Button
   pressed - Note:`) is still left in intentionally - useful while wiring
   up the F1-F8 slots (item 1). Fine to remove once that's done.

## Reverted / abandoned this session (for context, don't re-attempt without a new plan)

- **Encoder-click volume-to-dB reset** (three different implementation
  strategies, each broke something different on real hardware - wrong
  target value, broken automation recording, script freeze). Encoder click
  is pan-reset only now, deliberately.
- **Live fader-follow via manual `sendMidi()` from a value observer /
  `scheduleTask`** - never worked; superseded entirely by the `flush()`-
  polling approach described above, which does work.
