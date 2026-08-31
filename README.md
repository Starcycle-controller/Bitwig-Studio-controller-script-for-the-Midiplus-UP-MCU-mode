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
**Version indication:** `Starcycle + Claude + 3.0.0-native-faders` - shown
two places, both driven from the single `SCRIPT_VERSION` constant near the
top of the script: Bitwig's **Settings -> Controllers** list (the
Author column), and this script's own **Controller Preferences -> About ->
Version** field (more reliably visible while actually using the
controller). Check either after every reload to confirm Bitwig is running
the current file, not a stale cached copy - a version string that doesn't
match this document's is the tell.
**Bitwig action reference:** `bitwig-actions-reference.txt` - a complete,
human-readable dump of `application.getActionCategories()`/`getActions()`
(781 actions across 20 categories). Check here before guessing an action id
for `safeInvokeAction()`/`application.getAction()` instead of a fresh
diagnostic dump.

A printable PDF version of the Quick Start / usage sections below is at
`docs/MidiplusUP-User-Guide.pdf`. A one-page, large-print (16pt minimum)
cheat sheet meant to sit next to the controller is at
`docs/MidiplusUP-Quick-Reference.pdf`.

## Quick Start

**Intended use case**: this script turns the Midiplus UP (in standard MCU
mode) into a dedicated Bitwig mixing and gain-staging control surface for a
**single unit** (8 channel strips + a master strip, not a multi-unit MCU
array) - motorized-fader control of track Volume/Pan, encoder control of
device macros/sends, jog-wheel navigation of the timeline/scenes/clips, and
a set of quality-of-life extras (fader snap points, automation-mode
cycling, whole-project mixer snapshots, auto-banking) layered on top of
Bitwig's native MCU protocol.

### One-time setup

> **Takeover Mode doesn't matter for the Midiplus UP itself - set it based
> on your other gear.** Bitwig's **Takeover Mode** preference (Settings ->
> Controllers, top of the page - Pick Up (Catch) / Jump (Immediate) / Value
> Scaling) is a Studio-wide setting that applies to every connected
> controller at once - **but this script never uses Bitwig's own
> HardwareControl binding system for anything except the 8 faders**, and
> every one of those explicitly opts out of Takeover Mode already
> (`disableTakeOver()` - the motor drives the fader to match the real value
> directly, so there's nothing to catch up on). Every other control on this
> hardware (encoders, buttons, the jog wheel) is read as raw MIDI and
> written straight to Bitwig parameters by this script's own code, which
> never goes through Bitwig's binding/Takeover pipeline at all. **Net
> result: whatever you set Takeover Mode to, it changes nothing about how
> the Midiplus UP behaves.**
>
> So pick it based on your *other* connected controllers, if you have any,
> since it's Studio-wide - there's no confirmed way in Bitwig 6.1 to scope
> it to just one controller (Bitwig's own documentation describes a
> per-controller override icon, but it isn't reachable in the actual 6.1
> Controllers panel - already reported to Bitwig, see
> `BITWIG-API-FEATURE-REQUESTS.md` #12). As a general rule for other
> gear: **Pick Up (Catch)** is the safer default for any non-motorized
> knob/fader/pad controller (no accidental value jumps when a physical
> control's position doesn't match the software value); **Jump
> (Immediate)** trades that safety for instant response, which only really
> makes sense on a motorized controller that keeps its own physical
> position in sync automatically - exactly what this script's own faders
> already do internally, independent of this setting either way.

1. In Bitwig, go to **Settings -> Controllers**, add this script, and
   confirm the Midiplus UP is switched to standard **MCU mode** (hardware
   manual sections 3.3/8) - not a Live/Cubase/Logic "customized" mode.
2. After loading, check that Bitwig's Controllers panel (or Controller
   Preferences -> About -> Version) shows the version string above - an
   older string means Bitwig is still running a cached copy of a previous
   version of the script.
3. **Leave the plastic Ableton Live overlay's left and right pieces
   attached, but remove only its top piece.** This matters for reading the
   button map below without confusion: buttons under the **top** piece show
   their real, printed MCU labels (TRACK/IO, SEND, PAN, PLUG-INS, RETURNS,
   BANK/CHANNEL, F1-F8, the modifiers, the jog wheel section, transport) -
   those are the labels this document and the button map use. Buttons under
   the **left and right** pieces still show old Live-mode stickers (SESS/ARR,
   CLIP/FX, BROWSER, DETAIL, LOOP, PUNCH OUT, HOME, END, ...) that have
   nothing to do with what the button actually does in this script -
   wherever the button map below says **"(Live label: X)"**, that's this
   case: ignore the sticker, the Bitwig behavior in that row is what
   actually happens. Confirmed on hardware that switching the unit between
   Live mode and standard MCU mode doesn't change any button's note number
   either way - only local LED/display behavior differs - so this mapping
   holds regardless of which overlay pieces happen to be on.
4. **For the PAN / gain-staging mode** (see the mode table below): on any
   track you want to control this way, add a device named exactly
   **`TRLVL`** (case-sensitive, no other text) to its chain. Bitwig's
   built-in **Tool** device (browser category **Audio FX**) is the natural
   fit - its first two native parameters are already Gain and Pan, which is
   exactly what this script expects to find at that device's first Remote
   Controls page. If you press PAN on a track with no such device yet, the
   script opens the browser at the end of that track's chain automatically
   so you can add one in a couple of clicks.

### Modes at a glance

| Mode | How to enter | What the faders/encoders control |
|---|---|---|
| **Mixer** (default) | TRACK/IO button, or leaving any other mode | Faders: track Volume. Encoders: track Pan. FLIP swaps faders/encoders between the two. |
| **Sends** | SEND button (cycles Sends 1-8 -> 9-16 -> back to Mixer, or 1-8 <-> Mixer if **Send/Return Bank Size** = 8); SHIFT+SEND jumps straight to Sends 9-16 | Faders/encoders: the selected track's send levels. |
| **Device / Plugin** | PLUG-INS button, or F1-F8 (default orange state, selects device 1-8 directly and opens its window) | Encoders: always the 8 device Remote Control macros. Faders: Volume by default, the same 8 macros once FLIP is on. |
| **Gain-Staging (Tool Volume)** | PAN button, toggle - a sub-mode of Mixer | Faders/encoders: the Gain/Pan of that track's `TRLVL` device instead of its own Volume/Pan - requires the setup step above. |
| **Returns** | RETURNS button | Same as Mixer/Sends, but the 8 channel strips are the Return tracks instead of Main tracks. |
| **Scene** | B.T.A. button | Shows the clip launcher and switches Bitwig to the Mix panel layout; the jog wheel selects/launches scenes instead of scrubbing the timeline. |

Every mode-changing button fully resyncs the mode LEDs, LCD text,
channel-strip LEDs, and fader/encoder bindings together in one step
(`applyModeChange()`), and automatically closes a Device-mode plugin window
when leaving that mode - so jumping directly between any two modes always
lands in one consistent state.

### Modifier buttons at a glance

SHIFT / OPTION / CTRL / ALT (the four buttons directly under the F-keys)
are held modifiers for most of what this controller does - encoder turns,
jog-wheel turns, and some button taps all change behavior depending on
which is held. A quick tap-and-release of any of them (without using it to
modify anything else) also has its own configurable standalone action -
see **Plugin Mode settings** below. Broad strokes (full matrix under **Jog
Wheel Modifier Combos** and **Confirmed Button Map** below):

> Every SHIFT/OPTION/CTRL/ALT + jog-wheel combo also requires the
> hardware's own wheel-mode selector to be set to **SCROLL** - see the
> warning at the top of **Jog Wheel Modifier Combos** below.

- **SHIFT** - stepped/coarser adjustment on encoders; jump-to-start/end on
  bank scrolling; "store" actions (Mixer Snapshots, F-key green state) and
  the automation-write-enable toggle on DRAW.
- **OPTION** - loop-length halve/double on the wheel; "recall" actions
  (Mixer Snapshots) and hover-lock for last-clicked-parameter adjustment.
- **CTRL** - the most-used combo modifier: steps devices, steps clip/track
  selection, and combines with SHIFT/ALT for clip/track duplicate-or-delete
  gestures.
- **ALT** - fine-resolution adjustment on encoders/faders; adjusts the
  last-clicked Bitwig GUI parameter via the wheel; combines with F8 for the
  Fader Position Test.

### Where everything else is documented

- **Full button-by-button map**: see **Confirmed Button Map** below.
- **Every jog-wheel modifier combo, in detail**: see **Jog Wheel Modifier
  Combos** below.
- **Every configurable setting**, grouped by its Controller Preferences
  category: see **Features & Settings** below.
- **Engineering history, dead ends, and hardware-debugging findings**
  (useful for extending this script, not needed just to use it): see
  **Development Notes & Findings** at the very bottom.

---

## Modes in Detail

- `MODE_MIXER` (default) - faders/encoders control track volume/pan (or a
  `TRLVL` tool device's Gain/Pan, if Gain-Staging mode is active - PAN
  button, note 42).
- `MODE_SENDS` - faders/encoders control the focused track's sends. Toggle
  via SEND (note 41): sends 1-8 -> 9-16 -> back to Mixer by default, or
  1-8 -> Mixer directly if **Send/Return Bank Size** (Mixer settings below)
  is `8`. SHIFT+SEND always jumps straight to sends 9-16 regardless of
  that setting.
- `MODE_DEVICE` - encoders **always** control the selected device's 8
  Remote Control macros, regardless of FLIP. Faders control track volume by
  default and swap to the macros when FLIP is on (press again to revert) -
  FLIP only affects the faders in this mode, not the encoders. Entered via
  PLUG-INS (note 44), or via F1-F8 in their default/orange state (notes
  54-61), which also jump directly to device 1-8 on the chain and open its
  plugin window. Pressing the SAME F-key again for the already-selected
  device toggles its window closed/open instead of reselecting it; pressing
  a *different* F-key selects that device and opens its window. **In
  `MODE_MIXER` or `MODE_SCENE` specifically**, an F-key that's been given
  a Mixer Layout Preset/Toggle assignment (see **Mixer Layout Presets &
  Toggles** in Mixer settings below) does that instead of selecting a
  device - opt-in per key, so an unconfigured F-key keeps this exact
  device-select behavior even in those two modes. Covers `MODE_SCENE` as
  well as `MODE_MIXER` deliberately - `MODE_SCENE` is the one mode that
  actually guarantees Bitwig's Mixer panel is on screen (see below), so
  scoping this to `MODE_MIXER` alone would only fire in a mode where the
  mixer might not even be visible.
- `MODE_SCENE` - entered via B.T.A. (note 79): shows the clip launcher,
  switches Bitwig to the Mix panel layout, and the jog wheel
  selects/launches scenes instead of scrubbing. A second B.T.A. press
  exits back to `MODE_MIXER`, hides the clip launcher again, and switches
  back to the Arrange panel layout - this really is B.T.A.'s own way back
  to the Arranger view, and forcing it on exit is deliberate (a brief
  attempt at removing it, reasoning it fought against Mixer Layout
  Presets/Toggles needing the Mixer panel visible, broke that expected
  workflow on hardware and was reverted - Mixer Layout Presets/Toggles now
  covers `MODE_SCENE` directly instead, so there's no need to leave
  B.T.A.'s mode just to use them). **Known minor gap, not yet fixed:**
  leaving `MODE_SCENE` via a *different* button than B.T.A. (e.g. pressing
  TRACK/IO or PLUG-INS directly while still in Scene mode) skips the
  clip-launcher-hide entirely, since it only runs inside B.T.A.'s own
  toggle-off branch - the clip launcher can stay visibly on screen after
  switching modes that way. Cosmetic (doesn't affect fader/encoder
  behavior), but worth fixing by centralizing it in `applyModeChange()` if
  it turns out to bother anyone in practice. SHIFT+wheel and/or CTRL+wheel
  can each optionally also move track selection without disturbing the
  current scene row - see **Scene Mode: SHIFT+Wheel Selects** / **Scene
  Mode: CTRL+Wheel Selects** in Mixer settings below.

FLIP (note 43) swaps faders and encoders between volume and pan in
`MODE_MIXER`, and faders only between volume and macros in `MODE_DEVICE`.

---

## Confirmed Button Map

Live-tested against real hardware in MCU mode (pressing every button and
reading the console's `RAW Note-On received` log). Switching the hardware
between Live mode (with the overlay) and standard MCU mode did **not**
change any button's note number - only local-firmware LED behavior differs
between modes, so this map holds in either.

| Notes | Function | Bitwig behavior |
|---|---|---|
| 0-7 | Rec Arm 1-8 (SEL row while the standalone REC button, bottom-left, is toggled on) | `track.arm().toggle()` |
| 8-15 | Solo 1-8 | `track.solo().toggle()` |
| 16-23 | Mute 1-8 | `track.mute().toggle()` |
| 24-31 | Select 1-8 (double-press folds/unfolds a group track) | `selectInMixer()` / `isGroupExpanded().toggle()` |
| 32-39 | Encoder push-click | Center pan (Mixer) / reset send (Sends) / Device: hold + turn = fine resolution, or reset macro, or open/close plugin window - see Encoder Push Behavior |
| 40 | TRACK/IO | Toggle Track Inspector, or switch to Mixer mode |
| 41 | SEND | Sends mode toggle, 2 or 3 states depending on Send/Return Bank Size (SHIFT = jump straight to Sends 9-16) |
| 42 | PAN | Toggle `TRLVL` tool-device Gain/Pan control (Gain-Staging mode) |
| 43 | FLIP | Swap faders/encoders between volume and pan (Mixer) or volume and macros (Device) |
| 44 | PLUG-INS (SHIFT = EQ Mode) | Toggle Device mode (first device, opens panel; second press also closes it). SHIFT+PLUG-INS jumps to the last EQ in the chain; pressed again while already there, exits to Mixer - see EQ Mode below |
| 45 | RETURNS | Swap channel strips to/from the Return Tracks bank |
| 46 | BANK PREV | Page track bank back (SHIFT = jump to first) |
| 47 | BANK NEXT | Page track bank forward (SHIFT = jump to last) |
| 48 | CHANNEL PREV | Nudge one channel back (CTRL = prev device / tempo down) |
| 49 | CHANNEL NEXT | Nudge one channel forward (CTRL = next device / tempo up) |
| 50 | UNDO | `application.undo()` |
| 51 | REDO | `application.redo()` |
| 52 | NAME/VALUE | Unbound (no Bitwig equivalent) |
| 53 | SMPTE/BEATS | Pure hardware mode key - toggles the F1-F8 row's backlight and note range in firmware only; not bound to anything in Bitwig |
| 54-61 | F1-F8 (default/orange-lit state) | Select device 1-8 directly on the current track (enters `MODE_DEVICE` if needed) and open its window; pressing the already-selected device's key again toggles its window instead. In `MODE_MIXER`, a key with a Mixer Layout Preset/Toggle assigned does that instead - see Mixer settings below |
| 62-69 | F1-F8 (green-lit state, toggled via SMPTE/BEATS) | Configurable editing function per key, see Function Keys settings below (defaults: F1=Duplicate, F2=Consolidate, F3-F8=None) |
| 70-73 | SHIFT / OPTION / CTRL / ALT | Modifier hold state; standalone tap action is configurable, see Plugin Mode settings below |
| 74 | (Live label: SESS/ARR) | Toggle the Mix (Session-style) / Arrange panel layout - reads `application.panelLayout()` to know which way to switch, rather than assuming |
| 75 | (Live label: CLIP/FX) | Toggle device / clip view |
| 76 | DRAW | Plain: cycle the automation write mode (Latch -> Touch -> Write). SHIFT: toggle Arranger Automation Write on/off. OPTION: show/hide automation lanes. See **Automation and mode switches** below |
| 77 | (Live label: BROWSER) | Toggle browser panel |
| 78 | (Live label: DETAIL) | Toggle note/automation editor panel |
| 79 | B.T.A. (ALT+B.T.A. = toggle metering plugin window) | Toggle `MODE_SCENE`; ALT+press toggles the Master Wheel metering plugin's window, independent of mode - see Master Wheel below |
| 80 | Unconfirmed | Unbound - needs testing |
| 81 | Unconfirmed | Unbound - needs testing |
| 82 | PAGE (left arrow) | `MODE_DEVICE`: page macro bank back. `MODE_MIXER`: jump to previous cue marker and move the loop to follow it - see Mixer Mode PAGE below |
| 83 | PAGE (right arrow) | `MODE_DEVICE`: page macro bank forward. `MODE_MIXER`: jump to next cue marker and move the loop to follow it |
| 84 | - | Jump to previous cue marker |
| 85 | - | Jump to next cue marker |
| 86 | (Live label: LOOP) | Toggle arranger loop |
| 87 | Unconfirmed | Unbound - needs testing (see Jog-wheel notes below) |
| 88 | (Live label: PUNCH OUT) | Toggle punch-out (CTRL = set loop end from playhead) |
| 89 | (Live label: HOME), SHIFT = add "Bar N" cue marker | Jump playhead to project start; SHIFT+HOME adds a cue marker at the current position, auto-named for its bar number |
| 90 | (Live label: END) | Jump playhead to loop start |
| 91-95 | Transport: REWIND/FF/STOP/PLAY/RECORD | Standard transport |
| 96 | Cursor UP | Arrow key up, or zoom in track height (while ZOOM/note 100 toggled) |
| 97 | Cursor DOWN | Arrow key down, or zoom out track height (while ZOOM toggled) |
| 98 | Cursor LEFT | Arrow key left, device select previous in `MODE_DEVICE`, or zoom out timeline (while ZOOM toggled) - see Zoom below |
| 99 | Cursor RIGHT | Arrow key right, device select next in `MODE_DEVICE`, or zoom in timeline (while ZOOM toggled) - see Zoom below |
| 100 | ZOOM | Toggle zoom mode for cursor arrows |
| 101 | Jog wheel push | Momentary "Pan Mode" hold; ALT+press = select item at playhead; SHIFT+CTRL+press = same, one-shot; launches selected scene in `MODE_SCENE` |
| 104-111 | Fader touch 1-8 | Optionally selects that channel's track, see Mixer settings below |
| 112 | Fader touch (Master) | Optionally selects the master track - **not confirmed to fire on this 8-fader unit**, see the wheel note below |
| CC 16-23 | Rotary encoders 1-8 | Mode-dependent (pan/send/macro); SHIFT = stepped or fine adjust, see Encoders settings below |
| CC 60 | Jog wheel | Arranger scrub, or bar/loop/tempo nudge with modifiers held, or scene navigation in `MODE_SCENE` |
| Pitch bend ch 0-7 / 8 | Faders 1-8 / Master | Motorized fader input/output - **channel 8 (Master) is supplied by the jog wheel under MASTER mode on this unit, not a separate physical fader** - see the Jog-Wheel "Mode" Buttons section below |

This hardware also has its own local "mode" buttons for the jog wheel
(CURSOR / SCROLL / ZOOM / MASTER / MARKER / NUDGE / BANK / CHANNEL, per the
manual's "Multi-Purpose Jog Wheel Section"). Most send no MIDI at all -
they're purely local firmware state that changes what the wheel itself
sends when subsequently turned. Confirmed behavior per mode:

| Mode | Mode button itself | Wheel click | Wheel turn |
|------|---------------------|-------------|------------|
| SCROLL (base/default) | No MIDI at all | Note 101 | CC 60 (normal scrub) |
| ZOOM | Note 100 (toggle) | Nothing | Note-On 96/97 (up/down) or 98/99 (left/right) - see Zoom settings below |
| MARKER | No MIDI at all | Nothing | Note-On 84/85 - jumps to previous/next cue marker, already bound above |
| BANK | Note 46/47 (also its own PREV/NEXT press action) | Nothing | Note-On 46/47 - already bound above |
| CHANNEL | Note 48/49 (also its own PREV/NEXT press action) | Nothing | Note-On 48/49 - already bound above |
| MASTER | No MIDI at all | Not yet tested | **Pitch-bend, channel 9** - already bound above (see the Master fader note below) |

(CURSOR and NUDGE modes not yet tested.)

**This unit has no separate physical master fader - MASTER mode substitutes
the wheel for one.** Confirmed via an independent OS-level MIDI monitor
(`receivemidi`, bypassing this script entirely) while turning the wheel
with MASTER engaged: it sends absolute pitch-bend on MIDI channel 9 -
exactly the channel `hwMasterFader` was already bound to
(`createAbsolutePitchBendValueMatcher(8)`, 0-indexed -> real channel 9 ->
`masterTrack.volume()`), written assuming a literal 9th physical fader.
That binding was already picking this up correctly and driving Bitwig's
master track volume as designed - nothing was broken, the "9th fader" was
just the wheel-under-MASTER-mode all along on this particular unit. This
also explains why nothing showed in this script's own console while
testing: pitch-bend claimed by a native `HardwareControl` binding is
consumed entirely by Bitwig's binding pipeline and never reaches this
script's `onMidi()` handler at all, the same reason the 8 track faders'
own motor input never appears in the raw MIDI log either. Since this
finding, MASTER mode's gesture can optionally be repurposed to open/close
a metering plugin's window instead of touching master volume at all - see
**Master Wheel** below.

---

## Jog Wheel Modifier Combos

> **All of this requires the hardware's own wheel-mode selector to be set
> to SCROLL** (the base/default mode - see **Jog-Wheel "Mode" Buttons**
> above). The physical jog wheel only sends CC 60 (the message every combo
> below is built on) while that local firmware mode is active - switch it
> to ZOOM, MARKER, BANK, or CHANNEL and the wheel repurposes its MIDI
> output entirely (Note-On messages instead of CC 60), so none of the
> combos below will fire at all, with no error or feedback to explain why.
> If a wheel combo suddenly "stops working," check the wheel-mode selector
> first.

In priority order (each returns before the next is checked, so only one
applies per turn): `MODE_SCENE` active (move the scene cursor) >
**SHIFT+CTRL** (configurable) > **ALT+CTRL** (configurable) > **CTRL
alone** (device mode: step devices; otherwise: select next/previous
arranger clip/item) > **SHIFT+ALT** (nudge the selected arranger item) >
**ALT alone** (adjust the last-clicked GUI parameter) > PLUG-INS held (step
devices) > BANK held (page remote-control pages) > OPTION alone
(halve/double loop length) > SHIFT alone (shift loop by a bar) > default
(scrub by whole bars).

### SHIFT+CTRL and ALT+CTRL + Jog Wheel (turn)

Each independently runs whichever action its own Controller Preferences
dropdown is set to (**SHIFT+CTRL Wheel Action** / **ALT+CTRL Wheel
Action**, Function Keys category) - freely invertible, both offer the same
5 options:

- `Scale Clip Size` - right doubles the selected clip's content, left
  halves it.
- `Duplicate/Delete Clip` - right duplicates the selection, left deletes
  it.
- `Duplicate Clip` (**SHIFT+CTRL's default**) - right duplicates; left is
  **always** a no-op, ignoring the delete kill switch below.
- `Duplicate/Delete Track` (**ALT+CTRL's default**) - right duplicates the
  current track, left deletes it.
- `Duplicate Track` - right duplicates the current track; left is always a
  no-op.

Turning left in either `Duplicate/Delete` option is gated by **Wheel
Combos: Allow Delete (Turn Left)** (default ON, Function Keys category) -
off, turning left does nothing and only duplicate (right) is live. The
plain `Duplicate Clip`/`Duplicate Track` options never need that toggle,
since turning left there is always a no-op by design.

Each combo accumulates ticks before firing (scaling is exponential per
repeat for Scale Clip, additive for duplicate/delete), with its own
independently configurable threshold - **SHIFT+CTRL+Wheel: Ticks to Scale
Clip / Duplicate / Delete** and **ALT+CTRL+Wheel: ...** (Wheel Options
category, default 16 each). **Override Wheel Combo Thresholds** (Wheel
Options category, off by default) replaces all three CTRL-combo thresholds
(these two plus plain CTRL's own, below) with one shared **Global Tick
Threshold (All Combos)** (default 16) when switched on.

### CTRL + Jog Wheel (turn, outside Device mode)

Selects the next/previous arranger clip/item, via Bitwig's `"Select next
item"`/`"Select previous item"` actions, throttled by **CTRL+Wheel: Ticks
to Move to Next/Prev Clip or Track** (Wheel Options category, default 4).
With a clip selected, steps between clips on that track; with nothing
selected, steps track-to-track instead (including through expanded
automation lanes, since it's real Bitwig Arranger navigation). This is the
only action in the "select next/previous" family confirmed to actually
move the Arranger clip selection - see **Development Notes & Findings**
below for the other candidates that were tried and don't work.

> **You have to click a clip with the mouse first to step between clips
> with this combo.** There is currently no button/wheel gesture on this
> hardware that can select ("anchor") a clip from nothing - every generic
> Bitwig action tried for that (`select_item_at_cursor`, "Select item to
> left/right", "Select item above/below", `move_selection_cursor_to_next/
> previous_item`, "Move selection cursor left/right") was confirmed on
> hardware to do nothing at all. Once a clip is selected by clicking it,
> CTRL+Wheel reliably steps to the next/previous one from there - it just
> can't establish that starting point on its own. See API Feature Request
> #1 in `BITWIG-API-FEATURE-REQUESTS.md`.

In `MODE_DEVICE`, CTRL + Jog Wheel instead steps through devices on the
current chain.

Note this is different from CHANNEL PREV/NEXT (notes 48/49) + CTRL, which
independently nudges tempo when this hardware's own CHANNEL wheel-
assignment firmware mode is active - a separate input path from the plain
jog wheel.

### OPTION + Jog Wheel

Halves (turn left) or doubles (turn right) the arranger loop length,
accumulated via **OPTION+Wheel: Ticks to Halve/Double Loop Length**.
Capped at 256 bars doubling; floored at 1 whole bar halving.

### ALT + Jog Wheel

Adjusts whatever parameter was last clicked in Bitwig's own GUI - click any
knob/slider/fader once in Bitwig, then hold ALT and turn the wheel to dial
it in without touching the mouse again. Shows the parameter's name as a
Bitwig popup on every turn - or **"No Parameter (click a Bitwig control
first)"** if nothing valid was ever clicked (or the clicked GUI element
isn't a real Parameter at all - see below), instead of a confusing blank
popup.

**Scope limitation, hardware-confirmed:** this only works for values that
are genuine Bitwig `Parameter` objects (device/mixer knobs, sends, macros,
and similar) - it does **not** work for every visually-editable field in
Bitwig's GUI. Confirmed on hardware for **both** an audio clip's
fade-length field **and** its Inspector-panel "Expressions" values (base
Gain/volume, Tuning/transpose) - clicking either, then using ALT+Wheel, has
no effect, and the popup comes back completely empty (now shown as "No
Parameter" - see above) - meaning `host.createLastClickedParameter()`
never resolved the click to anything at all, not just that the resulting
value failed to move. The whole family of clip/audio-event-level static
properties shown in the Inspector appears to sit entirely outside Bitwig's
generic addressable-parameter system (consistent with API Feature Request
#11 - there's no audio-event API at all), unreachable through this
"whatever was last clicked" escape hatch no matter how reliably the
click/ALT themselves are registered. (This is separate from - and doesn't
imply anything about - genuine per-note Expression data on individual
notes within a MIDI/instrument clip's Detail/Note editor, which wasn't
tested; see Feature Request #11.) If a wheel turn doesn't move something
you clicked, this GUI-element scope gap - not a modifier detection issue -
is the most likely reason; see `BITWIG-API-FEATURE-REQUESTS.md` #11.

**ALT + Jog Wheel Press** (push the wheel while holding ALT, note 101)
attempts to select whatever's at the current GUI focus, via
`select_item_at_cursor` - the same action confirmed non-functional for
clip selection elsewhere in this document (see the CTRL+Wheel warning
above and **Development Notes & Findings** below), so **treat this as
likely not actually selecting anything** rather than a reliable click
substitute, until it's specifically retested and confirmed otherwise.

**SHIFT+ALT + Jog Wheel** nudges whatever's currently selected in the
arranger (a clip, automation point, etc.) left/right by one grid step per
message. The intended full gesture is: hold SHIFT+ALT, press the wheel to
select whatever's at the cursor, then keep holding and turn the wheel to
"drag" it - but given the press step's `select_item_at_cursor` call is
likely non-functional (see above), **click the item with the mouse first
to select it, the same as CTRL+Wheel above**, then hold SHIFT+ALT and turn
the wheel to nudge it - that part (the actual nudging) does work once
something is already selected.

**OPTION + Jog Wheel Press** toggles `LastClickedParameter.smartToggleLock()`
- locks the ALT+wheel parameter-adjust combo onto whatever parameter the
mouse is currently hovering over, without needing an exact click first.

### Default (no modifier) Jog Wheel

Always moves in whole bars, anchored on a bar start. **Wheel (No Modifier):
Playhead Jump per Tick (bars)** (Wheel Options category, default 1, range
1-8) sets how many bars per accumulated-tick threshold; **Wheel (No
Modifier): Ticks per Bar** (default 8, range 1-64) sets how many wheel
ticks reach that threshold. **Adaptive Wheel Scrub (Scale with Zoom)**
(default OFF) + **Adaptive Wheel Scrub: Pixels per Tick** (default 50)
optionally derives the bar count from the live Arranger zoom level instead
of the fixed setting, so a tick always covers roughly the same *visual*
distance regardless of zoom.

---

## Features & Settings (Controller Preferences)

All settings live under Bitwig Studio -> Settings -> Controllers -> this
controller -> Preferences, grouped into the categories below.

### Plugin Mode

All 4 modifier buttons (SHIFT/OPTION/CTRL/ALT) are always-available held
modifiers for their existing combos regardless of these settings - these
control each button's *standalone tap* action only (press and release
without using it to modify anything else):

- **Expanded Device View Button** (CTRL / ALT / OPTION / SHIFT / None,
  default **None**) - which button's tap toggles `cursorDevice.isExpanded()`.
- **Expanded Device View Trigger** (Long Press / Instant Tap, default Long
  Press).
- **Long Press Duration (Expanded Device View)** (200-2000ms, default
  500ms) - only relevant when Trigger is Long Press.
- **Expanded Device View Also Opens Plugin Window** (on/off, default ON) -
  when on, the tap also opens/closes the plugin window in lockstep, and
  switches into `MODE_DEVICE` if needed. When off, the tap only toggles the
  expanded-view flag and only does anything while already in `MODE_DEVICE`.
- **Macro Bank Cycle Button** (ALT / CTRL / OPTION / SHIFT / None, default
  ALT) - which button's tap calls `remoteControls.selectNextPage()`. If set
  to the same button as Expanded Device View, that button's tap always
  triggers Expanded Device View, never the macro cycle.
- **Close Other Plugin Windows** (on/off, default OFF) - when on, opening a
  device's plugin window first closes every *other* device's window on the
  current track's 8-slot chain.
- **EQ Device Name Keywords** (text, default `eq,pro-q`) - see **EQ Mode**
  below.

**EQ Mode** (SHIFT+PLUG-INS, note 44) - jumps straight to whichever EQ is
**last** in the selected track's chain, for a quick peek-modify-leave
workflow. Pressed again while that same EQ is already selected, exits back
to Mixer mode (same two-state toggle as PLUG-INS itself). `findLastEqDeviceIndex()`
scans a dedicated 32-device-deep bank and matches each device's name
against the comma-separated **EQ Device Name Keywords** list (default
`eq,pro-q`, leading-boundary match so it catches Bitwig's own EQ+/EQ-2/EQ-5
and FabFilter Pro-Q 3/4 without matching "Sequence"/"Note Sequencer"). If no
device matches, shows "EQ Mode: No EQ Found in Chain" and does nothing
else.

### Function Keys

F1-F8's green-lit state (notes 62-69, toggled by SMPTE/BEATS, note 53) is
configurable per-key via 8 dropdowns, **F1-F8 Function (Green State)**,
each offering `None` plus every entry in `FKEY_FUNCTIONS` (Duplicate/Cut/
Copy/Paste/Delete/Rename/Select All/Select None/Undo/Redo/Consolidate, all
22 of Bitwig's own **Editing** actions, all 11 of its **File** actions,
`Select item at cursor`, `Click button`, and `Add Cue Marker at
Playhead`/`Toggle Follow Playhead` - see `bitwig-actions-reference.txt` for
full names). Defaults: F1 = `Duplicate`, F2 = `Consolidate`, F3-F8 = `None`.
The orange state (54-61) still directly selects device 1-8, unaffected by
this.

Every press shows the action name as a Bitwig on-screen popup plus a brief
LCD popup on that key's own channel strip. Holding a key past **F-Key Hold
Threshold (ms)** (default 400, range 100-2000) reveals **all 8 F-keys'
assignments at once** on the LCD (`showAllFKeyAssignments()`) - a "what
could I press" reference for the whole row; unassigned keys show `-`.
**F-Key Popup Duration After Release (ms)** (default 300, range 0-2000)
keeps the hold-reveal up this much longer after release before reverting.

`warnIfDuplicateFKeyFunctions()` re-scans all 8 keys whenever one changes
and, if two end up with the same function, prints a console warning and
shows a Bitwig popup naming the collision - Bitwig's dropdown API has no
way to actually remove an already-picked option from the other 7, so this
is the closest available substitute.

Worth noting: `Quit` is a valid, real option here, and binding it to an
F-key means one wrong press quits Bitwig outright - no confirmation dialog
stands in the way of a script-invoked action.

**SHIFT+CTRL Wheel Action** and **ALT+CTRL Wheel Action** (also in this
category) - see **Jog Wheel Modifier Combos** above.

**Enable ALT+CTRL + Wheel (Duplicate/Delete Track)** (on/off, default ON) -
turns the whole ALT+CTRL+Wheel combo on or off. Off while still learning
the button/wheel combos and prone to catching ALT along with CTRL by
accident (e.g. reaching for plain CTRL+Wheel's clip/track-select stepping)
and unexpectedly duplicating or deleting a track. SHIFT+CTRL+Wheel is
unaffected either way (its own independent combo, no shared toggle). Off,
holding ALT+CTRL and turning the wheel simply falls through to plain
CTRL+Wheel's own behavior instead (select next/previous clip, or step
devices in Device mode) - ALT is just not checked for this combo anymore,
not a hard no-op.

**Wheel Combos: Allow Delete (Turn Left)** (on/off, default ON) - see
**Jog Wheel Modifier Combos** above.

### Zoom

**ZOOM+LEFT/RIGHT** (notes 98/99 while ZOOM/note 100 is toggled) does a
genuine relative horizontal zoom via `Arranger`'s `ScrollbarModel`
(`getContentPerPixel()`/`zoomAtPosition()`), centered on the current
playhead position. LEFT zooms out, RIGHT zooms in.

**ZOOM+Left/Right: Zoom Step (2^n per Press)** (default `1`, range
0.25-4) - how big a jump each press makes; `1` is a full double/halve.

**ZOOM+UP/DOWN** (notes 96/97 while ZOOM is toggled) adjusts vertical track
height (`zoomInLaneHeightsSelected()`/`zoomOutLaneHeightsSelected()`),
unrelated to the horizontal zoom above.

### Encoders

Applies to all 8 rotary encoders (CC 16-23), whatever they currently
control, via a single shared handler.

**Discrete/switch parameters** (anything with a real, native
`discreteValueCount()` up to `MAX_NATIVE_SWITCH_STEPS`, currently 16) always
step one native state per turn and pop up that state's real name,
regardless of every setting below - there's no meaningful "fine" or
"stepped-by-percent" adjustment on something with only a handful of real
states. Above that cap, a parameter falls through to the continuous
handling below instead.

For a genuinely continuous target, a **plain** turn is always smooth;
**SHIFT+turn**'s behavior is selectable via **SHIFT+Encoder Mode**:

- `Stepped` (**default**) - jumps in fixed **Encoder Step Size (%)**
  increments (default 10%, range 1-50%), landing exactly on round
  multiples.
- `Fine` - precise, 0.2x-scaled continuous adjustment instead.

**Encoder Acceleration (%)** (default 0 = off, range 0-100) - a continuous
dial mapping to an exponent from 1.0 (no curve) to 2.0 (strongest),
computed from a time-based velocity ratio (fast flicks accelerate more than
a slow turn producing the same raw tick count). Only scales the Fine/plain
continuous adjustment, never Stepped mode's fixed jumps.

**Allow Stepped Encoders While Recording Automation** (default OFF) -
Stepped mode normally falls back to Fine while Arranger Automation Write is
enabled, since recording abrupt stepped jumps into automation usually isn't
wanted; turn this on to keep Stepped mode active anyway.

**Auto-Detect Centered Macros by Name** (on/off, default ON) +
**Centered Macro Keywords** (text, default `pan,tune,fine,ftun,offset`) -
`getOrigin()` only reliably reports `0.5` for parameters Bitwig itself
classifies as pan-like; a genuinely bipolar plugin parameter wrapped in a
generic Macro slot (e.g. a synth's Fine Tune) often reports `0` instead.
`nameSuggestsBipolar()` does a word-boundary match of the macro's own
display name against this keyword list, and only then treats its origin as
`0.5` - deliberately word-boundary rather than substring, so `tune` matches
"Tune"/"Fine Tune" without matching "Detune" (a name that means something
different, non-centered, on several real synths). Add your own plugin's
naming conventions if a bipolar control doesn't match either default.

**Encoder Snap to Origin** - once an encoder has been idle for **Encoder
Snap Idle Delay (ms)** (default 300) while its target sits within its
context's snap range of `getOrigin()`, it snaps the rest of the way there.
Configured independently for two contexts, since a shared setting made
tuning one interfere with the other:

- **Encoder Snap to Origin (Device/Plugin Mode)** (default ON) + **Encoder
  Snap Range - Device/Plugin Mode (+/- %)** (default 2%, range 0-10%).
- **Encoder Snap to Origin (Mixer Mode)** (default ON) + **Encoder Snap
  Range - Mixer Mode (+/- %)** (default 2%, range 0-10%) - also covers
  Sends.

Turn a context's range to 0% to disable snapping there without touching its
toggle.

**Finer Resolution Near Center** (on/off, default ON) - when the target
sits within **Finer Resolution Range (+/- %)** (default 5%, range 0.5-20%)
of its origin, the resolution used for each tick is multiplied by **Finer
Resolution Multiplier** (default 4x, range 2-16x) - i.e. a smaller step per
tick near center, so landing exactly on it by hand is realistic even on a
narrow, origin-centered macro. Skipped for discrete/switch targets and for
Stepped mode.

**Encoder Push Behavior (Device/Plugin Mode)** (`Fine Resolution` /
`Reset to Default` / `Open/Close Plugin Window`, default `Fine Resolution`)
+ **Encoder Push Fine Resolution Multiplier** (default 8x, range 2-32x) -
in Mixer mode, pushing an encoder always resets pan to center. In Device
mode, the same gesture instead does one of:

- **`Fine Resolution`** - hold the encoder down while turning it for a
  finer step (scaled by the multiplier) for as long as it's held.
- **`Reset to Default`** - classic single-press-to-reset, matching Mixer
  mode's own gesture.
- **`Open/Close Plugin Window`** - toggles the plugin's own GUI regardless
  of which of the 8 encoders is pressed.

### Mixer

**Send/Return Bank Size** (`8` or `16`, default `16`) - how many sends a
normal SEND-button press cycles through before exiting back to Mixer.

**Mixer Mode PAGE: Loop Behavior** (`Keep Loop Length` / `Loop Between
Markers`, default `Keep Loop Length`) - in Mixer mode, PAGE left/right
(notes 82/83) jump the playhead to the previous/next cue marker and move
the loop to follow it.

- **`Loop Between Markers`** - loop spans from the target marker to the
  next one chronologically.
- **`Keep Loop Length`** - loop relocates to start at the target marker,
  keeping its existing length.

**Deactivated Tracks in Bank** (`Show All (Dim Name)` / `Hide (Skip and
Shift)`, default `Show All (Dim Name)`) - Main tracks only; based on
`Channel.isActivated()`, the closest available signal since the Controller
API has no direct "is this track hidden" flag.

- **`Show All (Dim Name)`** - a deactivated track's name/volume text goes
  blank in its slot; the fader, pan, arm/solo/mute, and LEDs keep working
  normally if touched.
- **`Hide (Skip and Shift)`** - fully excludes deactivated tracks from the
  bank; the next activated track shifts up to fill the gap. Fewer than 8
  activated tracks in the whole project leaves trailing slots genuinely
  empty (blank LCD, LEDs off, fader/encoder unbound) rather than falling
  back to some other track.

**Bank Scroll Left: Select Track #** / **Bank Scroll Right: Select Track
#** (`None`/`1`-`8`, default `1`/`8`) - which slot in the newly-scrolled
window gets selected (so Bitwig's own view follows the hardware) after a
BANK/CHANNEL scroll in that direction. `None` skips selection on that
scroll direction entirely, leaving whatever was already selected alone.

**Scene Mode: SHIFT+Wheel Selects** (`Off` / `Select Track` / `Page Track
Bank`, default `Select Track`) - requested directly, a workflow choice for
the user rather than a replacement of anything: track selection is already
reachable in Scene mode via BANK/CHANNEL wheel-modes or the SELECT1-8
buttons, but those need leaving Scene mode's own SCROLL wheel-mode. This
setting adds an option to reach it straight from SHIFT+wheel instead,
without ever touching the current scene row - the plain wheel still
selects scenes and the wheel push still launches regardless of this
setting.
- **`Off`** - SHIFT+wheel does nothing extra in Scene mode (same as before
  this feature existed).
- **`Select Track`** (default) - moves which single slot (0-7) of the
  current 8-track bank is selected/highlighted, the same effect as
  clicking a track or pressing a SELECT1-8 button, without paging which 8
  tracks are visible.
- **`Page Track Bank`** - instead pages which 8 tracks are visible (same
  effect as CHANNEL wheel-mode's own step), without necessarily selecting
  one specific track.

**Scene Mode: CTRL+Wheel Selects** (`Off` / `Select Track` / `Page Track
Bank`, default `Off`) - the same options as SHIFT+Wheel above, but as an
independent second modifier - default off since SHIFT+Wheel already
covers `Select Track` out of the box, but enable this too if a workflow
wants both modifiers mapped at once (e.g. SHIFT for a single track, CTRL
for paging the whole bank). SHIFT is checked first if both happen to be
enabled and held at once. Shares the same underlying track-slot state
with SHIFT+Wheel, so switching which modifier you hold mid-session
continues from wherever the other left off rather than resetting.

**Mixer Layout Presets & Toggles** (F1-F8, active in `MODE_MIXER` **and**
`MODE_SCENE`) - requested directly: repurposes the orange F1-F8 row, while
in Mixer or Scene mode, to show/hide sections of Bitwig's own Mixer panel
instead of selecting a device. Deliberately covers `MODE_SCENE` too, not
just `MODE_MIXER` - `MODE_SCENE` (B.T.A.) is the one mode that actually
guarantees the Mixer panel is on screen (it forces Bitwig's "MIX" panel
layout on entry - see the Modes list above), so scoping this to
`MODE_MIXER` alone left it firing in a mode where the mixer might not
even be visible, and silent in the one mode where it was. Built on
`host.createMixer()`'s 6 real settable
booleans (`isClipLauncherSectionVisible()`, `isCrossFadeSectionVisible()`,
`isDeviceSectionVisible()`, `isIoSectionVisible()`, `isSendSectionVisible()`,
`isMeterSectionVisible()`) - genuine `.set()`/`.toggle()` calls, not the
generic "Show Sends"-style Actions (which are plain toggles with no way
to force a specific state) - so a preset always lands on the exact same
result regardless of what was showing before.
- **`Mixer Layout F1: Slot 1/2/3`** / **`Mixer Layout F2: Slot 1/2/3`**
  (each `None` / `Show`/`Hide` × the 6 sections, default `None`) - F1 and
  F2 each get a 3-slot preset, for the two layouts used most (e.g. a
  "mixing" layout and an "arranging" layout). Slots apply in order
  (1 then 2 then 3) on a single press; if two slots on the same key
  contradict each other (e.g. slot 1 = Show Sends, slot 2 = Hide Sends),
  the later slot simply wins - a well-defined outcome, not an error.
  Bitwig's Controller Preferences dropdowns can't prevent picking
  contradictory values across a key's own 3 slots (no API to prune
  already-picked options from the others), so this ordering rule is what
  keeps a misconfiguration harmless rather than ambiguous.
- **`Mixer Layout F3-F8: Toggle Section`** (`None` / one of the 6
  sections, default `None`) - each of the remaining 6 F-keys gets exactly
  one section to flip open/closed by itself, for quickly toggling a
  single row without disturbing the rest of the layout.
- Leaving an F-key's setting(s) as `None` (the default) leaves it exactly
  as it's always behaved in Mixer mode - direct device select, same as
  every other mode. Only a key that's actually been assigned something
  here changes behavior, and only while `MODE_MIXER` is active.

**Blink Armed Track's SELECT LED** (on/off, default ON) - any channel armed
for recording blinks its SELECT LED, regardless of whether it's also
selected, so the SELECT row doubles as an always-visible "which tracks are
armed" overview. **Armed SELECT LED Blink Rate (ms)** (default 1000, range
100-2000) sets the duration of each of the 2 steps (on/off).

**Select Channel on Fader Touch** (on/off, default ON) - touching a
motorized fader selects that channel's track, same as pressing its SELECT
button. Only active in `MODE_MIXER` for the 8 channel faders; the master
fader always selects the master track regardless of mode.

**Select Channel on Fader Touch Delay (ms)** (default 0 = immediate, range
0-1000) - debounces a quick multi-fader grab so the selection settles on
one channel instead of flickering through each one touched.

**Fader Snap to Zero** (on/off, default ON) - releasing a fader within
**Fader Snap to Zero Range (%)** (default 3%, range 0-10%) of the bottom
arms a check that snaps it the rest of the way to true `-inf` after
**Fader Snap to Zero Delay (ms)** (default 500ms, range 100-3000ms) of no
further touch. Applies to whatever the fader currently controls
(Volume/Send/Pan/macro under FLIP); skipped for discrete/switch targets.

**Fader Snap to dB Marks** (on/off, **default OFF**) - same
release-triggered mechanics, snapping instead to one of a set of "round"
dB marks once released within **Fader Snap to dB Marks Range (dB)**
(default 0.5dB, range 0.1-5dB - a commonly-cited threshold for hearing a
volume difference by ear; go lower if you can reliably hear finer than
that) and left untouched for **Fader Snap to dB Marks Delay (ms)**
(default 500ms). The range is an actual dB tolerance, not a fraction of
the fader's physical travel - deliberate, since Bitwig's volume curve is
non-linear (steep near 0dB, much flatter down near -60dB), so a fixed
travel-% tolerance would mean a far wider, inconsistent dB window low on
the fader than up high. Scoped to plain **Track Volume only**. **Fader
Snap to dB Marks Layout** (default **Hardware Scale**) picks which marks:

- **Hardware Scale** (default) - `5, 0, -10, -20, -30, -50, -60` dB, the
  marks actually printed on this hardware's own fader scale.
- **Musical (Standard)** - `0, -6, -12, -18, -24, -30, -36` dB, the
  standard audio-engineering halving series.

**Swap LCD Rows (Value on Top)** (default off) - swaps which physical row
shows the name vs. the value (level/pan/parameter text) for every channel
strip, in every mode - useful since this hardware's rotary encoders can
physically block the row directly above them.

**Auto-Banking (Bank Follows Track Selection)** (default off) - modeled on
the SSL UF8: when a different track is selected by any means outside this
hardware (mouse, keyboard), the bank window scrolls the minimum amount
needed to bring it into view, the same way a text editor keeps the cursor
line visible. Main tracks only; skipped while viewing Returns.

**Disable Automation Write on Mode Change** (default off) - see
**Automation and mode switches** below.

### Master Wheel

This unit has no separate physical master fader - the jog wheel under
MASTER mode substitutes pitch-bend on the same MIDI channel this script's
master-fader input reads, driving `masterTrack.volume()` by default (see
**Development Notes & Findings** below for how this was confirmed). This
category lets that same gesture be repurposed instead, for a workflow
that never rides the master fader by hand and would rather use it to call
up a metering plugin.

**Enable MASTER Wheel: Open/Close Metering Plugin** (default off) - off,
MASTER mode behaves exactly as it always has (drives master volume). On,
the same wheel gesture opens the configured device's plugin window when
turned right, and closes it when turned left, and master volume is never
written to at all while it's on - not "held steady," genuinely untouched.

Getting there took three failed attempts, each hardware-confirmed to
still let real volume movement through, because they all shared the same
flaw: they kept the wheel's pitch-bend channel natively bound to
`masterTrack.volume()` via Bitwig's `setAdjustValueMatcher()`/
`setBinding()`, and tried to "correct" the value back afterward -
deferring the correction to a fresh tick, bracketing it with
`Parameter.touch()`, then idle-debouncing it by 300ms. Each got closer,
but a native binding applies the hardware's value to the Parameter
directly, at a layer entirely opaque to this script's own code - there is
no way to intercept or decide what a message means before that happens,
only to react afterward, and reacting afterward always means the volume
genuinely moved for at least a moment first. Confirmed via an independent
OS-level MIDI monitor (`receivemidi`, bypassing this script entirely)
that the wheel sends a rapid, continuous stream of pitch-bend messages
for the entire duration of a turn, not one message per detent, so even a
fast correction was racing a message stream it could never fully win
against.

The actual fix: stop using a native binding for this channel at all. The
wheel's pitch-bend channel is now parsed manually in this script's own
`onMidi()`, exactly like every other control besides the 8 track faders
already works - the raw bytes are read and interpreted first, and
`masterTrack.volume()` is written to only when this setting is off. When
it's on, the open/close accumulator runs entirely off the raw pitch-bend
stream and the volume parameter is never referenced in that code path at
all, so there's no longer a "correction" racing anything - there's simply
nothing left to correct. **Confirmed working on hardware**: repeated
open/close cycles via the wheel both fire correctly, and master volume
was watched the entire time and genuinely never moved.

**Known caveat, confirmed on hardware:** toggling this checkbox off did
not reliably switch the wheel back to controlling master volume live -
a script reload (Settings -> Controllers -> the reload icon on this
controller's entry) was needed before the wheel drove
`masterTrack.volume()` again, even though the setting's own observer does
fire and update the script's internal state immediately. Root cause not
isolated. If turning this off doesn't restore normal volume control,
reload the script rather than assuming something is broken.

**Master Wheel: Metering Plugin Name** (text, default `ADPTR MetricAB`) -
which device on the Master track's own chain to open/close, matched by
exact name (case-sensitive), same convention as the `TRLVL` gain-staging
device. The default matched cleanly against a real ADPTR MetricAB
instance on hardware - change this only if you use a different metering
plugin. This same setting also governs **ALT+B.T.A.** (note 79), a
second, independent way to reach the same plugin: toggles that device's
window open/closed with a single button press, requested specifically so
it can stay open while mixing without being tied to Plugin/Device mode at
all - unlike PLUG-INS/F1-F8/EQ Mode, it never switches `currentMode` and
never closes any other plugin window (doesn't call
`closeOtherDeviceWindowsIfConfigured()`), regardless of the **Close Other
Plugin Windows** setting. Available regardless of whether **Enable MASTER
Wheel: Open/Close Metering Plugin** above is on - the wheel gesture and
ALT+B.T.A. are two separate paths to the same device. **Confirmed working
on hardware**: ALT+B.T.A. opened/closed the metering plugin correctly,
and stayed open while separately opening/closing other devices' windows
via the F1-F8 orange direct-select buttons in Plugin Mode - confirming
the two paths are genuinely independent, as designed.

**Master Wheel: Movement to Trigger (%)** (default 15%, range 5-50%) - how
far the wheel has to move, accumulated, before an open or close actually
fires - tune lower for a lighter flick, higher to require a more
deliberate turn. **Confirmed working on hardware** at the default value.

**Landing on an exact volume value (0dB especially):** with the
metering-plugin mode above off (normal MASTER mode, driving master
volume), the wheel maps its raw pitch-bend position straight onto
`masterTrack.volume()`, the same absolute mapping a native hardware
binding would use. Two relative/delta-based alternatives were tried
first and abandoned - scaling each message's own movement down, then an
accumulate-and-step version - both confirmed on hardware to barely
respond at all: a real `receivemidi` capture of slow, deliberate,
one-tick-at-a-time turning (not even a fast flick) netted only +128 raw
units out of a possible 16383 across the whole capture, because this
wheel's raw reporting jitters up and down enough, even mid-turn in a
single direction, that per-message deltas mostly cancel each other out.
Absolute positioning sidesteps that dead end entirely, since it doesn't
depend on delta accuracy at all - whatever the wheel currently reports
simply is the volume.

That still leaves the wheel's own per-detent step size an imprecise way
to land on a specific number by hand (Bitwig's dB display is a
non-linear curve, so identical raw steps read as different-sized dB
jumps depending where on the curve you are). Rather than fight that, the
existing **Fader Snap to dB Marks** feature (Mixer category above) is
reused for the master wheel too: getting "close enough" and pausing
snaps precisely to the nearest mark once the wheel goes idle for
`Fader Snap to dB Marks Delay` - master (index 8) was already one of the
feature's supported targets, and simply calling the existing check on
every incoming wheel message (rather than only on a physical fader's
touch-release, which this wheel doesn't have) re-arms its own idle timer
automatically. **Confirmed working on hardware.**

**Master Wheel: Snap to dB Marks** (`Off` / `Hardware Scale` /
`Musical (Standard)`, default `Off`) - whether the wheel snaps at all,
and to which mark layout, kept **independent of the channel faders' own
Fader Snap to dB Marks toggle and layout above** (requested directly) -
so, for example, channel faders can snap to Hardware Scale while the
wheel stays off, or the two can use different layouts entirely. Uses the
same `Fader Snap to dB Marks Range (dB)`/`Fader Snap to dB Marks Delay
(ms)` settings as the channel faders (those two aren't duplicated
per-target). Off by default, so enabling Fader Snap to dB Marks for the
channel faders doesn't silently also start snapping the wheel.

### Debug

- **Enable Debug Logging** (default ON) - master switch for every category
  below; off also hides their individual checkboxes.
- **Log Raw MIDI (Controller Input)** (default ON) - every incoming CC not
  otherwise handled, and every Note-On.
- **Log Button Dispatch** (default ON) - once a Note-On has passed modifier
  filtering and reached the button handler.
- **Log Modifier State (SHIFT/OPTION/CTRL/ALT) in Raw MIDI** (default ON) -
  whether the raw Note-On line above appends live modifier state.
- **Log LCD Display SysEx** (default ON) - the exact text sent to each half
  of the two-row MCU LCD.
- **Log Encoder Target Classification** (default ON) - reports a
  parameter's real `discreteValueCount()` whenever it exceeds
  `MAX_NATIVE_SWITCH_STEPS` and gets treated as continuous.
- **Channel 8 Meter Test Mode** (default `LED + LCD (default, mode 3)`) -
  live-switches which of the 4 real MCU VU-meter modes channel 8's strip
  uses (`0`=off, `1`=LED only, `3`=LED+LCD, `6`=LCD only), for
  experimentation. On this hardware the LCD bar reacts to level in every
  mode including `0`/off (see Development Notes below).
- **Fader Position Test Mode (ALT+F8 start/cancel, F8 confirm)** (default
  off) - drives all 8 channel faders to each **Fader Snap to dB Marks
  Layout: Hardware Scale** value in turn, bottom to top, so you can verify
  each one lands on the correct printed hardware dB label. F8 confirms the
  current position and advances; ALT+F8 cancels early. Requires Mixer mode,
  Show All (not Hide/Returns), unflipped, not in Gain-Staging mode.
  **Auto-backs up and restores via Mixer Snapshot slot 8** - starting the
  test stores the current bank window's Volume+Pan into slot 8, and ending
  it (however it ends) recalls that slot back. Recommended on a throwaway
  project with 8 real tracks.

Real error/warning logging (caught exceptions, invalid action ids,
duplicate F-key assignments, a cue marker that couldn't be found to rename)
always prints regardless of these settings, so a genuine problem is never
silenced by a debug toggle.

### LCD / meters / LEDs

Standard MCU SysEx for the two 56-character text rows, per-channel
metering via Channel Pressure, and plain Note On/Off for button LEDs - all
covered by the settings above (Swap LCD Rows, Auto-Banking) and the
Momentary bottom-row LCD popups below. See **Development Notes & Findings**
for what was tried and confirmed/ruled out on the meter bar, segment
display, assignment-row LEDs, and per-channel color output.

### Automation and mode switches

**Usage note, not a bug**: writing automation while switching modes
(Mixer/Device/Sends/Scene), flipping, or toggling Gain-Staging mode
mid-pass splits that one recording across multiple automation lanes, one
per parameter that was actually bound to the fader/encoder at each moment -
Bitwig is faithfully recording whatever was live at each point across a
single continuous Write/Latch pass that spanned more than one binding
state, not a bug in this script's binding logic. **Recommended workflow:
set up the mode/flip/tool state you actually want first, confirm the LCD
shows the right target, then start the automation pass - don't change
mode/flip/PAN mid-pass if you want it to land on one lane.**

**Disable Automation Write on Mode Change** (Mixer category, default off) -
an optional safety net for the above: when an actual `currentMode`
transition happens (Mixer/Device/Sends/Scene, including PAN's forced switch
to Mixer for Gain-Staging mode) while Automation Write is armed, it's
automatically disabled, with feedback on both the hardware LCD (`WRITE
OFF`) and Bitwig's own screen. Default off, since disabling automation
write out from under someone mid-workflow is a real behavior change to opt
into. **Scope**: only an actual mode change - a same-mode FLIP toggle or a
bank scroll/RETURNS toggle isn't covered.

### Momentary bottom-row LCD popups

The bottom LCD row normally shows the track's volume in Mixer mode; these
temporarily override it, then revert after 800ms of no further activity on
that channel:

- **Turning an encoder to adjust pan** (Mixer mode, unflipped) reveals the
  live pan value instead of volume for as long as you keep turning it.
- **Pressing SOLO or MUTE** shows a one-shot `SOLO`/`UNSOLO` or
  `MUTE`/`UNMUTE` popup, reflecting the resulting state.
- **Switching modes** (TRACK/IO, SEND, PLUG-INS/F1-F8, RETURNS) shows a
  whole-strip announcement (`PLUGIN`/`SENDS`/`RETURNS`/`MIXER`) on entry and
  again on leaving back to Mixer. Paging within Sends doesn't re-announce.
- **Selecting a track** shows its color as a human-readable name (`ORANGE`,
  `LTORANG`, `PURPLE`, etc) on that channel's bottom row, matched against
  Bitwig's real 27-entry default track-color palette.

---

## Mixer Snapshots

SHIFT+F(n) stores Volume+Pan for **every existing Main track in the
project** into slot n (not just the current 8-track bank window); OPTION+F(n)
recalls it back. Persisted via `host.getDocumentState()`, so a snapshot
lives inside the Bitwig project file and travels with the song. Main tracks
in Show All mode only - Hide mode and Returns show a "switch to Main /
Show All view" popup instead, since neither has a stable absolute position
to store against.

Whatever's already visible in the current bank window updates immediately
on recall, with no scrolling; everything else off-screen is applied
afterward, one bank window at a time, before scrolling back to wherever you
started - the bank/faders/LCD will visibly jump through each affected
window in turn, but you end up back where you were with everything
applied.

---

## Development Notes & Findings

Engineering history and hardware-debugging findings from building this
script - useful context if you're extending it, not required reading just
to use it. Where a finding turned into a genuine, lasting API-design gap,
it's also written up in `BITWIG-API-FEATURE-REQUESTS.md`.

- **Motorized fader output is fully manual.** Binding a fader via
  `setBinding()` only covers input - there's no automatic motor feedback.
  `updateFaderOutputs()` polls every bound fader's value on every `flush()`
  and sends `sendPitchbend()` only when it changed, de-duplicated against
  the last sent value.

- **`CursorTrack.selectChannel()`, called on several independent cursor
  instances back-to-back in one tick, is unreliable** - all of them can
  eventually collapse onto whichever track the *last* call pointed at. This
  caused a real, hardware-confirmed bug (every LCD column and SELECT LED
  mirroring one single track) and a second, subtler one (a group's first
  child track reading/writing the group's own volume instead of its own,
  even though its name displayed correctly). Fixed by reading/writing the 8
  common-case channels straight off the plain `TrackBank`'s fixed-window
  items (`directTrackAt()`) instead of a `CursorTrack`, and reserving
  `CursorTrack` only for the one case that structurally needs arbitrary
  re-pointing (the filtered/reordered "Hide deactivated tracks" view). This
  is API Feature Request #1 - see that document for what a fix might look
  like.

- **A startup race condition** could leave every fader unbound on load: the
  background scan that "Hide (Skip and Shift)" mode needs to know which
  slots have a track only finishes ~100ms after `init()` returns, but if
  Hide mode was already the persisted setting at startup, its own value
  observer fired immediately during `init()` and cleared all 8 bindings
  before the scan had populated anything - with nothing left to ever
  re-bind them. Fixed by re-running the bind/refresh step once the scan
  actually completes.

- **Bitwig's live playback position can't be `.set()` directly while
  playing** - `transport.getPosition()` is continuously re-driven by the
  audio engine, so a script-side write to it gets stomped almost
  immediately. Every position jump in this script instead goes through
  `transport.playStartPosition()` plus `transport.jumpToPlayStartPosition()`
  while playing - the same workaround used by Mossgraber's DrivenByMoss.

- **`flush()` doesn't run on a fixed timer** - since Bitwig 3.1 it only
  fires when a subscribed value actually changes, so hardware output that
  depends on this script's own internal state (rather than mirroring an
  observed Bitwig value) could go stale while the transport sits idle.
  `flushWorkaroundTick()` forces a flush every 100ms while stopped, ported
  from the same fix in DrivenByMoss.

- **The jog wheel's own click was mis-mapped for most of this project** -
  assumed to be note 87, actually always note 101 (in the wheel's base
  "SCROLL" firmware mode; other wheel-assignment modes send no click at
  all). An old note-101 handler was silently swallowing every click before
  it could reach the real jog-wheel-push logic, meaning Pan Mode hold,
  ALT+press "select item at cursor", and Scene-mode launch-by-press had
  never actually fired on this hardware until this was found and fixed.
  Several other buttons (FLIP, RETURNS, UNDO, REDO, DRAW, B.T.A.) were
  similarly corrected after direct console-log confirmation replaced
  originally-assumed note numbers - the map at the top of this document
  reflects the corrected, confirmed values only.

- **Most of the Controller API's Selection-category generic actions turned
  out to be non-functional when invoked from script**, despite being real,
  named Bitwig actions: `select_item_at_cursor`, "Select item to
  left"/"right", "Select item above"/"below",
  `move_selection_cursor_to_next/previous_item`, and "Move selection cursor
  left"/"right" were all tried and confirmed, via clean hardware tests (a
  clip actually selected first, a diagnostic trace proving the modifier
  stayed held and the action fired throughout with nothing else in the
  log), to do nothing useful for "select the clip closest to the playhead"
  from a script - the selection simply never moved. Only `"Select next
  item"`/`"Select previous item"` reliably moves the Arranger clip
  selection - see CTRL+Wheel above - and only with the quirk that it falls
  through to track-to-track stepping once there's no further clip in one
  direction on the current track. This is API Feature Request #1's sibling
  problem and is written up there too.

- **Automation write mode has no `.get()`** - `Transport` exposes
  `setAutomationWriteMode()` and an observer, but nothing to read the
  current mode back, so `cycleAutomationWriteMode()` has to track it in a
  local variable kept in sync purely via the observer.

- **A macro's bipolar/centered state isn't exposed by the API** -
  `getOrigin()` only reliably reports `0.5` for parameters Bitwig itself
  classifies as pan-like; a real, centered plugin parameter (confirmed with
  Serum 2's Fine Tune macros) reported a flat `0` instead, which silently
  broke both Encoder Snap to Origin and Finer Resolution Near Center until
  traced with diagnostic logging. Worked around with the name-keyword
  heuristic described under Encoders above, cross-checked against the real
  manuals for five different synths (Serum, Diva, Hive, Zebra 2/3, Repro)
  specifically to avoid a real trap: "Detune" means a centered fine-tune on
  some devices and a non-centered unison-spread amount on others, with the
  identical parameter name.

- **Per-channel LCD meter bar is hard-driven by Channel Pressure data and
  can't be repurposed for track color** - confirmed across all 4 documented
  MCU VU-meter SysEx modes, including notionally "off", the bar kept
  reacting to real level regardless. The direct per-channel color SysEx
  (`updateChannelColorOutput()`, the ICON-vendor protocol variant) is
  implemented but confirmed not to change anything on this hardware; it's
  left in as a harmless no-op in case a different vendor variant or a
  future firmware works. The assignment-row LEDs (TRACK/IO, SEND, PAN,
  PLUG-INS, RETURNS) are also inconsistent about clearing each other on
  plain note-off - `updateModeLEDs()` now explicitly sends a note-off for
  whichever one it last lit, in addition to lighting the new one, as the
  most reliable available fix.

- **Mixer Snapshot recall silently failed to write any value to a channel
  whose fader had been touched earlier in the session** - root cause was
  that this script never called Bitwig's `Parameter.touch(isBeingTouched)`
  on fader press/release, so Bitwig had no signal a touch gesture had ever
  ended and kept ignoring subsequent script `.set()` calls on that
  parameter (confirmed against Mossgraber's DrivenByMoss, which does call
  this on every touch/release). Fixed by touching the exact fader-bound
  object on press/release, not a separately-resolved reference to the same
  track - a different script-side object reference to the identical
  real-world parameter reliably failed to write even once `touch()` was
  otherwise handled correctly. This is API Feature Request #2.

- **Bitwig's own Takeover Mode preference (Pick Up / Jump / Value Scaling)**
  is a separate, global setting from anything this script controls, and its
  exact interaction with a script's own `.set()` calls was never fully
  pinned down - see `patches/README.md`'s "Follow-up lead" section for the
  investigation and the risk (a reproduced LCD-freeze regression) of
  reopening it casually.

- **This unit has no separate physical master fader - the jog wheel
  substitutes for one under MASTER mode, and the script's pre-existing
  `hwMasterFader` binding was already handling it correctly.** Reported as
  "there's a MASTER button and it's adjusting master bus volume, but
  nothing shows in the console" - confirmed via an independent OS-level
  MIDI monitor (`receivemidi`, reading the hardware port directly,
  bypassing this script and Bitwig's controller-script layer entirely)
  that MASTER-mode wheel turns send absolute pitch-bend on **MIDI channel
  9** - exactly the channel `hwMasterFader` has been bound to since this
  script's fader architecture was first built
  (`midiIn.createAbsolutePitchBendValueMatcher(8)`, 0-indexed -> real
  channel 9 -> `masterTrack.volume()`), under the assumption of a literal
  9th physical fader. Nothing was actually broken; the console showed
  nothing because pitch-bend claimed by a native `HardwareControl`
  binding is consumed entirely by Bitwig's own binding pipeline and never
  reaches this script's `onMidi()` handler - the exact same reason the 8
  track faders' own motor input is invisible to the raw MIDI logger too.
  Whether note 112 (the master fader's *touch* note) also fires on this
  unit wasn't separately confirmed - worth checking if fader-touch-select
  behavior for the master track ever needs to be relied on.

### Reverted / abandoned

- **Encoder-click volume-to-dB reset** - three different implementation
  strategies each broke something different on real hardware; encoder click
  stays pan-reset only.
- **Live fader-follow via a manual `sendMidi()` value observer** - never
  worked; superseded by the `flush()`-polling approach that does.
- **A 4-step "breathing" armed-SELECT-LED animation** using velocity 1 for
  a documented "dim" state - confirmed on hardware not to work for this
  particular LED row (likely overridden by local record-arm firmware
  behavior); reverted to the simpler, confirmed-working 2-state blink.
- **The arranger edit-tool cycle** (Pointer/Time Selection/Pencil/Spray
  Can/Eraser/Knife) that used to live on plain DRAW - shelved when DRAW was
  made fully automation-centric. Kept as `patches/arranger-tool-cycle.patch`
  for reuse on a different button or controller.
- **SHIFT+wheel Fine Mode and a low-pass smoothing filter** for the MASTER
  wheel's volume control - tried to make the wheel usable for careful,
  continuous volume riding (a relative scaled-down nudge while SHIFT was
  held, then an exponential filter on the raw signal to damp jitter).
  Confirmed on hardware, across multiple `receivemidi` captures, that this
  wheel's raw pitch-bend reporting is genuinely noisy relative to real
  movement - even "serious" deliberate turns with Fine Mode engaged still
  showed values jumping backward mid-turn, and no amount of scaling or
  smoothing fully eliminated it without adding so much lag the control
  stopped feeling responsive at all. Concluded this wheel just isn't a
  precise-enough encoder for that use case, and reverted both features -
  master volume control is back to the plain absolute mapping alone.
  **Fader Snap to dB Marks (Master Wheel category above) is the intended
  way to land precisely despite the wheel's own jumpiness**: get close and
  pause, rather than trying to ride there smoothly. Confirmed working well
  on hardware in this simpler form.

### Hardware test status

The single canonical list of what still needs (re-)confirmation on real
hardware - kept here instead of scattered across feature sections, so a
debugging session can work through it top to bottom without hunting for
stray "not yet tested" notes, and so nothing gets silently forgotten
between sessions. When an item below gets tested, check it off here *and*
update its own feature section with the confirmed result (or the fix, if
it turned out broken) - this list tracks status, the feature sections
carry the detail/evidence. If a later change touches something already
checked off, uncheck it here until it's retested.

- [ ] **Scene Mode: SHIFT+Wheel Selects** / **CTRL+Wheel Selects**
      (`Select Track`/`Page Track Bank`) - brand new, not yet tested on
      hardware at all. Confirm each modifier moves track selection without
      disturbing the current scene row, both step directions, that the two
      modifiers share state sensibly, and that plain wheel/wheel-push
      behavior is completely unaffected.
- [ ] **Mixer Layout Presets & Toggles** (F1-F8 in `MODE_MIXER` and
      `MODE_SCENE`) - first version only checked `MODE_MIXER`, confirmed
      on hardware to fire in the wrong mode (B.T.A./`MODE_SCENE` is the
      mode that actually shows the Mixer panel); now fixed to cover both.
      A second attempted fix (removing B.T.A.'s forced `"ARRANGE"` on
      toggle-off) was confirmed on hardware to break the user's actual way
      back to the Arranger view, and was reverted - B.T.A.'s toggle-off
      still forces `"ARRANGE"`, unchanged from the original design. Needs
      a full hardware retest: confirm F1/F2's 3-slot presets apply all
      configured slots in order and land on the exact same layout every
      press in both `MODE_MIXER` and `MODE_SCENE`; confirm F3-F8 each
      toggle only their assigned section; confirm an unconfigured (`None`)
      F-key still selects a device exactly as before; confirm B.T.A.
      itself still reliably gets back to the Arranger view.
- [ ] **SESS/ARR (note 74)** - changed from a plain clip-launcher-
      visibility toggle to a real Mix/Arrange panel layout toggle, reading
      `application.panelLayout()` to know which way to switch - brand new,
      not yet tested on hardware at all. Confirm it actually switches
      Bitwig's panel layout both directions, and that the popup text
      matches what's actually shown.
- [ ] CURSOR wheel-mode - mode button and wheel-turn behavior both
      untested.
- [ ] NUDGE wheel-mode - mode button and wheel-turn behavior both
      untested.
- [ ] MASTER wheel-mode's **wheel click** (pressing the wheel in while
      it's in MASTER mode) - untested; the mode button and wheel-turn
      behavior are both confirmed, only the click itself isn't.
- [ ] Note 112 (the master fader's *touch* note, distinct from turning
      it) - not confirmed to fire on this 8-fader unit at all.
- [ ] Notes 50/51/80/81/87 - either unbound or need a fresh confirmation
      sweep against the current overlay placement.
- [ ] ~33 generic Function Keys Editing/File actions (the ones without a
      dedicated typed `Application` method) - not hardware-tested one by
      one.
- [ ] OPTION+DRAW's `toggle_automation_lanes` action id - not
      hardware-confirmed.
- [ ] A different vendor's per-channel color SysEx variant (e.g.
      Behringer's single-byte 3-bit color index) - never tried; only
      relevant if track-color display still matters enough to chase
      further.
- [ ] Takeover Mode Catch vs. Jump, side-by-side, for Mixer Snapshot
      recall - one clean Catch-mode retest passed, but a deliberate
      side-by-side (same session, same snapshot, nothing else changed)
      was never done - see `patches/README.md`.
- [ ] **Master Wheel: Snap to dB Marks** dropdown (Off/Hardware
      Scale/Musical) - the underlying snap behavior was confirmed working
      before this was split out into its own dedicated per-target
      setting; the split itself hasn't been separately retested.
- [ ] **Fader Snap to dB Marks Range (dB)** - switched from a % tolerance
      to an actual dB one; math should be equivalent in intent, but not
      retested on hardware since the change.
