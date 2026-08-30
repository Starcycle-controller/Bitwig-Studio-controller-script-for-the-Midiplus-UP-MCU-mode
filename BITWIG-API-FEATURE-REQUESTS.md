# Bitwig Controller API — Feature Requests From Real-World Use

Compiled from building `MidiplusUP-MCU.control.js`, an MCU-protocol
controller script for the Midiplus UP. Every item below is a real,
hardware-confirmed workaround this project had to build because the
Controller API either didn't expose something directly, or exposed it
in a way that turned out unreliable under real use. Ranked roughly by
how much pain it caused and how much simpler the script could have been
with the API gap closed - not by how hard it would be for Bitwig to
implement.

## 1. Track/channel selection reliability (top priority)

**What broke:** `CursorTrack.selectChannel(track)`, called on 8
independent `CursorTrack` instances back-to-back in one synchronous
tick, turned out to be unreliable - all 8 would eventually collapse
onto whichever track the *last* call in the loop pointed at. This
showed up as every LCD channel-strip column and every SELECT LED
mirroring one single track, and took an extended debugging session to
isolate (multiple false leads: closure bugs, stale caches,
multi-select, arm-blink overlays) before landing on "calling
`selectChannel()` in a tight loop is itself the problem."

**Workaround we shipped:** stopped using `CursorTrack` entirely for the
common case (8 tracks visible in a fixed window) and read display/
selection/parameters straight off the plain `TrackBank` items instead -
exactly the same access pattern already used successfully elsewhere in
the script for a different, fixed-window bank. `CursorTrack` is now
used *only* for the one case that structurally needs arbitrary
re-pointing (an internally filtered/reordered view skipping deactivated
tracks), where this reliability problem is presumed to still lurk,
just not yet reproduced on hardware.

**What would have helped:** either a documented, supported pattern for
repointing several cursors in the same tick (a batch/transaction API,
or an explicit "wait N ticks between repoints" contract), or - better -
a lighter-weight primitive than a full `CursorTrack` for "give me a
stable handle to track at arbitrary index N of some list," so a script
doesn't have to reach for cursor machinery (designed for interactive,
one-at-a-time navigation) just to represent a fixed set of 8 lookups.

## 2. Parameter writes are unreliable unless you get object identity exactly right

**What broke:** two related, both hardware-confirmed, both silent (no
exception, no error - the value just doesn't change):

- Writing `Parameter.set()` from script on a Parameter that a
  `HardwareControl` is currently (or was recently) bound to via
  `setBinding()` gets silently ignored unless the script has separately
  called `Parameter.touch(true)` then `Parameter.touch(false)` around
  the hardware gesture - a requirement found by reading a *third-party*
  open-source extension's source (Mossgraber's DrivenByMoss), not
  anything in Bitwig's own docs.
- Even with `touch()` handled correctly, writing to the *same real
  track's* Volume/Pan through a *different* script-side object
  reference (e.g. a plain, permanently-unscrolled scan bank's item,
  used to make a feature scroll-proof) still silently failed - only the
  literal object currently `setBinding()`-bound to hardware can
  reliably `.set()` that parameter.

**Workaround we shipped:** every reliable write in this script goes
through the exact same object/call (`directTrackAt(i)`) that the
physical fader for that index is bound to. A whole feature (recall a
saved mix across multiple bank windows) had to be built around
*scrolling the bank so the target track becomes that bound object*
before writing, rather than writing to it directly wherever it sits -
with all the visible fader/LCD motion that implies.

**What would have helped:** `Parameter.set()` should reliably update
the real underlying parameter regardless of which script-side reference
is used to reach it, and regardless of touch state - or, if `touch()`
truly is required by design, `.set()` should throw/warn when it's
ignored for that reason instead of no-op'ing silently. Either change
would have let a project-wide "recall a saved mix" feature be a few
lines instead of a whole scroll-choreography state machine.

## 3. No way to read a Transport's own automation write mode

**What broke:** `Transport` has `setAutomationWriteMode(mode)` and
`addAutomationWriteModeObserver(callback)`, but no `getAutomationWriteMode()` -
every other similar Settable value in the API (`SettableBooleanValue`,
`SettableEnumValue`, etc.) has a plain `.get()`.

**Workaround we shipped:** a local script-side variable, kept in sync
purely via the observer, just so a "cycle Latch → Touch → Write" button
can know what to cycle *from*.

**What would have helped:** expose it as a real `SettableEnumValue`
like everything else, with a working `.get()`.

## 4. No way to know if a parameter is "centered" (bipolar)

**What broke:** a Macro/remote-control knob mapped to an underlying
bipolar parameter (pan-like, centered at 50%) doesn't expose that fact
to script - `getOrigin()` helps when Bitwig already reports a non-zero
origin, but a generic Macro control often doesn't inherit it. The only
option was a hand-maintained, case-insensitive keyword list
(`"pan,tune,fine,ftun,offset"`) matched against the parameter's
*display name* to guess whether it should snap-to-center - actively
dangerous to extend carelessly, since e.g. "Width"/"Detune" controls
are usually 0-based intensity knobs on most synths but genuinely
centered on at least one real device we tested against, and a keyword
match can't tell those apart.

**Workaround we shipped:** the keyword-matching heuristic above, with a
Controller Preferences setting so a user can tune the list without
touching code, plus extensive comments warning future maintainers
which keywords were checked against real synth manuals and which
weren't.

**What would have helped:** a real `isBipolar()`/`isCentered()`
(or equivalent origin metadata) on `Parameter` that Macro/remote-control
mappings actually forward from whatever they're wrapping. This would
delete the entire keyword-matching subsystem.

## 5. No way to read a track's Arranger/Mixer hidden state

**What broke:** there's no `isVisible()`/`isHidden()` anywhere on
`Track`/`Channel` for whether a track is hidden in the Arranger/Mixer -
confirmed absent, not just undiscovered.

**Workaround we shipped:** `Channel.isActivated()` used as a proxy
instead, on the (documented, verified-against-source) assumption that
this matches how Mossgraber's own DrivenByMoss framework handles the
same gap - not the actual thing being asked for, just the closest
available signal.

**What would have helped:** expose the real hidden/visible flag.

## 6. No filtered/predicate-based bank view

**What broke:** `TrackBank` only offers a fixed contiguous window over
the full track list - there's no way to ask for "only the activated
(non-hidden) tracks, in order," skipping the rest.

**Workaround we shipped:** an entire parallel bookkeeping system - a
permanently-unscrolled 128-deep background scan bank, a filtered index
array rebuilt on every relevant change, and a logical scroll offset
into *that* array - just to reimplement "skip inactive tracks" that
arguably belongs in the bank primitive itself.

**What would have helped:** a bank construction option that takes a
predicate (or even just a boolean "hide deactivated") and does this
filtering internally, keeping slot `i` stable as "the i-th track
matching the filter."

## 7. `markInterested()` is all-or-nothing per sub-value, with no bulk option

**What broke:** every sub-accessor of a value (`.value()`,
`.discreteValueCount()`, `.discreteValueNames()`, `.getOrigin()`,
`.name()`, `.displayedValue()`, ...) needs its *own* explicit
`markInterested()` call before first use, or a hard crash ("Either call
markInterested() or add at least one observer") - and the crash only
surfaces the first time some code path actually touches the
un-marked one, often much later than when the bug was introduced.
This project hit this repeatedly across multiple features, each
requiring its own round of "which sub-value did we forget this time."

**What would have helped:** either a single call to mark an entire
`Parameter` (and its standard sub-values) interested at once, or make
values interested automatically on first real access rather than
requiring an separate opt-in call per sub-value.

## 8. Generic actions require console-log archaeology, not documented IDs

**What broke:** many real, useful actions (arranger tool selection,
automation lane visibility, dozens of Edit-menu commands) have no
dedicated typed method on `Application` the way `duplicate()`/`cut()`/
`remove()` do - the only path is `application.getAction(actionId).invoke()`,
and the actual `actionId` strings aren't documented anywhere findable.
This project had to dump `application.getActions()` filtered by
keyword and read the real IDs off the console to get several buttons
working at all, and at least one feature (automation lane show/hide)
is still shipping with an unconfirmed best-guess ID for lack of a
better way to find it without hardware in hand.

**What would have helped:** either publish the full, stable list of
generic action IDs, or extend the set of actions with dedicated typed
methods (matching the ones that already exist) so scripts don't need
to guess strings at all.

## 9. No "the bank has actually settled" signal after scrolling/repositioning

**What broke:** reading a bank item's values immediately after
scrolling the bank (or repositioning a cursor) can return stale data
from before the move - confirmed on hardware, worked around with a
fixed, guessed delay (`host.scheduleTask(fn, 100)`) in more than one
feature. There's no callback for "the window has now fully updated,
safe to read."

**What would have helped:** a settle/ready observer on bank scroll
operations, so scripts don't have to guess a delay that might be wrong
on a slower machine or a future Bitwig version.

## 10. Motorized fader feedback is fully manual, every script reinvents it

**What broke:** binding a `HardwareSlider` via `setBinding()` only
covers *input* - there's no automatic motor feedback. Every MCU-style
script (this one included, and confirmed the same in Mossgraber's
DrivenByMoss) has to manually poll the bound parameter's value on every
`flush()` and hand-roll its own "only send if changed since last time"
de-dup bookkeeping, just to move the physical fader in sync with
automation playback, mouse edits, or bank switches.

**What would have helped:** since Bitwig already tracks the binding
and already knows the value changed, it could drive the output side
too (many controllers' protocols are just a MIDI message per channel,
which the API already has enough information to construct) - or at
minimum, a small helper for "call this when a bound value changes" so
every script doesn't reimplement the same flush-polling loop.

## 11. No API access to audio clip/event properties at all (fade, gain, tuning/Expressions)

**What broke:** unlike every other gap above, this one has no
workaround in this script at all - there's nothing to work around with,
because the capability doesn't appear to exist. Checked directly
against the Controller API's `Clip` interface (via the community
`bitwig-api-stubs` project, cross-referencing real method stubs rather
than guessing): it covers the note-grid/step-sequencer view only
(`getAccent()`, `getShuffle()`, per-step editing, key/step scrolling) -
nothing for an audio event's fade-in/fade-out handles, crossfade shape,
or gain, which live at the Arranger audio-event level, not the note
clip level. That leaves a fully hands-free workflow - e.g. riding a
physical control to set an audio clip's fade length/curve without
touching the mouse - impossible to build for this or any other
controller today, since there's no object to read or write in the
first place.

**What would have helped:** expose the Arranger audio event (not just
the note `Clip`) to the Controller API, with at minimum readable/
settable fade-in and fade-out length (and ideally curve shape), so a
hardware controller could support hands-free clip editing the same way
it already does for track volume/pan/sends.

**Follow-up, hardware-confirmed in two stages:** tried the obvious
workaround anyway - click a clip's fade field in the Inspector panel, then
use this script's ALT+Wheel combo (`host.createLastClickedParameter()`,
the same generic "whatever was last clicked" mechanism that reliably works
for device/mixer knobs elsewhere in this script) to adjust it. Confirmed
on hardware that this does **not** work - the wheel has no effect on the
fade value. Ruled out a button-detection problem first (ALT's own Note-On
registers cleanly and reliably, confirmed via the raw MIDI log), so the
cause isn't this script failing to read ALT.

Confirmed further, definitively: the popup this script shows on every
ALT+Wheel turn (naming whatever `LastClickedParameter` resolved to) came
back **completely empty** after clicking the fade field - not a stale or
wrong name, nothing at all. That means `host.createLastClickedParameter()`
itself never resolved the click to any `Parameter` object in the first
place; this isn't a values-don't-move symptom on top of a successful
resolve, it's a failed resolve from the start. Confirms the explanation
above: clip fade isn't modeled as a real, addressable `Parameter` in
Bitwig's object model at all - it's a specialized audio-event edit handle
entirely outside the generic automation/remote-control `Parameter` system,
the same architectural gap that keeps it out of the Controller API's
`Clip` interface too. Not just unexposed to scripts via `Clip` - unreachable
via *any* generic script-facing mechanism, including the "whatever the
user just clicked" escape hatch that normally works for arbitrary GUI
controls. (This script's own popup now shows a clear "No Parameter" message
instead of a blank box when this happens, so the failure reads as a known
limitation rather than looking like a bug.)

**Scope confirmed broader than just fade:** the Inspector panel's
**Expressions** section for an audio clip (its base **Gain**/volume and
**Tuning**/transpose values, distinct from the fade handles) was tested
the identical way - click the field, ALT+Wheel - and produced the exact
same empty-popup result. So this isn't a fade-specific gap: the whole
family of clip/audio-event-level static properties shown under
"Expressions" in the Inspector is equally unreachable, for the same
underlying reason (no audio-event object exists anywhere in the
Controller API to read or write any of it from).

**Distinct from real per-note Expressions, which may actually be
reachable (unverified):** Bitwig also has genuine per-note Expression
data (MPE-style Gain/Pan/Timbre/Pressure/Transpose on individual notes
within a MIDI/instrument clip), edited via lanes in the clip's Detail/Note
editor - a completely different feature from the audio-clip-level
Expressions above, despite the shared name and adjacent action ids
(`toggle_edit_note_gain_expression` etc., see `bitwig-actions-reference.txt`).
Per-note data lives on individual `NoteStep` objects, part of the
note-grid/step-sequencer domain this write-up already noted **is**
covered by the Controller API's `Clip` interface (unlike the audio-event
level). Whether `NoteStep` actually exposes real getters/setters for
these expression values wasn't confirmed against a current primary source
this round (the community stub mirrors reachable turned out to predate
`NoteStep`'s introduction) - worth a fresh, targeted investigation if
per-note expression control on MIDI/instrument clips becomes an actual
goal, rather than assuming it shares audio-clip Expressions' dead end.

## 12. Takeover Mode is one Studio-wide setting, not per-controller - and isn't readable from script

**What broke:** Bitwig Studio's **Takeover Mode** preference (Settings ->
Controllers -> Pick Up / Jump / Value Scaling) is a single, global,
Studio-wide setting - it is not scoped per controller script, per output,
or even per control. Direct, hardware-confirmed consequence: this
project's own faders are motorized and always want immediate ("Jump")
behavior (the motor physically drives the fader to match the real value,
so there's no mismatch to catch up on - `HardwareSlider.disableTakeOver()`
already opts each fader out of takeover entirely, per-control, exactly for
this reason). But **encoders/knobs on this same script, and any other
controller connected to the same Bitwig instance, have no equivalent
per-control override** - so switching the *global* preference to Jump for
this controller's convenience also switches it for every other connected
device. A user running this motorized-fader controller alongside a second,
non-motorized controller (a very common setup - most users have more than
one MIDI controller connected) would get every one of that second
controller's knobs jumping the parameter instantly to match the knob's
physical position the moment it's touched, rather than requiring a
catch-up gesture first - a real, surprising behavior change on hardware
this script has nothing to do with and no way to shield from the switch.

**Workaround we shipped:** none available for the cross-controller case -
`disableTakeOver()` only covers this script's own faders, which is a
different, narrower problem (motorized vs. non-motorized) than the global
setting's actual scope. The only mitigation is documentation: this
project's own README now carries an explicit setup warning that changing
this preference for this controller's benefit is a Studio-wide change,
not a per-controller one, and to check it against every other connected
controller before relying on it.

**What would have helped:** expose Takeover Mode per controller
script/output (the same granularity `disableTakeOver()` already proves is
architecturally possible per-control, just not surfaced as a user-facing
preference), so tuning it for one controller's needs can't silently change
behavior for a user's other, unrelated gear. Also: it isn't readable from
script at all, and its exact interaction with a script's own `.set()`
calls on a bound parameter was never fully pinned down during this project
(see `patches/README.md`'s "Follow-up lead" section) - a readable value
plus clearer documentation of how it composes with scripted writes would
have saved a full investigation cycle on its own, independent of the
per-controller-scoping problem above.
