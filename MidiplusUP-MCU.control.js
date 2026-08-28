// Midiplus UP Bitwig Controller Script (Standard MCU Mode)
// Author: Sternenlicht / Claude
// API Version: 25
//
// This hardware is run in the Up/Up+'s standard "MCU" control mode (not one
// of the Logic/Cubase/Live "customized" modes - see the manual, section 3.3
// and section 8), with the plastic Ableton Live overlay's top piece
// removed - the left and right pieces are still in place, so only the
// buttons under the top piece show their real printed labels; buttons
// under the left/right pieces still show their Live-overlay labels.
// Note numbers below match the
// standard Mackie Control Universal protocol (cross-checked against both
// Ableton's own shipped "MackieControl" remote script and Jurgen
// Mossgraber's open-source DrivenByMoss MCU driver - both land on identical
// note numbers, e.g. fader touch = 104-112). Live-testing on this exact unit
// (pressing every button and reading the console's "RAW Note-On received"
// log) confirmed the note map is IDENTICAL to what this script used while
// the hardware was still in Live mode with the overlay on - switching modes
// only affects onboard LED/display behavior the manual documents, not which
// note a given physical button sends. So functions that were bound to a
// Live-overlay label (B.T.A., DRAW, SMPTE/BEATS, RETURNS, SESS/ARR, ...) are
// unchanged; only the comments below have been updated to note the button's
// real printed MCU label alongside its Bitwig-repurposed behavior.
//
// Faders (see hwFaders/hwMasterFader and rebindFaders() below) use Bitwig's
// native hardware-binding API (HardwareSurface.createHardwareSlider() +
// setBinding()) rather than manually parsing/sending pitch-bend - Bitwig
// itself keeps the motorized fader position in sync with whatever Parameter
// it's bound to, for hardware input AND for mouse-driven/automation-driven
// changes, with no sendMidi() needed in this script at all.

loadAPI(25);

// Define Controller Metadata
host.defineController(
   "Midiplus",
   "Midiplus UP (MCU Mode)",
   "3.0.0-native-faders",
   "6f56e9e0-0871-4623-a178-5e82485a3c10",
   "Sternenlicht / Claude"
);

// Define MIDI Ports (1 Input, 1 Output)
host.defineMidiPorts(1, 1);

// Auto-discovery pairs for Midiplus UP
host.addDeviceNameBasedDiscoveryPair(["Midiplus UP"], ["Midiplus UP"]);
host.addDeviceNameBasedDiscoveryPair(["UP"], ["UP"]);
host.addDeviceNameBasedDiscoveryPair(["Midiplus UP MCU"], ["Midiplus UP MCU"]);
host.addDeviceNameBasedDiscoveryPair(["Midiplus UP MIDI 1"], ["Midiplus UP MIDI 1"]);

// Control Modes
var MODE_MIXER = 0;   // Faders 1-8 = Track Volume 1-8, Encoders = Pan
var MODE_SENDS = 1;   // Faders 1-8 = Send Levels (Press 1: Sends 1-8, Press 2: Sends 9-16, Press 3: Exit)
var MODE_DEVICE = 2;  // Encoders = 8 Remote Control Macros
var MODE_SCENE = 3;   // BTA: jog wheel selects a scene, wheel push launches it

var MAX_SENDS = 16;
// Name to search for when looking for the per-track gain-staging utility
// device (see PAN / isToolVolumeMode below). Match is case-sensitive and
// exact - rename your Tool device instances to this if you change it.
var TOOL_DEVICE_NAME = "TRLVL";
// How many devices deep into each track's chain to search for a device
// named TOOL_DEVICE_NAME. Was 4, raised to match EQ_DEVICE_SCAN_DEPTH's
// 32 (per request) - gain staging (this Tool device) is typically done
// AFTER EQ and other corrective processing, right before the track's own
// level, so a gain-staging utility commonly sits deep in the chain, not
// near the front. Raise further if your chains routinely run deeper
// than this.
var TOOL_DEVICE_SCAN_DEPTH = 32;
// How many devices deep into the SELECTED track's chain "EQ Mode"
// (SHIFT+PLUG-INS - see findLastEqDeviceIndex()/case 44 below) searches
// for the LAST device whose name matches EQ_DEVICE_NAME_KEYWORDS. Raise
// if your chains routinely run deeper than this.
var EQ_DEVICE_SCAN_DEPTH = 32;
// How many cue markers deep SHIFT+HOME's "Bar N" auto-naming (see
// findAndRenamePendingCueMarker()/case 89 below) searches to find the
// marker it just created. Raise if a project routinely has more markers
// than this before the point you're adding new ones.
var CUE_MARKER_SCAN_DEPTH = 128;

// ---------------------------------------------------------------------
// DEBUG / Diagnostics hub (Controller Preferences panel -> "Debug"
// category) - every println() used purely for development/diagnostic
// logging (not a genuine error) is routed through debugLog() below and
// gated by one of these flags, instead of being unconditionally on or
// manually commented out. All default to true for now, matching this
// project's current maturity - it's still being actively wired up and
// verified against real hardware, so seeing everything by default makes
// that easier. DEBUG_ENABLED is the master switch: turning it off in
// Bitwig's Controller Preferences both silences every category below
// regardless of its own setting AND hides their individual checkboxes
// from the panel entirely (via Setting.hide()/show(), see init()) - a
// preview of fully retiring this section once the project is more
// mature and end users shouldn't see it at all. Genuine error logging
// (caught exceptions, invalid action ids, duplicate F-key assignments,
// etc.) is intentionally NOT gated by any of this - those stay
// unconditional so real problems are never accidentally silenced by a
// debug setting.
var DEBUG_ENABLED = true;
// Raw incoming MIDI dump straight from the controller - every CC not
// otherwise handled, and every Note-On (which also carries the current
// SHIFT/OPTION/CTRL/ALT/ZOOM/SCRUB modifier state, gated separately by
// DEBUG_MODIFIER_STATE below) - the main "verify what a physical
// button/wheel actually sends" tool.
var DEBUG_RAW_MIDI = true;
// "Button pressed - Note:" - logged once a Note-On has passed modifier
// filtering and actually reached handleButtonPress(), so it's easy to
// tell "the hardware sent something" (DEBUG_RAW_MIDI above) apart from
// "the script recognized and dispatched it" (this one).
var DEBUG_BUTTON_DISPATCH = true;
// Whether the RAW Note-On line above includes the live modifier/toggle
// state suffix ("[SHIFT=... OPTION=... CTRL=... ALT=... ZOOM=...
// SCRUB=...]"). Its own flag since that suffix is the noisiest part of
// an already-noisy line - useful when chasing a modifier-dependent bug,
// unnecessary clutter otherwise.
var DEBUG_MODIFIER_STATE = true;
// Text sent to the two-row MCU LCD display via sendMCUSysex() - lets a
// display formatting bug be read straight from the console instead of
// having to eyeball tiny hardware LCD characters.
var DEBUG_LCD = true;
// Encoder-target classification (applyEncoderStep()) - reports a
// pointed-at parameter's real discreteValueCount() when it exceeds
// MAX_NATIVE_SWITCH_STEPS, for calibrating that constant against real
// hardware/device values.
var DEBUG_ENCODER = true;

// Central gate for every diagnostic println() in this script - pass one
// of the category flags above (not a literal true/false) so both the
// per-category setting AND the DEBUG_ENABLED master switch are honored
// in one place. Real error logging bypasses this entirely (see above).
function debugLog(categoryEnabled, message) {
   if (DEBUG_ENABLED && categoryEnabled) {
      println(message);
   }
}

var currentMode = MODE_MIXER;
// Tracks currentMode as of the last applyModeChange() call - see there for
// why this is how leaving MODE_DEVICE closes the plugin window centrally.
var previousMode = MODE_MIXER;
var sendBankPage = 0; // 0 = Sends 1-8, 1 = Sends 9-16

// "Send/Return Bank Size" (Controller Preferences -> "Mixer" category) -
// "8" (one page, SEND toggles straight between Sends 1-8 and Mixer - less
// paging for anyone who rarely uses more than 8 sends) or "16" (default,
// today's existing 3-state cycle: 1-8 -> 9-16 -> Mixer). Only changes how
// many pages a NORMAL SEND press cycles through - the underlying send
// bank itself is always created at the full 16 (MAX_SENDS, unchanged),
// so this is purely about the button's own paging behavior and takes
// effect live with no reload needed. Even at "8", the other 8 sends stay
// reachable via SHIFT+SEND (see case 41) - jumps straight to Sends 9-16
// from anywhere, regardless of this setting - so choosing "8" for less
// everyday paging doesn't lock anyone out of the rest when they actually
// need them. Default; overridden live from the Controller Preferences
// panel setting created in init() below.
var sendBankConfiguredPages = 2;
var lastAssignmentNote = 40; // last note updateModeLEDs() lit in the Assignment row - see there
var isFlipped = false;

// Hardware Modifier States (note numbers confirmed against Ableton's own
// MackieControl driver - see file header)
var isShiftPressed = false;   // Note 70
var isOptionPressed = false;  // Note 71
var isControlPressed = false; // Note 72
var isAltPressed = false;     // Note 73

// ALT + Jog Wheel adjusts whichever parameter was last clicked in
// Bitwig's own GUI - see the wheel handler in onMidi(). Both created
// once in init() via host.createLastClickedParameter() - lastClickedParam
// is an ObjectProxy (like CursorTrack/CursorDevice elsewhere in this
// file), so it and the Parameter it hands back both stay valid as stable
// references that automatically retarget under the hood, rather than
// needing to be re-fetched on every use.
var lastClickedParam = null;
var lastClickedParamValue = null;

// OPTION + Jog Wheel Push (note 101) toggles this: LastClickedParameter's
// own smartToggleLock() locks ALT+wheel onto whatever parameter the mouse
// is currently hovering, without needing an exact click - and if already
// locked and the mouse has moved to a different parameter, re-locks to
// that one instead of unlocking (Bitwig's own "smart" behavior, see its
// Javadoc). isLocked() mirrors that locked/unlocked state so the popup
// notification below can report it. See the wheel-push handler in
// onMidi() and its init() setup.
var lastClickedParamLocked = null;

// Each of the 4 modifier buttons above also tracks whether it was "used"
// to modify another action (a jog-wheel combo, mostly) while held - see
// setUsedForCombo()/wasUsedForCombo() below. This gates the *standalone
// tap* actions (Plugin Mode settings below) so releasing a modifier that
// was actually just held to modify something else doesn't also fire its
// own tap action.
var shiftUsedForCombo = false;
var optionUsedForCombo = false;
var ctrlUsedForCombo = false;
var altUsedForCombo = false;

function setUsedForCombo(note) {
   if (note === 70) { shiftUsedForCombo = true; }
   else if (note === 71) { optionUsedForCombo = true; }
   else if (note === 72) { ctrlUsedForCombo = true; }
   else if (note === 73) { altUsedForCombo = true; }
}

function wasUsedForCombo(note) {
   if (note === 70) { return shiftUsedForCombo; }
   if (note === 71) { return optionUsedForCombo; }
   if (note === 72) { return ctrlUsedForCombo; }
   if (note === 73) { return altUsedForCombo; }
   return false;
}

// Plugin Mode settings (Controller Preferences panel -> this controller ->
// "Plugin Mode" category, set up in init() below) - which modifier button
// toggles the expanded device view, whether that's an instant tap or a
// long press, whether that also opens the plugin window (jumping into
// Device mode from anywhere, not just toggling the view while already
// there), and which modifier button cycles the selected device's macro
// bank. -1 means "None" (disabled). Defaults: Expanded Device View off
// (requested directly - CTRL is the most ergonomic modifier and is
// already heavily used for wheel combos; a long-press mode-switch/window
// -open living on the same button was reported as confusing and prone
// to firing unintentionally while just trying to use CTRL+wheel. F1-F8
// already covers device select + open-window, so nothing is lost by
// disabling this by default - still available on any modifier via the
// "Expanded Device View Button" dropdown for anyone who wants it), ALT
// tap for macro bank.
var MODIFIER_NAME_TO_NOTE = { "SHIFT": 70, "OPTION": 71, "CTRL": 72, "ALT": 73, "None": -1 };
var EXPANDED_VIEW_BUTTON = -1;
var EXPANDED_VIEW_INSTANT = false; // false = long press, true = instant tap
// Whether the Expanded Device View action also opens (and, on the next
// press, closes) the plugin window - so the button both expands AND shows
// the device, in one press, instead of needing PLUG-INS/F1-F8 pressed
// first.
var EXPANDED_VIEW_OPENS_WINDOW = true;
var MACRO_CYCLE_BUTTON = 73;
// Whether opening a device's plugin window (PLUG-INS, F1-F8 direct
// select, EQ Mode, or the Expanded Device View action above) first
// closes every OTHER device's window on the current track's chain, for
// an "only one plugin window open at a time" workflow - see
// closeOtherDeviceWindowsIfConfigured() below. Scoped to the current
// track's 8-slot device chain (cursorDeviceBank) only - the Controller
// API has no way to enumerate open plugin windows project-wide, and
// EQ Mode's own match can be deeper than that (see eqDeviceBank/
// EQ_DEVICE_SCAN_DEPTH), so a device past slot 8 with its own window
// still open won't get closed by this either.
var CLOSE_OTHER_PLUGIN_WINDOWS = false;

// Closes every other device's plugin window on the current track's chain
// (see CLOSE_OTHER_PLUGIN_WINDOWS above) - call this BEFORE opening the
// target device's own window, not after, so if the target happens to be
// one of the 8 bank slots this doesn't immediately re-close it.
function closeOtherDeviceWindowsIfConfigured() {
   if (!CLOSE_OTHER_PLUGIN_WINDOWS) {
      return;
   }
   for (var closeIdx = 0; closeIdx < 8; closeIdx++) {
      cursorDeviceBank.getItemAt(closeIdx).isWindowOpen().set(false);
   }
}

// Green-state F1-F8 (notes 62-69, intercepted directly in onMidi - see the
// "F1-F8 Green State" block there, and handleFKeyPress()/
// handleFKeyRelease() below) - configurable "editing function" keys, set
// via the 8 "F1-F8 Function (Green State)" Controller Preferences
// dropdowns in init(). Every press shows the pressed key's action name as
// a Bitwig on-screen popup (host.showPopupNotification, full name, same
// as the orange state's "Device N" popup - see invokeFKeyFunction()) plus
// a brief LCD popup of just that key's own abbreviated name (<=7
// characters - see FKEY_SHORT_NAMES below), same as any other one-shot
// LCD popup. Only an actual HOLD (past FKEY_HOLD_THRESHOLD_MS) escalates
// to revealing EVERY F-key's assigned name across all 8 channel strips'
// bottom LCD rows at once (showAllFKeyAssignments()), staying there for
// as long as the button is physically held rather than a fixed timeout -
// a quick tap stays a lightweight confirmation, not the full "what could
// I press" overlay every single time.
//
// Entries with a `method` call a dedicated, typed Application method
// (guaranteed correct, not guessed). Entries with an `actionId` have no
// such method in the Controller API, so they go through the generic
// application.getAction(id)/invoke() mechanism (safeInvokeAction())
// instead - every actionId below is copied verbatim from
// bitwig-actions-reference.txt (the full captured+verified action list),
// not guessed, unlike Consolidate's id originally was (see git history).
var FKEY_FUNCTIONS = {
   "Duplicate": { method: "duplicate" },
   "Cut": { method: "cut" },
   "Copy": { method: "copy" },
   "Paste": { method: "paste" },
   "Delete": { method: "remove" },
   "Rename": { method: "rename" },
   "Select All": { method: "selectAll" },
   "Select None": { method: "selectNone" },
   "Undo": { method: "undo" },
   "Redo": { method: "redo" },
   "Consolidate": { actionId: "Consolidate" },
   // Editing category (bitwig-actions-reference.txt).
   "Activate": { actionId: "Activate" },
   "Deactivate": { actionId: "Deactivate" },
   "Duplicate as Alias": { actionId: "Duplicate Reference" },
   "Flatten as Track Automation": { actionId: "unwrap" },
   "Group": { actionId: "Group" },
   "Ungroup": { actionId: "Ungroup" },
   "Paste as Alias": { actionId: "Paste Reference" },
   "Switch between Object and Time Selection": { actionId: "switch_between_event_and_time_selection" },
   "Toggle Active/Mute State": { actionId: "Toggle Active" },
   "Toggle Hold": { actionId: "toggle_hold" },
   "Toggle On / Off": { actionId: "toggle_on_off" },
   "Turn On": { actionId: "turn_on" },
   "Turn Off": { actionId: "turn_off" },
   "Wrap as Automation Clip": { actionId: "wrap" },
   // File category (bitwig-actions-reference.txt).
   "New Project": { actionId: "New" },
   "Open...": { actionId: "Open" },
   "Save": { actionId: "Save" },
   "Save as...": { actionId: "Save as" },
   "Close": { actionId: "Close" },
   "Quit": { actionId: "Quit" },
   "New From Template...": { actionId: "new_from_template" },
   "Save as Template...": { actionId: "save_as_template" },
   "Save to Library...": { actionId: "add_to_library" },
   "Import Wavetables...": { actionId: "import_wavetables" },
   "Import Impulses...": { actionId: "import_impulses" },
   // Selection category.
   "Select item at cursor": { actionId: "select_item_at_cursor" },
   // General category - a keyboard-focus click (activates whatever UI
   // element currently has keyboard focus), not a mouse-position click.
   "Click button": { actionId: "Click button" },
   // Moved off notes 82/83 once those turned out to be printed "PAGE
   // (left/right arrow)" under the Ableton overlay and were repurposed
   // to page device macro banks in MODE_DEVICE instead (see case 82/83)
   // - both real actions, ids confirmed from bitwig-actions-reference.txt.
   "Add Cue Marker at Playhead": { actionId: "insert_arranger_cue_marker_at_play_position" },
   "Toggle Follow Playhead": { actionId: "toggle_playhead_follow" }
};

// Explicit ordered list (rather than Object.keys(FKEY_FUNCTIONS), whose
// key order isn't guaranteed in every JS engine) for the dropdown option
// lists - "None" first, then FKEY_FUNCTIONS' entries in the order above.
var FKEY_FUNCTION_NAMES = ["None"].concat(Object.keys(FKEY_FUNCTIONS));

// Hand-picked <=7-character abbreviations for the LCD (which only has 7
// characters per cell - see formatString()) - plain left-truncation of
// the full names collides for several of them (e.g. "Select All",
// "Select None" and "Select item at cursor" all truncate to the
// identical "Select "; "Toggle Active/Mute State", "Toggle Hold" and
// "Toggle On / Off" all truncate to "Toggle "), which defeats the whole
// point of showing a name while the button is held - see
// showBottomRowPopupWhileHeld() below. Only used for the LCD text; the
// on-screen Bitwig popup (host.showPopupNotification in
// invokeFKeyFunction()) always shows the real, full name, since that
// popup isn't width-constrained. Falls back to the plain 7-char
// truncation (formatString(name, 7)) for any name without an entry here.
var FKEY_SHORT_NAMES = {
   "Duplicate": "Duplic",
   "Select All": "SelAll",
   "Select None": "SelNone",
   "Consolidate": "Consol",
   "Activate": "Activ",
   "Deactivate": "Deactv",
   "Duplicate as Alias": "DupAlia",
   "Paste as Alias": "PasteAl",
   "Switch between Object and Time Selection": "ObjTime",
   "Toggle Active/Mute State": "TglMute",
   "Toggle Hold": "TglHold",
   "Toggle On / Off": "TglOnOf",
   "Turn On": "TurnOn",
   "Turn Off": "TurnOff",
   "Wrap as Automation Clip": "WrapAut",
   "New Project": "NewProj",
   "Save as...": "SaveAs",
   "New From Template...": "NewTmpl",
   "Save as Template...": "SavTmpl",
   "Save to Library...": "SavLib",
   "Import Wavetables...": "ImpWave",
   "Import Impulses...": "ImpImpl",
   "Select item at cursor": "SelCurs",
   "Click button": "ClickBt",
   "Add Cue Marker at Playhead": "CueMark",
   "Toggle Follow Playhead": "TglFoll"
};

function invokeFKeyFunction(name) {
   if (name === "None") {
      return;
   }
   host.showPopupNotification(name);
   // The LCD side is handled by the caller (handleFKeyPress() above) -
   // a brief single-key popup by default, escalating to the full all-8
   // reveal only on an actual hold - not here, since this function alone
   // can't tell a tap from a hold.

   var entry = FKEY_FUNCTIONS[name];
   if (!entry) {
      return;
   }
   if (entry.method) {
      application[entry.method]();
   } else if (entry.actionId) {
      // Popups already shown above - don't pass popupText here, or
      // safeInvokeAction would show a redundant duplicate on success.
      safeInvokeAction(entry.actionId, null);
   }
}

// Currently-configured function per green-state F-key (index 0 = F1/note
// 62 ... index 7 = F8/note 69). Defaults match the user's own examples
// (F1 = Duplicate, F2 = Consolidate); populated live by the 8 Controller
// Preferences dropdowns in init().
var fKeyFunctionAssignment = ["Duplicate", "Consolidate", "None", "None", "None", "None", "None", "None"];

// How long an F-key's LCD name display lingers after release - see
// revertBottomRowPopup() above. Default; overridden live from the
// Controller Preferences panel setting created in init() below.
var FKEY_HOLD_LINGER_MS = 300;

// A normal quick press still just shows the ONE pressed key's own name
// as a brief, auto-reverting popup (showBottomRowPopup, same as any other
// one-shot LCD popup) - the all-8-keys learning reveal
// (showAllFKeyAssignments()) only kicks in if the button is actually held
// past this threshold, so a quick tap gets a lightweight confirmation of
// what it just did rather than the full "what could I press" overlay
// every single time. See handleFKeyPress()/handleFKeyRelease() below.
// Default; overridden live from the Controller Preferences panel setting
// created in init() below.
var FKEY_HOLD_THRESHOLD_MS = 400;

// Per-F-key state for the tap-vs-hold distinction above: fkeyPressGeneration
// is bumped on every press and release so a stale scheduled hold-escalation
// check (from a press that's since been released, or superseded by a new
// press) becomes a no-op, same debounce-generation-token pattern used
// everywhere else in this file; fkeyHoldRevealActive tracks whether THIS
// key's hold escalated to the all-8 reveal, so release knows whether to
// revert it (revertAllFKeyAssignments()) or leave it alone (a plain tap's
// own popup already scheduled its own ordinary revert).
var fkeyPressGeneration = [0, 0, 0, 0, 0, 0, 0, 0];
var fkeyHoldRevealActive = [false, false, false, false, false, false, false, false];

function handleFKeyPress(fkeyIdx) {
   var assigned = fKeyFunctionAssignment[fkeyIdx];
   if (assigned !== "None") {
      invokeFKeyFunction(assigned);
      showBottomRowPopup(fkeyIdx, FKEY_SHORT_NAMES[assigned] || assigned);
   }

   fkeyHoldRevealActive[fkeyIdx] = false;
   fkeyPressGeneration[fkeyIdx]++;
   var myGeneration = fkeyPressGeneration[fkeyIdx];
   host.scheduleTask(function () {
      if (fkeyPressGeneration[fkeyIdx] !== myGeneration) {
         return; // released (or pressed again) before the hold threshold
      }
      fkeyHoldRevealActive[fkeyIdx] = true;
      showAllFKeyAssignments();
   }, FKEY_HOLD_THRESHOLD_MS);
}

function handleFKeyRelease(fkeyIdx) {
   fkeyPressGeneration[fkeyIdx]++; // cancels a still-pending hold escalation
   if (fkeyHoldRevealActive[fkeyIdx]) {
      fkeyHoldRevealActive[fkeyIdx] = false;
      revertAllFKeyAssignments();
   }
   // else: nothing to do - a plain tap's own popup (see handleFKeyPress())
   // already scheduled its own ordinary revert via showBottomRowPopup.
}

// Bitwig's getEnumSetting() dropdowns can't have their option list
// changed at runtime (confirmed against the Controller API Javadoc - no
// such method on Preferences/SettableEnumValue), so there's no way to
// make an already-picked function disappear from the other 7 dropdowns
// the way real "pick from a shrinking list" UI would. This is the closest
// available substitute: whenever any of the 8 change, re-scan all 8 for
// the same function (other than "None") assigned twice, and surface it
// via a popup + console warning instead of silently allowing it (or
// being able to structurally prevent it).
function warnIfDuplicateFKeyFunctions() {
   for (var i = 0; i < 8; i++) {
      if (fKeyFunctionAssignment[i] === "None") {
         continue;
      }
      for (var j = i + 1; j < 8; j++) {
         if (fKeyFunctionAssignment[j] === fKeyFunctionAssignment[i]) {
            var msg = "F" + (i + 1) + " and F" + (j + 1) + " are both set to " + fKeyFunctionAssignment[i];
            println("Duplicate F-key function assignment: " + msg);
            host.showPopupNotification(msg);
         }
      }
   }
}

// Press-start timestamp for whichever note is currently EXPANDED_VIEW_BUTTON
// (only meaningful when EXPANDED_VIEW_INSTANT is false - see
// handleModifierTap() below).
var expandedViewPressStartTime = 0;
// Default; overridden live from the Controller Preferences panel setting
// created in init() below (see ctrlHoldTimeSetting).
var CTRL_LONG_PRESS_MS = 500;

// Shared "temporarily override the bottom LCD row, then revert" debounce
// token - one array covering both use cases below (pan-reveal-while-
// turning and one-shot status popups like SOLO/UNSOLO), so the two never
// race each other on the same channel: whichever happens more recently
// always wins, and only the LAST scheduled revert for a channel actually
// fires (Bitwig's scheduleTask has no way to cancel a still-pending call,
// so this "does my token still match the current one" check is how
// earlier, now-superseded timers are made into no-ops).
var lcdOverrideGeneration = [0, 0, 0, 0, 0, 0, 0, 0];
var LCD_OVERRIDE_TIMEOUT_MS = 800;

// Mixer mode's bottom LCD row always shows volume (see
// setupChannelStripObservers) - while an encoder is actively being turned
// to adjust pan (its usual unflipped Mixer-mode target), the bottom row
// temporarily shows the live pan value instead, reverting back to volume
// after the encoder stops moving. Needs LIVE updates for the whole
// duration (the value keeps changing as the encoder turns), unlike the
// one-shot popups below - isShowingPanTemporarily gates the pan
// displayedValue observer in setupChannelStripObservers.
var isShowingPanTemporarily = [false, false, false, false, false, false, false, false];

function revealPanTemporarily(index) {
   isShowingPanTemporarily[index] = true;
   lcdOverrideGeneration[index]++;
   var myGeneration = lcdOverrideGeneration[index];
   host.scheduleTask(function () {
      if (lcdOverrideGeneration[index] !== myGeneration) {
         return;
      }
      isShowingPanTemporarily[index] = false;
      if (currentMode === MODE_MIXER && !isFlipped) {
         refreshDisplayText();
      }
   }, LCD_OVERRIDE_TIMEOUT_MS);
}

// Encoder acceleration/response curve (Controller Preferences -> new
// "Encoders" category) - a continuous 0-100% dial, not fixed presets, so
// it can be tuned to the user's own dexterity rather than picked from a
// handful of buckets. 0% (default) matches the raw hardware behavior
// exactly - no extra curve on top of whatever the encoder itself reports
// per MIDI message. Maps to an exponent from 1.0 (0%, no curve) to 2.0
// (100%, strongest), applied not to the raw per-message tick count alone
// but to a TIME-based velocity ratio (see computeEncoderVelocityRatio()
// below) - how many ticks per second this turn actually represents,
// relative to ENCODER_VELOCITY_BASELINE_TICKS_PER_SEC, rather than just
// how many ticks happened to land in one MIDI message. Raw tick count
// alone is a rough proxy for turning speed at best - the same rawDelta
// can arrive after 5ms (a fast flick) or 200ms (a slow, deliberate turn
// whose ticks just happened to batch into one message), and those should
// NOT accelerate the same amount. This needed nothing beyond a per-
// encoder Date.now() timestamp captured at the moment each CC message
// already arrives (lastEncoderTickTime below) - purely event-driven, no
// added polling/timer/background cost of any kind, since it only runs
// inside the exact same onMidi() handler this already went through.
// Turning at or below the baseline rate is unaffected at every curve
// setting (a ratio of 1 stays 1 regardless of exponent) - only a turn
// faster than that baseline gets boosted further, so a careful turn
// feels identical regardless of this setting; only how much a fast flick
// "runs ahead" changes. Feeds into the continuous/fine adjustment in
// applyEncoderStep() below (not Stepped mode - see there for why).
// Default; overridden live from the Controller Preferences panel setting
// created in init() below.
var ENCODER_ACCELERATION_PERCENT = 0;

// Per-encoder timestamp (Date.now(), ms) of the last CC 16-23 message
// seen for that encoder - the only state computeEncoderVelocityRatio()
// needs, updated every message regardless of whether acceleration is
// even on, so the timing history is always current if it's switched on
// mid-session. 0 = no message seen yet for that encoder this session.
var lastEncoderTickTime = [0, 0, 0, 0, 0, 0, 0, 0];

// A rough estimate, not (yet) hardware-calibrated, of how many ticks per
// second a normal, unhurried turn produces on this controller - the
// point below which the velocity ratio stays at 1 (no acceleration
// boost). May need adjusting once tested on real hardware timing.
var ENCODER_VELOCITY_BASELINE_TICKS_PER_SEC = 20;

// Floor on the measured inter-message gap, so two messages arriving only
// a millisecond or two apart (e.g. a burst from the same physical
// detent) can't produce an absurdly inflated ticks-per-second figure from
// dividing by a near-zero time span.
var ENCODER_VELOCITY_MIN_DT_MS = 4;

// Returns how many times faster than ENCODER_VELOCITY_BASELINE_TICKS_PER_SEC
// this specific tick's implied turning speed is (1 = at or below
// baseline, higher = faster) - see the acceleration comment above for
// why this uses elapsed time rather than just the raw tick count.
function computeEncoderVelocityRatio(encoderIndex, rawDelta) {
   var now = Date.now();
   var last = lastEncoderTickTime[encoderIndex];
   lastEncoderTickTime[encoderIndex] = now;
   if (last === 0) {
      return 1; // first message seen for this encoder - no history yet to measure speed from
   }
   var dtMs = Math.max(now - last, ENCODER_VELOCITY_MIN_DT_MS);
   var ticksPerSecond = (Math.abs(rawDelta) * 1000) / dtMs;
   return Math.max(1, ticksPerSecond / ENCODER_VELOCITY_BASELINE_TICKS_PER_SEC);
}

function applyEncoderAcceleration(rawDelta, velocityRatio) {
   if (ENCODER_ACCELERATION_PERCENT <= 0 || rawDelta === 0) {
      return rawDelta;
   }
   var exponent = 1.0 + (ENCODER_ACCELERATION_PERCENT / 100);
   var boost = Math.pow(velocityRatio, exponent - 1);
   return rawDelta * boost;
}

// "SHIFT+Encoder Mode" (Controller Preferences -> "Encoders" category) -
// "Stepped" (default) or "Fine". A plain encoder turn always stays
// today's existing smooth continuous adjustment, unchanged. Holding
// SHIFT is what selects between the two: "Stepped" jumps in fixed
// ENCODER_STEP_SIZE_PERCENT increments instead, landing exactly on round
// multiples - e.g. audio pan moves in clearly audible, evenly-spaced
// jumps rather than a smooth sweep, easier to judge by ear than tiny
// continuous nudges - requested specifically after noticing electronic
// instrument hardware often prefers this for exactly that reason.
// "Fine" keeps SHIFT's older role instead (0.2x-scaled precise
// adjustment), for anyone who'd rather SHIFT stay a precision override
// than become the stepping gesture. Either way this only applies to
// genuinely continuous targets - see applyEncoderStep() below for how a
// target that's actually a discrete/switch parameter (Bitwig's
// Controller API exposes this via discreteValueCount() - confirmed
// capable of telling a macro that's an on/off switch apart from a
// continuous knob) always steps through its own real native states
// instead, regardless of SHIFT or this setting, since there's no
// meaningful "fine" or "stepped-by-percent" adjustment of an on/off
// switch. When set to "Stepped", also falls back to Fine while Arranger
// Automation Write is enabled (see
// transport.isArrangerAutomationWriteEnabled() in applyEncoderStep()) -
// recording automation usually wants a smooth curve, not abrupt stepped
// jumps - UNLESS allowSteppedDuringAutomationWrite (below) is on, for the
// specific case of someone actually wanting stepped automation recorded.
// Defaults; overridden live from the Controller Preferences panel
// settings created in init() below.
var shiftEncoderMode = "Stepped";
var ENCODER_STEP_SIZE_PERCENT = 10;

// Off by default - the "Stepped" SHIFT+Encoder Mode falls back to Fine
// while Arranger Automation Write is enabled (see applyEncoderStep()
// above), since recording abrupt stepped jumps into automation is an
// unusual thing to want. Its own separate setting rather than baking
// that fallback in unconditionally, since it IS a real, if niche, use
// case someone might deliberately want (e.g. intentionally recording
// hard, quantized automation steps) - this is how they opt back into it.
var allowSteppedDuringAutomationWrite = false;

// Unified encoder-turn handler for CC 16-23 - resolves whichever
// behavior actually applies for this specific target and turn, then
// performs it:
//  1. Target is a genuine discrete/switch parameter - discreteValueCount()
//     is a real positive count, not -1 for continuous, AND small enough
//     (<= MAX_NATIVE_SWITCH_STEPS, currently 16) to actually be a switch
//     or short mode list rather than just a knob with a finer-than-
//     continuous native grid - always steps through its own real native
//     states, exactly one per message, regardless of SHIFT/SHIFT+Encoder
//     Mode/acceleration/automation write (there's no meaningful "fine" or
//     "accelerated multi-step" adjustment of a switch). Shows the
//     resulting state's real name (from discreteValueNames(), if the
//     device provides one) in a popup, so turning past a macro that's
//     actually a switch rather than a continuous knob is immediately
//     obvious from the label instead of a raw percentage. A discreteCount
//     ABOVE the cap falls through to cases 2-4 below instead, treated as
//     continuous - confirmed on hardware that without this cap, a macro
//     with a much finer native resolution (e.g. ~50 steps = 2% each) also
//     took this branch and always jumped a full native step regardless of
//     the configured Encoder Step Size, which is a different problem than
//     a genuine switch and shouldn't be handled the same way.
//  2. SHIFT held, SHIFT+Encoder Mode is "Stepped", and stepping isn't
//     currently suppressed by Arranger Automation Write being enabled
//     (see allowSteppedDuringAutomationWrite above) - jumps exactly ONE
//     ENCODER_STEP_SIZE_PERCENT increment per message, landing exactly on
//     round multiples. Deliberately NOT run through
//     applyEncoderAcceleration() - see the comment inline below for why.
//  3. SHIFT held, otherwise (Mode is "Fine", or Stepped suppressed by
//     Automation Write) - the older fine, continuous adjustment
//     (0.2x-scaled .inc()).
//  4. Plain turn, no SHIFT - today's existing plain continuous .inc()
//     behavior, unchanged.
// Acceleration (applyEncoderAcceleration() above) only scales cases 3-4 -
// the regular continuous/fine moves it was actually meant to smooth out -
// never case 2's stepped jumps, which are already their own, much
// coarser form of "acceleration" over a fine nudge; compounding the curve
// on top of that would accelerate an already-accelerated gesture.
function applyEncoderStep(target, rawDelta, encoderIndex) {
   // Always updates the timing history (see computeEncoderVelocityRatio()
   // above), even on branches below that don't end up using the result,
   // so the history is current the moment acceleration is turned on.
   var velocityRatio = computeEncoderVelocityRatio(encoderIndex, rawDelta);
   var discreteCount = target.discreteValueCount().get();
   // Only treat it as a genuine switch/enum - always step through its own
   // native states, bypassing every setting below - if it has FEW enough
   // states that "native step" and "a deliberate choice" are the same
   // thing (an on/off switch, a short mode list). Confirmed on hardware:
   // without this cap, a macro that's technically discrete but has a
   // much finer native resolution (e.g. ~50 steps = 2% each) also took
   // this branch, always jumping a full native step (2%) regardless of
   // the configured Encoder Step Size (1%) - "can't select value 1, it
   // always jumps to +2 or -2". That's not this hardware's MIDI
   // resolution (the encoders' own relative-tick protocol, sign-magnitude
   // 1-63/-64, is unrelated and unaffected either way) - it's Bitwig's
   // own reported native resolution for THAT specific parameter, which a
   // percentage-based step size can't act finer than once treated as a
   // switch. Above this cap, it's treated as continuous instead (falls
   // through to Stepped/Fine below, so the configured step size and
   // acceleration are respected) - Bitwig will still snap the result to
   // its own nearest valid native value if ours doesn't land on one
   // exactly, but at least our own setting drives the intent instead of
   // being silently overridden by an unrelated device's native grid.
   var MAX_NATIVE_SWITCH_STEPS = 16;
   if (discreteCount > 0 && discreteCount <= MAX_NATIVE_SWITCH_STEPS) {
      var curIndex = Math.round(target.get() * (discreteCount - 1));
      var newIndex = rawDelta < 0 ?
         Math.max(0, curIndex - 1) : Math.min(discreteCount - 1, curIndex + 1);
      if (newIndex === curIndex) {
         return;
      }
      target.set(discreteCount > 1 ? newIndex / (discreteCount - 1) : 0);
      var discreteNames = target.discreteValueNames().get();
      if (discreteNames && discreteNames[newIndex]) {
         host.showPopupNotification(discreteNames[newIndex]);
      }
      return;
   }
   if (discreteCount > MAX_NATIVE_SWITCH_STEPS) {
      // Confirms the discreteCount actually reported for whatever this
      // encoder is currently pointed at - helps verify/calibrate
      // MAX_NATIVE_SWITCH_STEPS against real hardware/device values if a
      // parameter still doesn't land where expected in Stepped mode. See
      // DEBUG_ENCODER above.
      debugLog(DEBUG_ENCODER, "Encoder target has discreteValueCount() " + discreteCount +
         " (> " + MAX_NATIVE_SWITCH_STEPS + ") - treated as continuous, native grid ignored");
   }

   // Encoder Push + Turn Fine Resolution (Device mode only) - see
   // deviceEncoderPushBehavior/DEVICE_ENCODER_PUSH_FINE_MULTIPLIER/
   // encoderPushHeld above. Takes priority over SHIFT below (a more
   // specific, single-encoder, deliberate gesture) - not stacked with it,
   // so holding SHIFT while also pushing an encoder still just gets fine
   // resolution, not some combination of both scalings.
   if (currentMode === MODE_DEVICE && encoderPushHeld[encoderIndex] &&
      deviceEncoderPushBehavior === "Fine Resolution") {
      var pushFineResolution = 128 * DEVICE_ENCODER_PUSH_FINE_MULTIPLIER;
      target.inc(applyEncoderAcceleration(rawDelta, velocityRatio) * 0.2,
         isNearOrigin(target) ? pushFineResolution * FINE_ZONE_RESOLUTION_MULTIPLIER : pushFineResolution);
      return;
   }

   if (isShiftPressed) {
      var steppingSuppressedByAutomationWrite = !allowSteppedDuringAutomationWrite &&
         transport.isArrangerAutomationWriteEnabled().get();
      if (shiftEncoderMode === "Stepped" && !steppingSuppressedByAutomationWrite) {
         // Always exactly one step per message, deliberately NOT run
         // through applyEncoderAcceleration() - stepping in fixed
         // percentage jumps is already its own, much coarser form of
         // "acceleration" over a fine continuous nudge; piling the
         // acceleration curve on top as well (letting a fast turn jump
         // several steps at once) would accelerate an already-accelerated
         // gesture. Acceleration is reserved for scaling the regular,
         // continuous encoder move (the two .inc() calls below) - the one
         // case it was actually meant to smooth out.
         var stepSize = ENCODER_STEP_SIZE_PERCENT / 100;
         var curStepIndex = Math.round(target.get() / stepSize);
         var newStepIndex = rawDelta < 0 ? curStepIndex - 1 : curStepIndex + 1;
         var newVal = Math.min(1, Math.max(0, newStepIndex * stepSize));
         target.set(newVal);
         return;
      }
      target.inc(applyEncoderAcceleration(rawDelta, velocityRatio) * 0.2,
         isNearOrigin(target) ? 512 * FINE_ZONE_RESOLUTION_MULTIPLIER : 512);
      return;
   }

   target.inc(applyEncoderAcceleration(rawDelta, velocityRatio),
      isNearOrigin(target) ? 128 * FINE_ZONE_RESOLUTION_MULTIPLIER : 128);
}

// Encoders are hard to land exactly on a parameter's own "home" value by
// hand (no detent on this hardware) - originally just pan (center = 0.5),
// but generalized once it turned out Bitwig's Controller API exposes the
// REAL origin of any RangedValue (pan/volume/macro/send alike) via
// getOrigin() - 0.5 for a bipolar/centered parameter like pan or an
// oscillator fine-tune macro (turn right to pitch up, left to pitch down,
// centered = no detune), 0 for a plain level. "Encoder Snap to Origin"
// (Controller Preferences -> "Encoders" category) snaps the value to
// exactly that real origin once the encoder comes to REST within its
// context's own snap range (2% by default - see
// DEVICE_ENCODER_SNAP_THRESHOLD/MIXER_ENCODER_SNAP_THRESHOLD below),
// rather than requiring the separate encoder-push reset - and now applies
// to whatever the encoder currently targets in ANY mode (Mixer pan/volume,
// Device/Plugin macros, Sends), not just Mixer-mode pan, using each
// target's own real origin instead of a hardcoded 0.5. Enable and range
// are configured separately per context (Device/Plugin mode vs. Mixer
// mode) so the two can be tuned independently without interfering with
// each other. Skipped entirely for a genuine
// discrete/switch target (see applyEncoderStep() above) - there's no
// continuous "close to origin" to land on for something that only has a
// handful of real states. Idle-based (checked ENCODER_SNAP_IDLE_MS after
// the last tick, see scheduleEncoderSnapCheck() below) rather than
// snapping on every tick that lands inside the zone - an earlier per-tick
// version snapped every message once close to center, which meant the
// very next tiny increment landed back inside the zone too and got
// yanked straight back, permanently trapping the value there. A later
// "only snap on the tick that crosses into the zone from outside" version
// fixed the trapping but then often didn't snap at all on hardware - the
// MCU protocol batches several physical clicks into one MIDI message's
// step count, so an ordinary-speed turn frequently jumps clean across the
// whole zone in a single message and is never actually observed "inside"
// it. Waiting for the encoder to stop and checking where it landed
// sidesteps both problems. Defaults; overridden live from the Controller
// Preferences panel settings created in init() below.
//
// Enable and range are split into two independent contexts - Device/
// Plugin mode (macros) vs. everything under Mixer mode (pan, volume,
// sends) - after direct feedback that a single shared toggle/range made
// the two interfere: dialing the range in for how a fine-tune macro
// behaves in Device mode also silently changed how pan snapped in Mixer
// mode, with no way to tune one without the other. isDeviceModeContext()
// below decides which pair of settings applies; the idle delay
// (ENCODER_SNAP_IDLE_MS) stays a single shared value, since it's a
// hardware turn-debounce timing rather than a "where/whether to snap"
// decision that differs meaningfully by context.
var deviceSnapToOriginEnabled = true;
var DEVICE_ENCODER_SNAP_THRESHOLD = 0.02;
var mixerSnapToOriginEnabled = true;
var MIXER_ENCODER_SNAP_THRESHOLD = 0.02;
var ENCODER_SNAP_IDLE_MS = 300;

function isDeviceModeContext() {
   return currentMode === MODE_DEVICE;
}

function snapToOriginEnabledForCurrentContext() {
   return isDeviceModeContext() ? deviceSnapToOriginEnabled : mixerSnapToOriginEnabled;
}

function snapToOriginThresholdForCurrentContext() {
   return isDeviceModeContext() ? DEVICE_ENCODER_SNAP_THRESHOLD : MIXER_ENCODER_SNAP_THRESHOLD;
}

// getOrigin() is only reliably 0.5 for parameters Bitwig itself classifies
// as pan-like; a generically-wrapped, genuinely bipolar plugin parameter
// (e.g. Serum 2's oscillator Fine Tune macro) reports 0 instead, even
// though its real "no detune" center sits at 0.5 - confirmed via
// diagnostic logging on hardware: the value hovered around 0.50 while
// getOrigin() reported a flat 0.0000 throughout, so both Finer Resolution
// Near Center and Encoder Snap to Origin (below) silently never activated
// at the actual center being aimed for.
//
// The first fix here (blindly treating ANY reported origin of 0 as 0.5)
// was flagged as too broad: only a few specific controls in a plugin like
// Serum 2 are actually bipolar/centered (fine tune, oscillator pan) - most
// of a device's other macros with origin 0 are genuinely, correctly
// zero-based, and shouldn't have this override applied just because
// SOMETHING on that instrument happens to be bipolar too. Checked the
// Controller API for a more precise signal to key off instead
// (`RemoteControl`/`Parameter extend RangedValue`, whose only members are
// name(), discreteValueCount()/discreteValueNames(), getOrigin(), and
// displayedValue() - no unit, type, or "is bipolar" flag anywhere) -
// name() is genuinely the only usable one; displayedValue() is the live
// formatted value, not a stable type descriptor, so it can't serve as a
// classifier. nameSuggestsBipolar() below matches the macro's own name
// (as mapped/labeled on the Remote Controls page - either the plugin's
// own reported parameter name, or the user's own custom label if the
// slot's been renamed, both work identically since it's just a string
// match either way) against BIPOLAR_NAME_KEYWORDS as a case-insensitive
// substring, so the override only ever applies to a macro actually named
// like something bipolar, not to every 0-origin macro on the device.
//
// A bare "tun" was flagged as still too unspecific - checked the actual
// manuals for Serum 2, u-he Hive, Diva, Zebra 2/3, and Repro (rather than
// guessing) for their real pitch-tuning control names: Serum's own
// pitch-section labels are literally "Fine"/"Coarse" (not "Tune" at all -
// confirmed from the official manual), Diva's fine-tune automation
// parameter is abbreviated "FTun", Hive's own documentation describes
// "separate parameters... for octave, semi and fine tune" (literal
// phrase), Zebra 3 has a standalone bipolar "Tune" (+/-48 semitones) AND
// a "Fine Tune", and Repro has "Fine Tuning"/"OSC B Fine Tune".
//
// Bringing plain "tune" back into the list (to catch Zebra 3's standalone
// "Tune") reopens the exact problem that got "tun" dropped in the first
// place - a bare substring match can't tell "Tune" apart from "Detune",
// and unison/voice-spread "Detune" (Serum's Unison Detune, Hive/Zebra's
// Detune knob) is NOT bipolar; it's a 0-based intensity (0 = tight, max =
// wide). Zebra 2/3's OWN "Detune" is worse still, being bipolar in Single
// oscillator mode but becoming that same non-bipolar spread amount in
// Dual/Quad/Eleven mode - the identical name meaning something different
// depending on another setting entirely.
//
// Fixed properly instead of dodged: nameSuggestsBipolar() below now does
// a WORD-BOUNDARY match (`\bkeyword\b`, via bipolarNameRegexes, compiled
// once by rebuildBipolarNameRegexes() rather than per-tick) instead of a
// raw substring. "tune" as a whole word matches "Tune" and "Fine Tune"
// (both have "Tune" as its own word) but does NOT match "Detune" (no
// boundary before "tune" there) - so "tune" is safe to include again
// without reopening the Detune trap, and "fine tune" as a separate
// keyword becomes redundant (already covered by "tune" + "fine"
// individually) so it's dropped from the default. Add "detune" yourself
// only if you know it's safe for how you actually use it - word-boundary
// matching keeps it as its own deliberate, explicit choice rather than an
// accidental side effect of wanting "tune".
var assumeCenterForBipolarNamedMacros = true;
var BIPOLAR_NAME_KEYWORDS = "pan,tune,fine,ftun,offset";
var bipolarNameRegexes = [];

// Escapes regex metacharacters in a user-typed keyword before it's
// dropped into a RegExp literal, so a keyword like "1.5" or "(mod)"
// can't accidentally build an invalid or unintended pattern.
function escapeRegExp(text) {
   return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rebuilds bipolarNameRegexes from BIPOLAR_NAME_KEYWORDS - called once at
// startup below and again whenever the Controller Preferences setting
// changes, so nameSuggestsBipolar() (on the hot path: it runs on every
// encoder tick that Finer Resolution Near Center/Encoder Snap to Origin check,
// whenever the target's origin is 0) just tests pre-compiled regexes
// instead of rebuilding one from scratch per keyword on every call.
function rebuildBipolarNameRegexes() {
   bipolarNameRegexes = [];
   var keywords = BIPOLAR_NAME_KEYWORDS.split(",");
   for (var i = 0; i < keywords.length; i++) {
      var keyword = keywords[i].trim();
      if (keyword) {
         bipolarNameRegexes.push(new RegExp("\\b" + escapeRegExp(keyword) + "\\b", "i"));
      }
   }
}
rebuildBipolarNameRegexes();

function nameSuggestsBipolar(target) {
   var name = target.name().get();
   if (!name) {
      return false;
   }
   for (var i = 0; i < bipolarNameRegexes.length; i++) {
      if (bipolarNameRegexes[i].test(name)) {
         return true;
      }
   }
   return false;
}

// Shared by isNearOrigin() and scheduleEncoderSnapCheck() below - see
// assumeCenterForBipolarNamedMacros/nameSuggestsBipolar() above for why
// this isn't just target.getOrigin().get() directly. Only ever calls
// name() (needs the target's name() marked interested - see the
// markInterested() calls added alongside every other encoder target's
// discreteValueCount()/getOrigin() in init()) when the origin is actually
// 0, so a target whose real, correctly-reported origin is already 0.5
// (Pan, or a correctly-classified bipolar macro) never even reaches the
// name check.
function resolveOrigin(target) {
   var origin = target.getOrigin().get();
   if (origin === 0 && assumeCenterForBipolarNamedMacros && nameSuggestsBipolar(target)) {
      return 0.5;
   }
   return origin;
}

// "Finer Resolution Near Center" (Encoders category, default on) - a narrow-range,
// origin-centered macro (e.g. an oscillator fine-tune knob, or pan) is hard
// to land back on its exact center by hand: even the coarsest single tick's
// normalized-space movement (~0.8% at the plain turn's resolution 128)
// already overshoots a target you're trying to nudge to within a percent
// or two of center - "it jumps between +1 and -1, hard to adjust back to
// center". When enabled, any tick that lands within FINE_ZONE_RANGE of
// target.getOrigin() sharpens the resolution passed to target.inc() by
// FINE_ZONE_RESOLUTION_MULTIPLIER, so ticks near center move in smaller
// increments than ticks further out - independent of, and stacking with,
// SHIFT's own resolution bump. Only applies to the two continuous
// (Fine-mode) .inc() calls in applyEncoderStep() below - not the
// discrete-switch branch (no "near origin" concept applies to an enum) and
// not Stepped mode (which already lands exactly on the origin whenever the
// configured step size divides evenly into it, e.g. 10% steps hit
// 50%/origin=0.5 exactly). Defaults; overridden live from the Controller
// Preferences panel settings created in init() below.
var fineZoneNearOriginEnabled = true;
var FINE_ZONE_RANGE = 0.05;
var FINE_ZONE_RESOLUTION_MULTIPLIER = 4;

// True if target's current value sits within FINE_ZONE_RANGE of its own
// real origin (see getOrigin() discussion above Encoder Snap to Origin).
function isNearOrigin(target) {
   if (!fineZoneNearOriginEnabled) {
      return false;
   }
   var origin = resolveOrigin(target);
   return Math.abs(target.get() - origin) <= FINE_ZONE_RANGE;
}

// "Encoder Push Behavior (Device/Plugin Mode)" (Encoders category) -
// requested directly, and specifically scoped to Device mode: Mixer/Sends
// mode's encoder push keeps its existing behavior untouched (an
// immediate reset-to-origin the moment it's pressed - see the note 32-39
// case inside handleButtonPressInner below - "more useful there" per
// direct feedback), while in Device mode the SAME physical gesture (push
// the encoder's own click) can instead mean "hold this encoder down while
// turning it for finer resolution", a very different but equally useful
// action for macro knobs specifically. Three mutually exclusive choices,
// not stacked - only one is ever active at a time:
//   "Fine Resolution" (default) - pressing an encoder in Device mode
//      arms encoderPushHeld[index] (see the note 32-39 interception in
//      onMidi below, alongside Fader Touch/F-Keys, so both press AND
//      release are available); applyEncoderStep() checks this and, while
//      held, scales the resolution passed to target.inc() by
//      DEVICE_ENCODER_PUSH_FINE_MULTIPLIER instead of doing anything on
//      release. No reset-on-tap fallback - that's what the "Reset to
//      Default" choice below is for.
//   "Reset to Default" - keeps the classic single-press behavior (same
//      call Mixer mode's encoder push already uses,
//      remoteControls.getParameter(index).reset()) for anyone who'd
//      rather have Device mode match Mixer mode's gesture for
//      consistency instead of gaining the fine-turn gesture.
//   "Open/Close Plugin Window" - pressing ANY of the 8 encoders toggles
//      cursorDevice.isWindowOpen() (same object applyModeChange() closes
//      automatically on leaving Device mode) instead of touching the
//      macro at all - a quick way to pop the plugin's own GUI open or
//      closed without reaching for the mouse. Doesn't depend on which
//      encoder was pressed, since it's a device-wide toggle, not a
//      per-macro action.
// Defaults; overridden live from the Controller Preferences panel
// settings created in init() below.
var deviceEncoderPushBehavior = "Fine Resolution";
var DEVICE_ENCODER_PUSH_FINE_MULTIPLIER = 8;
var encoderPushHeld = [false, false, false, false, false, false, false, false];

// "Select Channel on Fader Touch" (Mixer category, default on) - see the
// Fader Touch handling in onMidi (notes 104-112) below. Overridden live
// from the Controller Preferences panel setting created in init() below.
var selectChannelOnFaderTouch = true;

// "Select Channel on Fader Touch Delay (ms)" (Mixer category, default 0 =
// immediate/instant, matching classic MCU behavior) - riding several
// faders together means touching them in quick succession, and selecting
// on every individual touch would make the selected track (and anything
// following it, like the device panel) flicker between channels through
// the whole grab instead of settling once. A nonzero delay debounces
// that: each touch (re)arms a single shared, gesture-wide generation
// token (bumped every touch across ANY of the 8+1 faders, not per-fader -
// see scheduleSelectChannelOnTouch() below) and only the touch that's
// still the latest one once the delay has elapsed without another touch
// actually fires the selection - so a fast multi-finger grab settles on
// whichever fader you're still holding once things go quiet, rather than
// selecting each one in turn as you reach for it. Overridden live from
// the Controller Preferences panel setting created in init() below.
var SELECT_ON_TOUCH_DELAY_MS = 0;
var selectOnTouchGeneration = 0;

// selectInMixer() alone (the only one ever called here before) only sets
// Mixer-panel selection - confirmed on hardware that a track selected
// this way shows no visible change in the Arranger at all (no "white
// circle" around the track header, unlike a real mouse click there) and
// doesn't establish whatever anchor select_item_at_cursor/"Select item
// above"/"Select item below" need to navigate clips. Channel.select()
// is deprecated specifically in favor of two separate calls -
// selectInMixer() and selectInEditor() ("Selects the device chain in
// Bitwig Studio [Arranger/editors]") - so selectInEditor() is very
// likely the missing piece: added alongside selectInMixer() at every
// track-selection call site in this script (here, selectBankSlot() and
// the SELECT button handler below) to also set the Arranger's own
// selection/focus state a real mouse click would. Not yet confirmed on
// hardware whether this actually produces the white circle or unblocks
// the wheel-press clip-navigation experiments.
function scheduleSelectChannelOnTouch(track) {
   if (SELECT_ON_TOUCH_DELAY_MS <= 0) {
      track.selectInMixer();
      track.selectInEditor();
      cursorTrack.selectChannel(track);
      return;
   }
   selectOnTouchGeneration++;
   var myGeneration = selectOnTouchGeneration;
   host.scheduleTask(function () {
      if (selectOnTouchGeneration !== myGeneration) {
         return;
      }
      track.selectInMixer();
      track.selectInEditor();
      cursorTrack.selectChannel(track);
   }, SELECT_ON_TOUCH_DELAY_MS);
}

// Tracks which of the 8 channel faders (0-7) or the master fader (8) is
// CURRENTLY physically held, per this hardware's own Note-On/Note-Off for
// each fader's touch sensor (see the Fader Touch handling in onMidi
// below) - independent of, and in addition to, the delay/debounce above.
// Reported after testing on hardware: with "Select Channel on Fader
// Touch" on, holding one fader steady still kept reselecting a DIFFERENT
// channel - i.e. touch events were arriving for faders that weren't
// actually being held, something delay alone can't fix since it only
// debounces a fast burst of genuinely-intended touches, not a stray touch
// arriving while another fader is already confirmed down. Whichever
// fader touches down FIRST holds the "focus lock" - isFaderTouchLocked()
// below - so a fader other than the one already held is not allowed to
// steal the selection until the held one is released, however many
// (possibly spurious) touch messages arrive for other channels in the
// meantime. This directly matches "a held fader should keep the channel
// in focus" - whether the extra touch messages are a deliberate second
// hand or a hardware/touch-sense quirk on this particular unit, the
// fix is the same either way.
var faderTouchHeld = [false, false, false, false, false, false, false, false, false];

function isFaderTouchLocked(faderTouchIndex) {
   for (var i = 0; i < faderTouchHeld.length; i++) {
      if (i !== faderTouchIndex && faderTouchHeld[i]) {
         return true;
      }
   }
   return false;
}

// "Fader Snap to Zero" (Mixer category) - requested directly: landing a
// motorized fader exactly on true -inf (normalized 0 - "true volume zero")
// by hand is as fiddly as landing an encoder exactly on its origin, for
// the same reason (no detent). When enabled (default on), releasing a
// fader that's currently sitting within FADER_SNAP_ZERO_RANGE of the
// bottom schedules a check FADER_SNAP_ZERO_DELAY_MS later; if the fader
// is STILL untouched at that point (re-touching during the delay cancels
// it - see faderSnapZeroGeneration below) and still within range, it
// snaps the rest of the way down to exactly 0. Deliberately release-
// triggered rather than checked continuously while moving: a motorized
// fader's position during a drag is exactly where the hand put it, so
// there's nothing to "snap" until the hand lets go - unlike an encoder,
// which has no absolute position of its own and can drift from its last
// intended stop. Applies to whatever the fader is CURRENTLY bound to
// (Volume in Mixer mode, Send level in Sends mode, or - under FLIP - Pan/
// device macros), same generalization as Encoder Snap to Origin; skipped
// for a genuine discrete/switch target, which has no continuous "close to
// the bottom" to land on. Defaults; overridden live from the Controller
// Preferences panel settings created in init() below.
var faderSnapToZeroEnabled = true;
var FADER_SNAP_ZERO_RANGE = 0.03;
var FADER_SNAP_ZERO_DELAY_MS = 500;

// Same debounce-generation-token pattern as encoderSnapGeneration below -
// bumped every time a check is (re)scheduled, so if a fader is released,
// touched again, and released again before the first delay elapses, only
// the LAST release's check ever actually fires. The callback also
// re-checks faderTouchHeld itself directly (see scheduleFaderSnapZeroCheck
// above), so a re-touch that's still held once the delay elapses is
// caught even without a fresh release to bump this.
var faderSnapZeroGeneration = [0, 0, 0, 0, 0, 0, 0, 0, 0];

function scheduleFaderSnapZeroCheck(index, target) {
   faderSnapZeroGeneration[index]++;
   var myGeneration = faderSnapZeroGeneration[index];
   host.scheduleTask(function () {
      if (faderSnapZeroGeneration[index] !== myGeneration) {
         return;
      }
      if (!faderSnapToZeroEnabled || faderTouchHeld[index]) {
         return;
      }
      if (target.discreteValueCount().get() > 0) {
         return;
      }
      if (target.get() <= FADER_SNAP_ZERO_RANGE) {
         target.set(0);
      }
   }, FADER_SNAP_ZERO_DELAY_MS);
}

// "Mixer Mode PAGE: Loop Behavior" - see findAdjacentMarkerPosition()/
// jumpToMarkerAndSetLoop() above (the notes 82/83 handling in Device
// mode is untouched by this - only Mixer mode's PAGE gains this
// behavior). "Keep Loop Length" (default - matches normal workflow, per
// direct feedback) just relocates the loop to start at the target
// marker, keeping whatever length it already had; "Loop Between Markers"
// instead loops the section from the target marker to the next one
// chronologically (falling back to the arrangement's end if the target
// is the last marker). Defaults; overridden live from the Controller
// Preferences panel setting created in init() below.
var mixerPageLoopBehavior = "Keep Loop Length";

// Same debounce-generation-token pattern as revealPanTemporarily() below
// (and lcdOverrideGeneration) - only the LAST scheduled check for a given
// encoder actually fires; every further tick before it bumps the token
// and makes the earlier, now-superseded check a no-op, so the value is
// only evaluated once it's truly stopped moving for ENCODER_SNAP_IDLE_MS.
var encoderSnapGeneration = [0, 0, 0, 0, 0, 0, 0, 0];

function scheduleEncoderSnapCheck(index, target) {
   encoderSnapGeneration[index]++;
   var myGeneration = encoderSnapGeneration[index];
   host.scheduleTask(function () {
      if (encoderSnapGeneration[index] !== myGeneration) {
         return;
      }
      // Read live at fire time, same as target.get() below - a mode
      // switch mid-turn is rare, but if it happens the check should use
      // whichever context is actually current when it fires, not
      // whichever was current back when the turn started.
      if (!snapToOriginEnabledForCurrentContext()) {
         return;
      }
      var origin = resolveOrigin(target);
      if (Math.abs(target.get() - origin) <= snapToOriginThresholdForCurrentContext()) {
         target.set(origin);
      }
   }, ENCODER_SNAP_IDLE_MS);
}

// One-shot status popup (e.g. SOLO/UNSOLO on the solo toggle) - shows
// `text` in channel `index`'s bottom LCD row immediately, then reverts to
// whatever refreshDisplayText() would normally show there (correct for
// whichever mode is active by the time it fires, not just Mixer/volume)
// after LCD_OVERRIDE_TIMEOUT_MS, unless superseded first by another
// popup or a pan-reveal on the same channel.
function showBottomRowPopup(index, text) {
   isShowingPanTemporarily[index] = false;
   bottomRowText[index] = formatString(text, 7);
   displayNeedsUpdate = true;
   lcdOverrideGeneration[index]++;
   var myGeneration = lcdOverrideGeneration[index];
   host.scheduleTask(function () {
      if (lcdOverrideGeneration[index] !== myGeneration) {
         return;
      }
      refreshDisplayText();
   }, LCD_OVERRIDE_TIMEOUT_MS);
}

// Held version of showBottomRowPopup() - shows `text` in channel `index`'s
// bottom LCD row and stays there indefinitely, with NO auto-revert
// timeout, until revertBottomRowPopup() (below) is explicitly called -
// used for F1-F8's green-state function-key names (see
// showAllFKeyAssignments() further below) so the names stay legible for
// as long as the button is physically held, however long that turns out
// to be, instead of disappearing after a fixed timeout regardless of hold
// duration.
// Still bumps lcdOverrideGeneration so any of showBottomRowPopup()'s own
// pending timed reverts on this channel become no-ops rather than
// stomping this while it's still meant to be showing.
function showBottomRowPopupWhileHeld(index, text) {
   isShowingPanTemporarily[index] = false;
   bottomRowText[index] = formatString(text, 7);
   displayNeedsUpdate = true;
   lcdOverrideGeneration[index]++;
}

// Reverts channel `index`'s bottom row back to whatever refreshDisplayText()
// would normally show there - the explicit counterpart to
// showBottomRowPopupWhileHeld() above, called on the F-key's Note-Off.
// Doesn't revert instantly by default: FKEY_HOLD_LINGER_MS (Timing
// category, default 300ms - see the Controller Preferences setting in
// init()) keeps it up a little longer after release, since a genuinely
// quick tap could otherwise release before there was ever enough time to
// read the name at all - a long hold already gets however much time it
// was actually held, this only pads out the minimum for a short one.
// Bumps lcdOverrideGeneration immediately either way, so it also cancels
// out any showBottomRowPopup()-style timed revert that might still be
// pending on this same channel; if the same F-key gets pressed again
// before the linger elapses, showBottomRowPopupWhileHeld()'s own
// generation bump on that next press makes this pending revert a no-op,
// same debounce pattern used everywhere else in this file.
function revertBottomRowPopup(index) {
   lcdOverrideGeneration[index]++;
   if (FKEY_HOLD_LINGER_MS <= 0) {
      refreshDisplayText();
      return;
   }
   var myGeneration = lcdOverrideGeneration[index];
   host.scheduleTask(function () {
      if (lcdOverrideGeneration[index] !== myGeneration) {
         return;
      }
      refreshDisplayText();
   }, FKEY_HOLD_LINGER_MS);
}

// Reveals ALL 8 green-state F-key assignments across all 8 channel
// strips' bottom LCD rows at once - not just the one that was pressed -
// requested so holding any single F-key shows what every other F-key is
// currently mapped to as well, a "what could I press" reference rather
// than only confirming the one just used. Unassigned keys ("None") show
// "-" so it's clear they're deliberately empty rather than not yet
// revealed. Shares showBottomRowPopupWhileHeld()/revertBottomRowPopup()
// (and their hold-until-release / FKEY_HOLD_LINGER_MS behavior) with the
// single-key version above, just looped across all 8 channels - so if two
// F-keys were ever held at once, releasing one would revert all 8
// (including the still-held one's channel, which would immediately
// re-populate correctly next tick anyway) rather than tracking each
// channel's "how many F-keys are currently keeping it revealed"
// separately; not worth the extra bookkeeping for hardware with one hand
// and eight fingers' worth of function buttons in a single row.
function showAllFKeyAssignments() {
   for (var i = 0; i < 8; i++) {
      var assigned = fKeyFunctionAssignment[i];
      var text = assigned === "None" ? "-" : (FKEY_SHORT_NAMES[assigned] || assigned);
      showBottomRowPopupWhileHeld(i, text);
   }
}

function revertAllFKeyAssignments() {
   for (var i = 0; i < 8; i++) {
      revertBottomRowPopup(i);
   }
}

// Whole-strip version of showBottomRowPopup() - shows `text` across all 8
// channels' bottom row at once (a mode-change announcement, e.g. "PLUGIN"/
// "SENDS"/"RETURNS"/"MIXER"), then reverts all 8 to whatever
// refreshDisplayText() shows for the (by then already-changed) current
// mode. Uses its own single shared token (modePopupGeneration) rather than
// the per-channel one, so it isn't affected by - and doesn't need to
// individually track - whatever per-channel popups happen to be pending;
// it still bumps each channel's own token too, so any of THEIR pending
// reverts become no-ops instead of firing mid-announcement and stomping it.
var modePopupGeneration = 0;

function showModePopup(text) {
   modePopupGeneration++;
   var myGeneration = modePopupGeneration;
   for (var popupIdx = 0; popupIdx < 8; popupIdx++) {
      isShowingPanTemporarily[popupIdx] = false;
      bottomRowText[popupIdx] = formatString(text, 7);
      lcdOverrideGeneration[popupIdx]++;
   }
   displayNeedsUpdate = true;
   host.scheduleTask(function () {
      if (modePopupGeneration !== myGeneration) {
         return;
      }
      refreshDisplayText();
   }, LCD_OVERRIDE_TIMEOUT_MS);
}

// Called on release of any of the 4 modifier buttons (see the SHIFT/
// OPTION/CTRL/ALT blocks in onMidi below) - handles the two configurable
// Plugin Mode standalone-tap actions (see the settings above). Both are
// no-ops if `note` isn't currently assigned to either action, or if the
// button was actually just held to modify something else this press.
function handleModifierTap(note, isPressed) {
   if (isPressed) {
      if (note === EXPANDED_VIEW_BUTTON) {
         expandedViewPressStartTime = Date.now();
      }
      return;
   }

   var usedForCombo = wasUsedForCombo(note);

   if (note === EXPANDED_VIEW_BUTTON && EXPANDED_VIEW_BUTTON >= 0 && !usedForCombo) {
      var longPressOk = EXPANDED_VIEW_INSTANT || (Date.now() - expandedViewPressStartTime) >= CTRL_LONG_PRESS_MS;
      if (longPressOk && EXPANDED_VIEW_OPENS_WINDOW) {
         // Also opens/closes the plugin window in lockstep with the
         // expanded-view state (computed here, rather than blindly calling
         // .toggle(), specifically so the window's open/closed state can
         // mirror it - toggle() alone doesn't hand back the new value) -
         // so this works as a one-press shortcut into the expanded view
         // from any mode, and a second press collapses the view AND
         // closes the window again.
         if (currentMode !== MODE_DEVICE) {
            currentMode = MODE_DEVICE;
            sendBankPage = 0;
            isToolVolumeMode = false;
            cursorDevice.selectFirst();
            applyModeChange(null);
         }
         var nowExpanded = !cursorDevice.isExpanded().get();
         if (nowExpanded) {
            closeOtherDeviceWindowsIfConfigured();
         }
         cursorDevice.isExpanded().set(nowExpanded);
         cursorDevice.isWindowOpen().set(nowExpanded);
      } else if (longPressOk && currentMode === MODE_DEVICE) {
         // Window-opening disabled - only toggle expanded view, and only
         // while already in Device mode (original behavior).
         cursorDevice.isExpanded().toggle();
      }
   }

   // A single note assigned to both actions always means "expanded view
   // wins" - macro-bank cycling only fires for a *different* note.
   if (note === MACRO_CYCLE_BUTTON && MACRO_CYCLE_BUTTON >= 0 && note !== EXPANDED_VIEW_BUTTON && !usedForCombo) {
      remoteControls.selectNextPage(true);
      host.showPopupNotification("Next Macro Bank");
   }
}

// Physical jog wheel push/click, note 87 on this hardware (also the
// standard Mackie Control protocol's PUNCH IN note - it was briefly wired
// up as a Punch-In toggle on release, but this hardware re-sends Note-On 87
// unreliably while held whenever another button is pressed alongside it,
// making press/release tracking too flaky for a tap-to-toggle action - so
// that's been dropped). Pure momentary hold modifier: while held, the jog
// wheel pans the arranger timeline left/right by whole bars instead of the
// default quarter-note scrub (same jump-target math as toggling SCRUB).
var isWheelPressed = false;

// PLUG-INS Button (Note 44): a press still reaches handleButtonPress() for
// its own action (jump to the first device on the selected track and open
// its panel), but held state is also tracked here so the jog wheel can
// step through devices while it's held - see isPluginHeld below.
var isPluginHeld = false;
var pluginDeviceStepAccumulator = 0;
var PLUGIN_DEVICE_STEP_MESSAGES = 4;

// CTRL + Jog Wheel (outside MODE_DEVICE) - selects the next/previous
// arranger clip/item. Own dedicated, independently configurable
// threshold (Controller Preferences -> "Wheel Options" category) rather
// than reusing PLUGIN_DEVICE_STEP_MESSAGES, so this can be tuned
// separately from device-stepping.
var clipSelectStepAccumulator = 0;
var CLIP_SELECT_STEP_MESSAGES = 4;

// "Override Wheel Combo Thresholds" (Timing) - convenience override for
// anyone who doesn't want to tune CTRL/SHIFT+CTRL/ALT+CTRL's tick
// thresholds separately. When on, all three combos use the single
// "Global Tick Threshold (All Combos)" value below instead of their own
// individual settings; the individual settings stay visible/settable in
// the panel but are ignored while this is on, so switching it back off
// restores each combo's own last value with nothing lost.
var useGlobalWheelTicks = false;
var globalWheelTicks = 16;

// Each combo's own individual-setting value, tracked separately from the
// live CLIP_SELECT_STEP_MESSAGES/SHIFT_CTRL_WHEEL_THRESHOLD/
// ALT_CTRL_WHEEL_THRESHOLD globals below (which reflect whichever -
// global or individual - is actually in effect right now, per
// applyWheelTickSettings()).
var clipSelectStepIndividual = 4;
var shiftCtrlWheelThresholdIndividual = 16;
var altCtrlWheelThresholdIndividual = 16;

// Recomputes the three live thresholds from either the shared global tick
// count or each combo's own individual setting, depending on
// useGlobalWheelTicks. Called from every relevant Controller Preferences
// observer (see init()) so a change to any one of these five settings -
// including flipping the checkbox itself - takes effect immediately.
function applyWheelTickSettings() {
   CLIP_SELECT_STEP_MESSAGES = useGlobalWheelTicks ? globalWheelTicks : clipSelectStepIndividual;
   SHIFT_CTRL_WHEEL_THRESHOLD = useGlobalWheelTicks ? globalWheelTicks : shiftCtrlWheelThresholdIndividual;
   ALT_CTRL_WHEEL_THRESHOLD = useGlobalWheelTicks ? globalWheelTicks : altCtrlWheelThresholdIndividual;
}

// MODE_SCENE (BTA, note 80): which of the 8 scenes in sceneBank's window is
// currently selected - the jog wheel moves this, note 87 (wheel push)
// launches it. Same wheel-message debounce pattern as the combos above.
var sceneCursorIndex = 0;
var sceneStepAccumulator = 0;
var SCENE_STEP_MESSAGES = 4;

// BANK PREV/NEXT Buttons (Notes 46/47): a press still reaches
// handleButtonPress() for their own bank-paging action, but held state is
// also tracked (either one) so the jog wheel can page through the current
// device's remote-control pages while held - see isBankHeld below.
var isBankHeld = false;
var bankPageStepAccumulator = 0;
var BANK_PAGE_STEP_MESSAGES = 4;

// ZOOM (100) is a TOGGLE button in the real protocol (press to flip
// state, not held-while-down like SHIFT/OPTION/CTRL/ALT).
var isZoomToggled = false;

// Currently dead/unreachable: note 101 (originally assumed to be a
// dedicated "SCRUB Button" toggling this) turned out to actually be the
// Jog Wheel's own click note instead - confirmed via systematic testing
// of every wheel-assignment button, see the Jog Wheel Push handler and
// README. The real SCRUB control sends no MIDI at all when pressed, so
// there's currently no known way to set this to true. Left in place
// (rather than removed) since the Pan Mode branch below still checks it
// alongside isWheelPressed, and it's harmless as a permanently-false
// value - ready to wire up again if a real SCRUB note is ever found.
var isScrubToggled = false;

// ZOOM+LEFT/RIGHT (case 98/99 - LEFT/RIGHT send notes 98/99 on this
// hardware, not 96/97 as an earlier round assumed from the printed
// labels) - reported as unsatisfying: LEFT/RIGHT
// previously fired "Zoom to Fit"/"Zoom to Selection" (two mismatched
// canned actions, not actual continuous zoom) as a workaround for
// application.zoomIn()/zoomOut() confirmed not working on hardware.
// Now uses arrangerHorizontalScrollbar.zoomAtPosition(position, distance)
// (see init()) instead - a genuine relative horizontal zoom, centered on
// the current playhead position, distance in powers of 2 (2^distance
// multiplies content-per-pixel, so +1 = 200% content/pixel = zoomed OUT,
// -1 = 50% content/pixel = zoomed IN). RIGHT = zoom in (distance -1),
// LEFT = zoom out (distance +1) - an arbitrary but reversible direction
// choice, easy to swap if it feels backwards on hardware.
// ZOOM_ARROW_STEP is the |distance| used per press - default 1 (a full
// double/halve per press, matching the exponential-step convention
// OPTION+Wheel's loop halve/double already uses in this file); raise for
// coarser jumps, lower (e.g. 0.5) for finer per-press control.
// Default; overridden live from the Controller Preferences panel setting
// created in init() below.
var ZOOM_ARROW_STEP = 1;

// DRAW (note 81): cycles through the 6 arranger edit tools (Bitwig's own
// keyboard shortcuts 1-6), wrapping back to the first after the sixth
// press. Real action ids confirmed via the DRAW-button diagnostic dump
// (application.getActions(), filtered to names containing "tool").
var ARRANGER_TOOL_ACTIONS = [
   { id: "select_object_selection_tool", name: "Pointer Tool" },
   { id: "select_time_selection_tool", name: "Time Selection Tool" },
   { id: "select_create_tool", name: "Pencil Tool" },
   { id: "select_spray_tool", name: "Spray Can Tool" },
   { id: "select_erase_tool", name: "Eraser Tool" },
   { id: "select_cut_tool", name: "Knife Tool" }
];
var arrangerToolCycleIndex = 0;

// Default (no modifier) Jog Wheel scrub - how many WHOLE BARS the
// playhead jumps per wheel message, always landing exactly on a bar
// start. Originally beat-based (reported as too slow at a fixed 1
// beat/message), then reported as inconsistent-feeling once widened -
// jumping by an arbitrary beat count could land mid-bar, "jumping
// between individual beats" instead of a clean bar-to-bar scroll.
// Redone to always move in whole bars and always anchor on a bar
// boundary, regardless of mode below. Default; overridden live from the
// Controller Preferences panel setting created in init() below.
var DEFAULT_WHEEL_SCRUB_BARS = 1;

// Adaptive alternative to the fixed bar count above - requested
// directly: faster playhead movement per tick when zoomed further OUT,
// slower when zoomed further IN, so the wheel always feels proportional
// to what's actually visible rather than a fixed bar count that feels
// tiny zoomed out and huge zoomed in. When on, effectiveWheelScrubBars()
// below computes the bar count from arrangerHorizontalScrollbar.
// getContentPerPixel() (the actual live zoom level, in beats/pixel - see
// the Zoom settings above for where this was discovered) converted to
// bars/pixel via getBeatsPerBar(), times
// ADAPTIVE_WHEEL_SCRUB_PIXELS_PER_TICK, rounded to the nearest whole bar
// (never less than 1 - translated to bars up front, not scaled in raw
// pixels/beats, specifically so the result is always a whole-bar count,
// never a fractional one that could land mid-bar). Off by default - an
// opt-in alternative mode, not a replacement, until confirmed on
// hardware. Defaults; overridden live from the Controller Preferences
// panel settings created in init() below.
var adaptiveWheelScrubEnabled = false;
var ADAPTIVE_WHEEL_SCRUB_PIXELS_PER_TICK = 50;

// Resolves how many whole bars the "Default" jog wheel branch in
// onMidi() should move for this tick, per adaptiveWheelScrubEnabled -
// always >= 1, so the wheel can never move less than a full bar.
function effectiveWheelScrubBars() {
   if (!adaptiveWheelScrubEnabled) {
      return DEFAULT_WHEEL_SCRUB_BARS;
   }
   var beatsPerPixel = arrangerHorizontalScrollbar.getContentPerPixel().get();
   var barsPerPixel = beatsPerPixel / getBeatsPerBar();
   return Math.max(1, Math.round(barsPerPixel * ADAPTIVE_WHEEL_SCRUB_PIXELS_PER_TICK));
}

// The Default jog wheel branch below used to fire one bar-jump per MIDI
// message using only the turn direction, ignoring how large that
// message's raw tick value (rawStep) actually was. The MCU jog wheel
// protocol batches multiple physical detents into a single message with
// a larger rawStep when spun quickly (same behavior already handled
// correctly elsewhere, e.g. loopScaleAccumulator/LOOP_SCALE_THRESHOLD
// below) - discarding that magnitude made a fast flick move exactly as
// far as a gentle nudge, which read as both "jumpy" and "too many ticks
// needed per bar". Fixed the same way: accumulate signed rawStep across
// messages and only fire once enough ticks have built up, carrying any
// remainder over to the next message instead of resetting it.
var wheelScrubAccumulator = 0;
var WHEEL_SCRUB_TICKS_PER_BAR = 8;

// OPTION + Jog Wheel halves/doubles the loop length (see onMidi). Raw wheel
// CC messages arrive far more often than one per physical detent, and
// halving/doubling is exponential, so ticks are accumulated here and only
// trigger a halve/double once LOOP_SCALE_THRESHOLD worth has built up -
// otherwise a single flick of the wheel could shrink or grow the loop by
// many powers of two almost instantly.
// Default; overridden live from the Controller Preferences panel setting
// created in init() below (see loopScaleThresholdSetting).
var loopScaleAccumulator = 0;
var LOOP_SCALE_THRESHOLD = 16;

// SHIFT+CTRL and ALT+CTRL + Jog Wheel each independently run one of the
// same 5 configurable actions (Controller Preferences -> "Function Keys"
// category - two separate dropdowns, one per combo, both offering this
// same list) - so which combo does which is fully invertible by just
// picking differently in each dropdown, no separate "swap" mechanism
// needed:
//   - "Scale Clip Size" - right doubles the selected clip's content
//     (real "Scale 200%" action, id scale_time_double), left halves it
//     ("Scale 50%"/scale_time_half) - exponential per repeat.
//   - "Duplicate/Delete Clip" - right = application.duplicate(), left =
//     application.remove() - unless wheelComboDeleteEnabled is off (see
//     below), in which case left is a no-op.
//   - "Duplicate Clip" - right = application.duplicate(), same as above;
//     left is ALWAYS a no-op, unconditionally, regardless of
//     wheelComboDeleteEnabled - a self-contained safe choice for anyone
//     who wants duplicate-only without also having to remember to turn
//     the separate delete kill switch off.
//   - "Duplicate/Delete Track" - right = cursorTrack.duplicateObject(),
//     left = cursorTrack.deleteObject() (Track implements
//     DuplicableObject/DeleteableObject directly - more reliable/
//     targeted than application.duplicate()/remove(), which operate on
//     whatever's ambiently selected in Bitwig rather than specifically
//     the current track) - unless wheelComboDeleteEnabled is off.
//   - "Duplicate Track" - right = cursorTrack.duplicateObject(), same as
//     above; left is always a no-op, same reasoning as "Duplicate Clip".
// The two "Duplicate/Delete" actions pair duplicate/delete as opposites,
// same pattern as grow/shrink scaling. Turning left actually deleting
// something outright (rather than a harmless no-op) was flagged as risky
// enough to want a kill switch - see wheelComboDeleteEnabled below,
// shared by both "Duplicate/Delete" combos' delete behavior (the plain
// "Duplicate Clip"/"Duplicate Track" options are unaffected by it either
// way, since they never delete regardless).
var WHEEL_COMBO_ACTIONS = ["Scale Clip Size",
   "Duplicate/Delete Clip", "Duplicate Clip",
   "Duplicate/Delete Track", "Duplicate Track"];
// Default changed to the safe duplicate-only option per direct request,
// rather than relying on also remembering to turn wheelComboDeleteEnabled
// off.
var shiftCtrlWheelAction = "Duplicate Clip";
var altCtrlWheelAction = "Duplicate/Delete Track";
var wheelComboDeleteEnabled = true;

// Separate accumulators AND separate, independently configurable
// thresholds per combo (Controller Preferences -> "Wheel Options"
// category) - so partial progress on one combo can't spill over and
// prematurely trigger the other if the user switches which modifiers are held
// mid-turn, and each combo's sensitivity can be tuned independently
// (e.g. duplicate/delete might want a higher threshold than scaling, to
// make an accidental delete less likely).
var shiftCtrlWheelAccumulator = 0;
var SHIFT_CTRL_WHEEL_THRESHOLD = 16;
var altCtrlWheelAccumulator = 0;
var ALT_CTRL_WHEEL_THRESHOLD = 16;

// Shared by the SHIFT+CTRL and ALT+CTRL + Jog Wheel branches in onMidi()
// once their own accumulator crosses LOOP_SCALE_THRESHOLD - resolves
// whichever action is currently configured for that combo (see
// WHEEL_COMBO_ACTIONS above) against the turn direction.
function performWheelComboAction(actionName, backwards) {
   switch (actionName) {
      case "Duplicate/Delete Clip":
         if (backwards) {
            if (wheelComboDeleteEnabled) {
               application.remove();
            }
         } else {
            application.duplicate();
         }
         break;
      case "Duplicate Clip":
         // Turning left is always a no-op here, unconditionally - never
         // gated by wheelComboDeleteEnabled, since the whole point of
         // this option is duplicate-only without depending on that
         // separate setting also being off.
         if (!backwards) {
            application.duplicate();
         }
         break;
      case "Duplicate/Delete Track":
         if (backwards) {
            if (wheelComboDeleteEnabled) {
               cursorTrack.deleteObject();
            }
         } else {
            cursorTrack.duplicateObject();
         }
         break;
      case "Duplicate Track":
         if (!backwards) {
            cursorTrack.duplicateObject();
         }
         break;
      default: // "Scale Clip Size"
         safeInvokeAction(backwards ? "scale_time_half" : "scale_time_double", null);
         break;
   }
}

// RETURNS (note 51): swap the 8 channel strips between the main track bank
// and the effect ("return") track bank.
var isViewingReturns = false;

// PAN (note 42): TOGGLE - while active, faders/encoders control the
// Gain/Pan of a TOOL_DEVICE_NAME utility device found on each track,
// instead of the track's own volume/pan. Assumes the device's first
// remote-control parameter is Gain and the second is Pan - verify against
// the LCD parameter names once tested, since Bitwig doesn't expose a
// documented fixed order for this.
var isToolVolumeMode = false;

// Safely call a zero-argument method on an object (e.g. application.duplicate()).
// Prevents an unknown/incorrect API method name from crashing the whole script.
function safeCall(obj, methodName, popupText) {
   try {
      if (typeof obj[methodName] !== "function") {
         println("Method not available: " + methodName);
         host.showPopupNotification((popupText || methodName) + " (unavailable)");
         return false;
      }
      obj[methodName]();
      if (popupText) {
         host.showPopupNotification(popupText);
      }
      return true;
   } catch (e) {
      println("Error calling \"" + methodName + "\": " + e);
      host.showPopupNotification((popupText || methodName) + " (error)");
      return false;
   }
}

// Safely invoke a Bitwig action by id (application.getAction(id).invoke()),
// for functionality (like switching the arranger tool) that has no direct
// method on Application - only reachable through the action registry.
// Never crashes on a wrong/unavailable id, just reports it.
function safeInvokeAction(actionId, popupText) {
   try {
      var action = application.getAction(actionId);
      if (!action) {
         println("Action not found: " + actionId);
         host.showPopupNotification((popupText || actionId) + " (unavailable)");
         return false;
      }
      action.invoke();
      if (popupText) {
         host.showPopupNotification(popupText);
      }
      return true;
   } catch (e) {
      println("Error invoking action \"" + actionId + "\": " + e);
      host.showPopupNotification((popupText || actionId) + " (error)");
      return false;
   }
}

// Host Objects
var trackBank = null;
var effectTrackBank = null; // "Returns" bank, shown when isViewingReturns is true
var sceneBank = null; // MODE_SCENE (BTA): fixed 8-scene window, see sceneCursorIndex below

// Deactivated Tracks in Bank ("Hide" mode) - requested directly: Bitwig
// itself doesn't show deactivated tracks that are also hidden, used for
// backup/experimental tracks the user keeps around but doesn't want
// cluttering the 8-channel bank. There's no way to read a track's
// hidden-in-Arranger/Mixer state via the Controller API at all (confirmed
// - no isVisible()/isHidden() exists anywhere in it), but a track's
// activated state IS readable (Channel.isActivated()), so that's the
// proxy this filters on instead.
//
// A plain TrackBank always maps physical slot i to a fixed, contiguous
// position in the raw track list - there's no way to make slot 3 skip
// ahead to the next activated track while slots 1-2 stay put. The only
// way to get that per-slot independence is 8 separate CursorTrack
// objects (mainTrackCursors below), each manually pointed at an
// arbitrary real track via selectChannel() - confirmed DrivenByMoss
// itself never attempts this (isActivated() is only ever used there to
// dim a channel strip in place, never to filter a bank), so there's no
// existing precedent to lean on; this is a from-scratch design.
//
// mainTrackScanBank is a large, permanently-unscrolled (always at
// position 0) bank purely for scanning isActivated()/exists() across far
// more tracks than the 8 physical slots, so activated tracks beyond the
// current 8-window are known about before they're scrolled into view.
// mainTrackCursors are the 8 real per-slot cursors every other part of
// the script actually reads from (via activeTrackAt() below) - kept
// pointed at either the plain trackBank window (Show All/dim mode) or
// the filtered activeTrackRawIndices list (Hide mode) by
// refreshMainCursors(). Main tracks only - Returns/effect tracks keep
// using effectTrackBank directly, unchanged; deactivated-track filtering
// wasn't requested for Returns and effectTrackBank's fixed-window
// behavior is far lower-risk to leave alone.
var MAIN_TRACK_SCAN_DEPTH = 128; // matches CUE_MARKER_SCAN_DEPTH/EQ_DEVICE_SCAN_DEPTH convention
var mainTrackScanBank = null;
var mainTrackCursors = [];
var activeTrackRawIndices = []; // mainTrackScanBank slot indices of existing+activated tracks, in list order
var mainBankScrollOffset = 0; // logical scroll position into activeTrackRawIndices - Hide mode only
var mainCursorHasTrack = [true, true, true, true, true, true, true, true]; // Hide mode: does slot i have a track?
var hideDeactivatedTracksEnabled = false; // live from the "Deactivated Tracks in Bank" Controller Preferences setting
var mainMappingDirty = true; // set by any scan-bank exists()/isActivated()/name() change; consumed by mainMappingTick()

// 0-based slot indices selectFirstTrackOfBank()/selectLastTrackOfBank()
// (see below) select after a bank scroll - live from the "Bank Scroll
// Left/Right: Select Track #" Controller Preferences settings (1-8 in
// the UI, converted to 0-7 here). Defaults 0/7 match the original
// hardcoded first-slot/last-slot behavior.
var bankScrollLeftSelectIndex = 0;
var bankScrollRightSelectIndex = 7;
var masterTrack = null;
var cursorTrack = null;
var cursorDevice = null;
var cursorDeviceBank = null; // 8-slot device chain bank for the F1-F8 (notes 54-61) direct device-select feature
var eqDeviceBank = null; // deeper device chain bank for the EQ Mode (SHIFT+PLUG-INS) name search feature
var remoteControls = null;
var transport = null;
var application = null;
var arranger = null;
var arrangerHorizontalScrollbar = null; // for ZOOM+LEFT/RIGHT continuous timeline zoom - see case 98/99
var cueMarkerBank = null; // for SHIFT+HOME's "Bar N" auto-named cue marker feature - see case 89
var midiOut = null;
var midiIn = null;

// Native Bitwig hardware-binding faders (see rebindFaders() below). Motor
// feedback is handled entirely by Bitwig itself once a slider is bound to a
// Parameter via setBinding() - no manual sendMidi() needed, and (unlike the
// old manual pitch-bend approach) this correctly reflects mouse-driven and
// automation-driven value changes on the physical fader, not just changes
// that originated from the hardware itself.
var hwSurface = null;
var hwFaders = []; // 8 track faders, index 0-7
var hwMasterFader = null;

// Last pitch-bend value (0-16383) sent to each fader's motor, indexed 0-7
// for tracks and 8 for master - see updateFaderOutputs() below. Reset to
// -1 (never sent) whenever rebindFaders() points a fader at a new
// parameter, so the new target's value gets pushed out immediately on the
// next flush() rather than waiting for it to actually change.
var lastSentFaderValue = [-1, -1, -1, -1, -1, -1, -1, -1, -1];

// V-Pot ring LED (the small position-dot indicator ring around each
// encoder, separate from the 2-row LCD text) - real MCU protocol per
// Mossgraber's DrivenByMoss MCU driver: CC (0x30 + channel) with a value
// packing the display mode (bits 4-5) and a 0-11 rescaled position (bits
// 0-3). Shows whatever that encoder itself currently controls (see
// getEncoderTarget()) - pan in Mixer mode, sends in Sends mode, always
// the macro in Device mode regardless of FLIP - consistent with the
// physical V-Pot ring always reflecting its own encoder, never the
// fader. -1 = never sent, same reset pattern as lastSentFaderValue.
var lastSentVPotRing = [-1, -1, -1, -1, -1, -1, -1, -1];
var VPOT_LED_MODE_SINGLE_DOT = 0;

// Segment display (transport position, CC 0x40-0x49) - see
// updateSegmentDisplay() below. positionFormatter is created once in
// init() (needs host.createBeatTimeFormatter()); segmentDisplayBuffer
// caches the last ASCII+dot byte sent per digit cell (-1 = never sent,
// same de-dup pattern as lastSentFaderValue/lastSentVPotRing above) so
// flush() only re-sends digits that actually changed.
var positionFormatter = null;
var lastSegmentDisplayText = null;
var segmentDisplayBuffer = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

// Per-channel LCD/strip color, matching each track's own Bitwig color -
// EXPERIMENTAL, not confirmed working on this hardware yet. Sent as one
// SysEx covering all 8 channels (real MCU protocol per Mossgraber's
// DrivenByMoss driver, the "ICON"-vendor variant - there are at least two
// other known vendor-specific variants for this same feature, and it's
// not documented in the Midiplus manual at all, so this is a best-guess
// attempt pending hardware confirmation - see updateChannelColorOutput()
// below). Cached as 24 flat ints (8 channels x R,G,B, 0-127 each) so it's
// only re-sent when something actually changed, polled every flush()
// like the fader/V-Pot ring outputs. null = never sent.
var lastSentChannelColors = null;

// SELECT button double-press detection (fold/unfold a group track) - one
// timestamp per physical channel-strip slot, shared across whichever bank
// is currently active.
var lastSelectPressTime = [0, 0, 0, 0, 0, 0, 0, 0];
var DOUBLE_PRESS_MS = 400;

// Cached per-bank LED state (main vs returns), since both banks' observers
// run all the time but only the active bank's state should light the 32
// shared Rec/Solo/Mute/Select LEDs.
var mainLedState = { arm: [false, false, false, false, false, false, false, false],
                      solo: [false, false, false, false, false, false, false, false],
                      mute: [false, false, false, false, false, false, false, false],
                      select: [false, false, false, false, false, false, false, false] };
var returnsLedState = { arm: [false, false, false, false, false, false, false, false],
                         solo: [false, false, false, false, false, false, false, false],
                         mute: [false, false, false, false, false, false, false, false],
                         select: [false, false, false, false, false, false, false, false] };

// "Blink Armed Track's SELECT LED" (Controller Preferences -> "Mixer"
// category, default ON) - see selectLedVelocityFor()/armedLedBlinkTick()
// below. Plain bright/off flash. A 4-step bright/dim/off/dim "breathing"
// version was tried first, using velocity 1 for "dim" - real and
// documented on this hardware for a DIFFERENT button function (the
// UP/UP+ manual's Pro Tools AUTO/INSERT section: "these buttons will
// illuminate dimmed Blue"/"dimmed Orange") - but confirmed on hardware
// NOT to produce any visible dim step for the SELECT LEDs specifically;
// no dim state was seen cycling through at all. Likely explanation: this
// row may have its own local record-arm LED behavior in firmware
// (matching the light-red/dark-red SELECT-row recoloring already
// observed when physically pressing RECORD) that overrides or ignores a
// plain Note-On velocity of 1 rather than treating it as a genuine dim
// state, unlike the AUTO/AUTO INSERT buttons' LEDs. Reverted to the
// simpler, already-confirmed-working 2-state flash rather than keep
// guessing at velocity values with no hardware feedback loop faster than
// a full round-trip. armedLedBlinkPhase (0-1, indexing
// ARMED_LED_BLINK_VELOCITIES) is the single shared step every armed
// channel's blink reads from, advanced once per
// ARMED_LED_BLINK_INTERVAL_MS by armedLedBlinkTick() so they all blink in
// sync rather than drifting independently - this is the duration of each
// of the 2 steps, so the full on/off cycle takes 2x this value (2000ms at
// the default 1000). Defaults; overridden live from the Controller
// Preferences panel settings created in init() below.
var armedLedBlinkEnabled = true;
var armedLedBlinkPhase = 0;
var ARMED_LED_BLINK_INTERVAL_MS = 1000;
var ARMED_LED_BLINK_VELOCITIES = [127, 0];

// Per-track TOOL_DEVICE_NAME device tracking (see isToolVolumeMode above).
// For each bank slot, mainToolSlot[i]/returnsToolSlot[i] holds which
// position (0 to TOOL_DEVICE_SCAN_DEPTH-1) in that track's device chain is
// currently named TOOL_DEVICE_NAME, or -1 if none is.
// mainToolRemote[i]/returnsToolRemote[i] holds a 2-parameter (Gain, Pan)
// remote-controls page for every scanned position, indexed the same way,
// so the right one can be picked once the matching slot is known.
var mainToolSlot = [-1, -1, -1, -1, -1, -1, -1, -1];
var returnsToolSlot = [-1, -1, -1, -1, -1, -1, -1, -1];
var mainToolRemote = [];
var returnsToolRemote = [];

// Same tracking, but for the single arranger-selected cursorTrack rather
// than a bank slot - used by PAN (case 42) to decide whether it needs to
// open the device browser for the currently-selected track before Tool
// Gain/Pan mode will have anything to control there.
var cursorToolSlot = -1;
var cursorToolRemote = [];

// Display State Caches (8 channels x 7 chars)
var topRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];
var bottomRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];

// Display Refresh Throttle Flag
var displayNeedsUpdate = true;

// Replaces every trackBank.getItemAt(i)/activeTrackBank().getItemAt(i)
// call site - see the Deactivated Tracks in Bank comment above
// mainTrackScanBank for why. Returns unchanged (effectTrackBank
// directly); Main always goes through mainTrackCursors, whichever real
// track each one currently points to (kept in sync by
// refreshMainCursors() below) regardless of Show All/Hide mode.
function activeTrackAt(index) {
   return isViewingReturns ? effectTrackBank.getItemAt(index) : mainTrackCursors[index];
}

// True only for a Main-bank, Hide-mode slot with no activated track left
// to show (mainCursorHasTrack[index] false) - its cursor is stale,
// pointing at whatever real (deactivated, off-screen) track it last
// pointed to, so button presses need to no-op there rather than silently
// acting on a track the user can't see and didn't intend to touch.
// Always false for Returns and for Main in Show All mode.
function isMainSlotEmpty(index) {
   return !isViewingReturns && hideDeactivatedTracksEnabled && !mainCursorHasTrack[index];
}

function activeBankItemCount() {
   if (isViewingReturns) {
      return effectTrackBank.itemCount().get();
   }
   return hideDeactivatedTracksEnabled ? activeTrackRawIndices.length : trackBank.itemCount().get();
}

// Requested directly: Bitwig's own Arranger/Mixer view didn't follow
// when scrolling the bank here, so the hardware and Bitwig's own screen
// could show completely different tracks. Selecting a track in the new
// window mirrors what the SELECT button (notes 24-31) already does -
// selectInMixer() plus the real cursorTrack.selectChannel() (cursorTrack
// was created with shouldFollowSelection=true, so this genuinely changes
// Bitwig's own selection, not just a local flag) - Bitwig scrolls its own
// view to keep a newly selected track visible, the same as clicking it
// would.
//
// Which slot to select depends on scroll direction and is configurable -
// bankScrollLeftSelectIndex/bankScrollRightSelectIndex below, live from
// the "Bank Scroll Left/Right: Select Track #" Controller Preferences
// settings (default 1/8, i.e. slots 0/7 - the original hardcoded
// first/last-slot behavior). Requested directly: selecting a slot nearer
// the window's center (e.g. track 3 on a left scroll, track 6 on a right
// one) rather than always the extreme edge might make Bitwig's own view
// feel less jarring/more centered - worth experimenting with on
// hardware, hence configurable rather than a fixed redesign.
function selectBankSlot(index) {
   if (isMainSlotEmpty(index)) {
      return;
   }
   var track = activeTrackAt(index);
   track.selectInMixer();
   track.selectInEditor();
   cursorTrack.selectChannel(track);
}

// Hide mode can leave fewer than 8 activated tracks in the window
// (trailing slots empty) - scans backward from the configured index
// toward 0 so a scroll still selects the nearest actual populated track
// instead of silently selecting nothing if that exact slot happens to be
// empty (empty slots only ever trail towards slot 7 in Hide mode, never
// lead, so scanning backward/toward 0 is always the correct direction to
// search in either case). Show All mode and Returns never hit the
// empty-slot case at all (isMainSlotEmpty() is always false there), so
// this is effectively just "select the configured slot" for those.
function selectBankSlotNear(index) {
   for (var i = index; i >= 0; i--) {
      if (!isMainSlotEmpty(i)) {
         selectBankSlot(i);
         return;
      }
   }
}

function selectFirstTrackOfBank() {
   selectBankSlotNear(bankScrollLeftSelectIndex);
}

function selectLastTrackOfBank() {
   selectBankSlotNear(bankScrollRightSelectIndex);
}

// The 6 scroll operations activeTrackBank() used to expose directly
// (scrollPosition/scrollPageForwards/scrollPageBackwards/scrollForwards/
// scrollBackwards/itemCount) don't make sense as a single passthrough
// anymore - Hide mode's "bank" is activeTrackRawIndices, a plain array
// with its own logical mainBankScrollOffset, not a real TrackBank object
// with its own scroll methods. Each helper below picks the right
// behavior for Returns / Main+Show All / Main+Hide, then re-syncs the
// cursors so activeTrackAt() immediately reflects the new window, and
// selects the appropriate edge track of that window (see
// selectFirstTrackOfBank()/selectLastTrackOfBank() above) so Bitwig's
// own view follows along.
function scrollActiveBankToStart() {
   if (isViewingReturns) {
      effectTrackBank.scrollPosition().set(0);
   } else if (hideDeactivatedTracksEnabled) {
      mainBankScrollOffset = 0;
      refreshMainCursors();
   } else {
      trackBank.scrollPosition().set(0);
      refreshMainCursors();
   }
   selectFirstTrackOfBank();
}

function scrollActiveBankToEnd() {
   var maxOffset = Math.max(0, activeBankItemCount() - 8);
   if (isViewingReturns) {
      effectTrackBank.scrollPosition().set(maxOffset);
   } else if (hideDeactivatedTracksEnabled) {
      mainBankScrollOffset = maxOffset;
      refreshMainCursors();
   } else {
      trackBank.scrollPosition().set(maxOffset);
      refreshMainCursors();
   }
   selectLastTrackOfBank();
}

function scrollActiveBankPageBackward() {
   if (isViewingReturns) {
      effectTrackBank.scrollPageBackwards();
   } else if (hideDeactivatedTracksEnabled) {
      mainBankScrollOffset = Math.max(0, mainBankScrollOffset - 8);
      refreshMainCursors();
   } else {
      trackBank.scrollPageBackwards();
      refreshMainCursors();
   }
   selectFirstTrackOfBank();
}

function scrollActiveBankPageForward() {
   if (isViewingReturns) {
      effectTrackBank.scrollPageForwards();
   } else if (hideDeactivatedTracksEnabled) {
      var maxOffsetPage = Math.max(0, activeTrackRawIndices.length - 8);
      mainBankScrollOffset = Math.min(maxOffsetPage, mainBankScrollOffset + 8);
      refreshMainCursors();
   } else {
      trackBank.scrollPageForwards();
      refreshMainCursors();
   }
   selectLastTrackOfBank();
}

function scrollActiveBankStepBackward() {
   if (isViewingReturns) {
      effectTrackBank.scrollBackwards();
   } else if (hideDeactivatedTracksEnabled) {
      mainBankScrollOffset = Math.max(0, mainBankScrollOffset - 1);
      refreshMainCursors();
   } else {
      trackBank.scrollBackwards();
      refreshMainCursors();
   }
   selectFirstTrackOfBank();
}

function scrollActiveBankStepForward() {
   if (isViewingReturns) {
      effectTrackBank.scrollForwards();
   } else if (hideDeactivatedTracksEnabled) {
      var maxOffsetStep = Math.max(0, activeTrackRawIndices.length - 8);
      mainBankScrollOffset = Math.min(maxOffsetStep, mainBankScrollOffset + 1);
      refreshMainCursors();
   } else {
      trackBank.scrollForwards();
      refreshMainCursors();
   }
   selectLastTrackOfBank();
}

// Keeps mainTrackCursors[0-7] pointed at the correct real tracks for
// whichever Main-bank mode is active - the native trackBank window (Show
// All) or the filtered activeTrackRawIndices list (Hide, see
// recomputeActiveTrackIndices() below) - and, Hide mode only, blanks any
// trailing slot that has no activated track left to show (Show All mode
// never needs this: a slot beyond the real track count already reads
// back as Bitwig's own empty-track defaults, same as before this
// feature existed). Called on every Main-bank scroll operation above,
// every mapping recompute, and on every Show All/Hide toggle.
function refreshMainCursors() {
   for (var i = 0; i < 8; i++) {
      if (hideDeactivatedTracksEnabled) {
         var rawIdx = activeTrackRawIndices[mainBankScrollOffset + i];
         if (rawIdx !== undefined) {
            mainTrackCursors[i].selectChannel(mainTrackScanBank.getItemAt(rawIdx));
            mainCursorHasTrack[i] = true;
         } else {
            mainCursorHasTrack[i] = false;
            topRowText[i] = "       ";
            bottomRowText[i] = "       ";
            mainLedState.arm[i] = false;
            mainLedState.solo[i] = false;
            mainLedState.mute[i] = false;
            mainLedState.select[i] = false;
         }
      } else {
         mainTrackCursors[i].selectChannel(trackBank.getItemAt(i));
         mainCursorHasTrack[i] = true;
      }
   }
   if (!isViewingReturns) {
      displayNeedsUpdate = true;
      refreshChannelStripLEDs();
   }
}

// Rebuilds activeTrackRawIndices from scratch - called by mainMappingTick()
// below whenever mainMappingDirty was set by an exists()/isActivated()/
// name() change anywhere in the scanned MAIN_TRACK_SCAN_DEPTH window.
// Runs regardless of hideDeactivatedTracksEnabled, so the list is already
// correct and ready the moment the user switches into Hide mode, rather
// than needing a first recompute right after the toggle.
function recomputeActiveTrackIndices() {
   activeTrackRawIndices = [];
   for (var i = 0; i < MAIN_TRACK_SCAN_DEPTH; i++) {
      var scanTrack = mainTrackScanBank.getItemAt(i);
      if (scanTrack.exists().get() && scanTrack.isActivated().get()) {
         activeTrackRawIndices.push(i);
      }
   }
   var maxOffset = Math.max(0, activeTrackRawIndices.length - 8);
   if (mainBankScrollOffset > maxOffset) {
      mainBankScrollOffset = maxOffset;
   }
   if (hideDeactivatedTracksEnabled) {
      refreshMainCursors();
   }
}

// Self-rescheduling loop (same pattern as displayFlushTask()/
// armedLedBlinkTick() below) - throttles recomputeActiveTrackIndices() to
// once per 100ms even if several scan-bank slots change in the same
// instant (e.g. a project loading), rather than recomputing on every
// single one of those changes.
function mainMappingTick() {
   if (mainMappingDirty) {
      mainMappingDirty = false;
      recomputeActiveTrackIndices();
   }
   host.scheduleTask(mainMappingTick, 100);
}

// Length of one bar in beats (quarter notes) under the project's current
// time signature - e.g. 4/4 -> 4, 6/8 -> 3. Transport.incPosition() and
// arrangerLoopStart()/Duration() are all denominated in beats, not bars, so
// jog-wheel bar-jump/loop-shift math needs this conversion.
function getBeatsPerBar() {
   return transport.timeSignature().numerator().get() * (4.0 / transport.timeSignature().denominator().get());
}

// transport.getPosition() is the live playback position - while playing,
// it's continuously re-driven by the audio engine every processing
// cycle, so calling .set() on it races against that and gets stomped
// almost immediately, meaning a seek silently fails to visibly move
// anything (reported: jog-wheel scrub did nothing while playing, even
// though it worked fine stopped). transport.playStartPosition() is a
// separate, not-continuously-driven value (Bitwig's own "play-start"
// marker) that Bitwig itself keeps in sync with the current position
// while stopped, and transport.jumpToPlayStartPosition() forces the
// actual jump while playing - same workaround used by the well-tested
// DrivenByMoss controller framework for this exact issue. Used by every
// position-jump below (jog wheel scrub, HOME/END, Mixer Mode PAGE)
// instead of transport.getPosition().set() directly, so seeking works
// identically whether the transport is running or stopped.
function setTransportPosition(beats) {
   transport.playStartPosition().set(beats);
   if (transport.isPlaying().get()) {
      transport.jumpToPlayStartPosition();
   }
}

function activeLedState() {
   return isViewingReturns ? returnsLedState : mainLedState;
}

// Returns the Gain (paramIndex 0) or Pan (paramIndex 1) parameter of the
// TOOL_DEVICE_NAME device on the given track slot of the active bank, or
// null if that track has no such device within the first
// TOOL_DEVICE_SCAN_DEPTH positions of its chain.
function getToolParam(trackIndex, paramIndex) {
   // Hide mode empty slot - see isMainSlotEmpty() above. mainToolSlot[i]
   // would otherwise still reflect the stale cursor's real (off-screen,
   // deactivated) track.
   if (isMainSlotEmpty(trackIndex)) {
      return null;
   }
   var slot = isViewingReturns ? returnsToolSlot[trackIndex] : mainToolSlot[trackIndex];
   if (slot < 0) {
      return null;
   }
   var remotesForTrack = isViewingReturns ? returnsToolRemote[trackIndex] : mainToolRemote[trackIndex];
   return remotesForTrack[slot].getParameter(paramIndex);
}

function init() {
   println("Initializing Midiplus UP Bitwig Controller Script...");

   // MIDI Output Port (required for sendMidi/sendSysexBytes below)
   midiOut = host.getMidiOutPort(0);
   midiIn = host.getMidiInPort(0);

   // Enable SysEx handling
   midiIn.setSysexCallback(onSysex);

   // Set MIDI callback
   midiIn.setMidiCallback(onMidi);

   // Initialize Main Track Bank (8 tracks, 16 sends, 8 scenes)
   trackBank = host.createMainTrackBank(8, MAX_SENDS, 8);

   // Initialize Effect ("Returns") Track Bank - shown via the RETURNS button
   effectTrackBank = host.createEffectTrackBank(8, MAX_SENDS, 8);

   // Read on-demand (not observed) by the SHIFT+BANK/CHANNEL "jump to last"
   // handlers below, so they need markInterested() or .get() throws.
   trackBank.itemCount().markInterested();
   effectTrackBank.itemCount().markInterested();

   // Show All mode's mainTrackCursors only get re-pointed at
   // trackBank.getItemAt(i) at explicit trigger points (scroll, RETURNS
   // toggle, the Hide-mode Controller Preferences toggle, init) - unlike
   // the plain bank.getItemAt(i) pattern used everywhere before this
   // feature, a cursor doesn't automatically follow if what's virtually
   // "at" a bank slot changes for some other reason. Expanding/collapsing
   // a group track is exactly that: it reflows the whole flat list (child
   // tracks appear/disappear inline) without the user ever triggering one
   // of those explicit refresh points - reported as the group's children
   // not showing up on the hardware after unfolding it. name() changing
   // is used as the signal (same "detect a different track landed at this
   // slot" trick mainTrackScanBank's observers use above) since a
   // reflow always means a different real track (or none) is now at that
   // slot, so its name almost certainly differs even though nothing about
   // trackBank's own scroll position changed.
   for (var nativeSlotIdx = 0; nativeSlotIdx < 8; nativeSlotIdx++) {
      trackBank.getItemAt(nativeSlotIdx).name().addValueObserver(function () {
         if (!hideDeactivatedTracksEnabled) {
            refreshMainCursors();
         }
      });
   }

   // Deactivated Tracks in Bank ("Hide" mode) - see mainTrackScanBank/
   // mainTrackCursors above. Scan bank: 0 sends/0 scenes, only ever used
   // for exists()/isActivated()/name(), never displayed or bound to
   // hardware directly. Never scrolled - stays pinned at position 0 so
   // raw slot i always means "track at position i in the document" for
   // as long as the script runs.
   mainTrackScanBank = host.createMainTrackBank(MAIN_TRACK_SCAN_DEPTH, 0, 0);
   for (var scanIdx = 0; scanIdx < MAIN_TRACK_SCAN_DEPTH; scanIdx++) {
      (function (si) {
         var scanTrack = mainTrackScanBank.getItemAt(si);
         scanTrack.exists().markInterested();
         scanTrack.isActivated().markInterested();
         scanTrack.exists().addValueObserver(function () { mainMappingDirty = true; });
         scanTrack.isActivated().addValueObserver(function () { mainMappingDirty = true; });
         // Catches a track at this raw slot being replaced by a different
         // one (insert/delete/reorder elsewhere in the list) without its
         // activated flag actually changing value - exists()/isActivated()
         // alone wouldn't fire a recompute in that case.
         scanTrack.name().markInterested();
         scanTrack.name().addValueObserver(function () { mainMappingDirty = true; });
      })(scanIdx);
   }

   // The 8 real per-slot cursors - every other part of the script reads
   // Main-track data through these (via activeTrackAt() below), never
   // through trackBank.getItemAt() directly. 0 scenes: trackBank's own
   // scenes parameter is unused elsewhere in this script (the clip
   // launcher features all go through the separate sceneBank/actions
   // instead), so there's nothing to replicate here.
   for (var cursorIdx = 0; cursorIdx < 8; cursorIdx++) {
      mainTrackCursors.push(host.createCursorTrack(
         "MIDIPLUS_MAIN_TRACK_" + cursorIdx, "Main Track " + (cursorIdx + 1), MAX_SENDS, 0, false));
   }

   // Scene Bank (8 scenes) - MODE_SCENE, entered via BTA. Fixed window, no
   // paging built for now (see sceneCursorIndex above).
   sceneBank = host.createSceneBank(8);
   for (var sceneIdx = 0; sceneIdx < 8; sceneIdx++) {
      sceneBank.getScene(sceneIdx).name().markInterested();
   }

   // Initialize Master Track
   masterTrack = host.createMasterTrack(0);

   // Native hardware-bound faders (see hwFaders/hwMasterFader above and
   // rebindFaders() below). Each slider's input side is wired once here to
   // its fixed pitch-bend channel (0-7 for tracks, 8 for master - confirmed
   // via console log, unchanged between this hardware's Live and MCU
   // modes); the *target parameter* side is rebound dynamically by
   // rebindFaders() whenever the active mode/flip/tool state changes.
   hwSurface = host.createHardwareSurface();
   for (var faderIdx = 0; faderIdx < 8; faderIdx++) {
      (function (channel) {
         var slider = hwSurface.createHardwareSlider("fader" + channel);
         slider.setAdjustValueMatcher(midiIn.createAbsolutePitchBendValueMatcher(channel));
         // Motorized fader: snap immediately to the bound parameter's value
         // instead of requiring a pickup/catch-up gesture, since the motor
         // itself will move the fader to match.
         slider.disableTakeOver();
         hwFaders[channel] = slider;
      })(faderIdx);
   }
   hwMasterFader = hwSurface.createHardwareSlider("faderMaster");
   hwMasterFader.setAdjustValueMatcher(midiIn.createAbsolutePitchBendValueMatcher(8));
   hwMasterFader.disableTakeOver();
   hwMasterFader.setBinding(masterTrack.volume());

   // Initialize Cursor Track & Send Bank (16 Send slots for focused track)
   cursorTrack = host.createCursorTrack("MIDIPLUS_CURSOR_TRACK", "Cursor Track", 16, 0, true);
   cursorDevice = cursorTrack.createCursorDevice("MIDIPLUS_CURSOR_DEVICE", "Cursor Device", 0, CursorDeviceFollowMode.FIRST_INSTRUMENT_OR_DEVICE);

   // F1-F8 (notes 54-61, the F-key row's default/orange-lit state) select
   // device 1-8 directly via cursorDevice.selectDevice() - see case 54-61.
   cursorDeviceBank = cursorTrack.createDeviceBank(8);

   // EQ Mode (SHIFT+PLUG-INS - see findLastEqDeviceIndex()/case 44 above
   // and below) - a separate, deeper device bank over the same selected
   // track's chain, purely for the name-based EQ search; eqDeviceNames[i]
   // is kept live by one observer per slot (an empty string means no
   // device there - see scanTrackForToolDevice() below for the identical
   // "observer instead of markInterested(), () around loop var to
   // capture it per-iteration" pattern).
   eqDeviceBank = cursorTrack.createDeviceBank(EQ_DEVICE_SCAN_DEPTH);
   for (var eqScanIdx = 0; eqScanIdx < EQ_DEVICE_SCAN_DEPTH; eqScanIdx++) {
      (function (idx) {
         eqDeviceBank.getItemAt(idx).name().addValueObserver(function (name) {
            eqDeviceNames[idx] = name;
         });
      })(eqScanIdx);
   }

   // Toggled on-demand (not observed) by CTRL's long-press handling above,
   // so needs markInterested() or .toggle()/.get() throws.
   cursorDevice.isExpanded().markInterested();

   // Read on-demand (not observed) by case 54-61's F1-F8 direct
   // device-select handling below, to tell whether the pressed F-key's
   // device is already the current one (toggle its window) or a
   // different one (select it and open its window) - needs
   // markInterested() or .get() throws, same as isExpanded() above.
   // isWindowOpen() is also .set()/.toggle()'d elsewhere in this file
   // without ever having been read back before now.
   cursorDevice.position().markInterested();
   cursorDevice.isWindowOpen().markInterested();

   // "About" category - no actual effect on the script; the Settings API
   // has no plain read-only label type, so a getStringSetting() showing
   // fixed info text as its default value is the standard way controller
   // scripts surface this kind of thing in the Preferences panel.
   var requiresInfoSetting = host.getPreferences().getStringSetting(
      "Requires", "About", 60, "Bitwig 6.x (Controller API 25)");
   requiresInfoSetting.markInterested();

   var creditsInfoSetting = host.getPreferences().getStringSetting(
      "Credits", "About", 100,
      "Based on Mossgraber's DrivenByMoss SSL UF8 script, ideas from Sternenlicht, built with Claude Code");
   creditsInfoSetting.markInterested();

   // See ZOOM_ARROW_STEP above - how big a jump ZOOM+LEFT/RIGHT's
   // horizontal timeline zoom makes per press.
   var zoomArrowStepSetting = host.getPreferences().getNumberSetting(
      "ZOOM+Left/Right: Zoom Step (2^n per Press)", "Zoom", 0.25, 4, 0.25, "", 1);
   zoomArrowStepSetting.markInterested();
   zoomArrowStepSetting.addRawValueObserver(function(value) {
      ZOOM_ARROW_STEP = value;
   });

   // Plugin Mode settings (Controller Preferences panel in Bitwig Studio ->
   // this controller -> "Plugin Mode" category) - which modifier button
   // toggles the expanded device view and cycles the macro bank, whether
   // the expanded-view toggle is an instant tap or a long press, and (for
   // the long-press case) how long that press needs to be held. All four
   // observers fire immediately with the initial value and again any time
   // the user edits it live, so the corresponding globals (see
   // EXPANDED_VIEW_BUTTON etc. above) always reflect the current setting
   // without needing a restart. Default is now "None" (off) - see
   // EXPANDED_VIEW_BUTTON's comment above for why; still fully available
   // by picking any modifier here.
   var expandedViewButtonSetting = host.getPreferences().getEnumSetting(
      "Expanded Device View Button", "Plugin Mode", ["CTRL", "ALT", "OPTION", "SHIFT", "None"], "None");
   expandedViewButtonSetting.markInterested();
   expandedViewButtonSetting.addValueObserver(function (value) {
      EXPANDED_VIEW_BUTTON = MODIFIER_NAME_TO_NOTE[value];
   });

   var expandedViewTriggerSetting = host.getPreferences().getEnumSetting(
      "Expanded Device View Trigger", "Plugin Mode", ["Long Press", "Instant Tap"], "Long Press");
   expandedViewTriggerSetting.markInterested();
   expandedViewTriggerSetting.addValueObserver(function (value) {
      EXPANDED_VIEW_INSTANT = (value === "Instant Tap");
   });

   var ctrlHoldTimeSetting = host.getPreferences().getNumberSetting(
      "Long Press Duration (Expanded Device View)", "Plugin Mode", 200, 2000, 10, "ms", 500);
   ctrlHoldTimeSetting.markInterested();
   ctrlHoldTimeSetting.addRawValueObserver(function(value) {
      CTRL_LONG_PRESS_MS = value;
   });

   var expandedViewOpensWindowSetting = host.getPreferences().getBooleanSetting(
      "Expanded Device View Also Opens Plugin Window", "Plugin Mode", true);
   expandedViewOpensWindowSetting.markInterested();
   expandedViewOpensWindowSetting.addValueObserver(function (value) {
      EXPANDED_VIEW_OPENS_WINDOW = value;
   });

   var macroCycleButtonSetting = host.getPreferences().getEnumSetting(
      "Macro Bank Cycle Button", "Plugin Mode", ["ALT", "CTRL", "OPTION", "SHIFT", "None"], "ALT");
   macroCycleButtonSetting.markInterested();
   macroCycleButtonSetting.addValueObserver(function (value) {
      MACRO_CYCLE_BUTTON = MODIFIER_NAME_TO_NOTE[value];
   });

   var closeOtherWindowsSetting = host.getPreferences().getBooleanSetting(
      "Close Other Plugin Windows", "Plugin Mode", false);
   closeOtherWindowsSetting.markInterested();
   closeOtherWindowsSetting.addValueObserver(function (value) {
      CLOSE_OTHER_PLUGIN_WINDOWS = value;
   });

   // EQ Mode (SHIFT+PLUG-INS) - see EQ_DEVICE_NAME_KEYWORDS/
   // findLastEqDeviceIndex() above.
   var eqDeviceNameKeywordsSetting = host.getPreferences().getStringSetting(
      "EQ Device Name Keywords", "Plugin Mode", 100, "eq,pro-q");
   eqDeviceNameKeywordsSetting.markInterested();
   eqDeviceNameKeywordsSetting.addValueObserver(function (value) {
      EQ_DEVICE_NAME_KEYWORDS = value;
      rebuildEqNameRegexes();
   });

   // Function Keys settings (Controller Preferences panel -> "Function
   // Keys" category) - what each of the 8 green-state F1-F8 buttons (see
   // FKEY_FUNCTION_NAMES/invokeFKeyFunction above, and the "F1-F8 Green
   // State" block in onMidi)
   // does. All 8 dropdowns offer the same full option list - Bitwig has
   // no API to prune already-picked options from the others - so a
   // duplicate pick is only caught after the fact, via
   // warnIfDuplicateFKeyFunctions().
   for (var fkIdx = 0; fkIdx < 8; fkIdx++) {
      (function (fkIndex) {
         var fkSetting = host.getPreferences().getEnumSetting(
            "F" + (fkIndex + 1) + " Function (Green State)", "Function Keys",
            FKEY_FUNCTION_NAMES, fKeyFunctionAssignment[fkIndex]);
         fkSetting.markInterested();
         fkSetting.addValueObserver(function (value) {
            fKeyFunctionAssignment[fkIndex] = value;
            warnIfDuplicateFKeyFunctions();
         });
      })(fkIdx);
   }

   // What SHIFT+CTRL and ALT+CTRL + Jog Wheel each do - independent
   // dropdowns, same option list, see WHEEL_COMBO_ACTIONS/
   // shiftCtrlWheelAction/altCtrlWheelAction/performWheelComboAction
   // above and the wheel handler in onMidi(). Freely invertible: set
   // either dropdown to either action.
   var shiftCtrlWheelActionSetting = host.getPreferences().getEnumSetting(
      "SHIFT+CTRL Wheel Action", "Function Keys", WHEEL_COMBO_ACTIONS, shiftCtrlWheelAction);
   shiftCtrlWheelActionSetting.markInterested();
   shiftCtrlWheelActionSetting.addValueObserver(function (value) {
      shiftCtrlWheelAction = value;
   });

   var altCtrlWheelActionSetting = host.getPreferences().getEnumSetting(
      "ALT+CTRL Wheel Action", "Function Keys", WHEEL_COMBO_ACTIONS, altCtrlWheelAction);
   altCtrlWheelActionSetting.markInterested();
   altCtrlWheelActionSetting.addValueObserver(function (value) {
      altCtrlWheelAction = value;
   });

   // Only relevant when either dropdown above is a "Duplicate/Delete"
   // option (NOT the plain "Duplicate Clip"/"Duplicate Track" options,
   // which never delete regardless of this) - whether turning the wheel
   // left actually deletes something, or is a no-op (only turning
   // right/duplicate does anything). Default on (matches the original
   // behavior); off is the safer choice if a slightly-wrong turn
   // deleting something outright is too risky - though picking one of
   // the plain "Duplicate" options directly is the more self-contained
   // way to get that safety without relying on this separate toggle too.
   // Shared by both combos rather than two separate toggles.
   var wheelComboDeleteEnabledSetting = host.getPreferences().getBooleanSetting(
      "Wheel Combos: Allow Delete (Turn Left)", "Function Keys", true);
   wheelComboDeleteEnabledSetting.markInterested();
   wheelComboDeleteEnabledSetting.addValueObserver(function (value) {
      wheelComboDeleteEnabled = value;
   });

   // See DEFAULT_WHEEL_SCRUB_BARS above - how many whole bars the
   // playhead jumps per wheel message with no modifier held, when
   // Adaptive Wheel Scrub (below) is off. Originally beat-based
   // (reported as too slow at a fixed 1 beat/message), then reported as
   // inconsistent-feeling once widened to arbitrary beat counts - redone
   // as whole bars, always landing on a bar start, per direct request.
   var defaultWheelScrubBarsSetting = host.getPreferences().getNumberSetting(
      "Wheel (No Modifier): Playhead Jump per Tick (bars)", "Wheel Options", 1, 8, 1, "bars", 1);
   defaultWheelScrubBarsSetting.markInterested();
   defaultWheelScrubBarsSetting.addRawValueObserver(function(value) {
      DEFAULT_WHEEL_SCRUB_BARS = value;
   });

   // See wheelScrubAccumulator/WHEEL_SCRUB_TICKS_PER_BAR above - how many
   // raw wheel ticks (not messages) need to accumulate before the Default
   // branch actually fires a bar-jump. Turning the wheel fast batches more
   // ticks into fewer, larger messages, so a fast flick now fires several
   // jumps at once and a slow turn carries partial ticks over to the next
   // message, instead of every message moving the same fixed distance
   // regardless of how hard it was spun. Lower = more responsive/twitchy,
   // higher = slower/steadier. Default 8 (rather than the 16 used by the
   // other wheel-combo thresholds in this file) - reported as needing too
   // much physical turning per bar at 16, halved per direct request.
   var wheelScrubTicksPerBarSetting = host.getPreferences().getNumberSetting(
      "Wheel (No Modifier): Ticks per Bar", "Wheel Options", 1, 64, 1, "ticks", 8);
   wheelScrubTicksPerBarSetting.markInterested();
   wheelScrubTicksPerBarSetting.addRawValueObserver(function(value) {
      WHEEL_SCRUB_TICKS_PER_BAR = value;
   });

   // See adaptiveWheelScrubEnabled/effectiveWheelScrubBars() above -
   // requested directly, faster playhead movement per tick when zoomed
   // further out, slower when zoomed further in, instead of a fixed bar
   // count regardless of zoom - translated to a whole-bar count up
   // front (not scaled in raw pixels/beats), so it always lands on a bar
   // start, never mid-bar. Off by default (uses the fixed bar count
   // above instead) until confirmed on hardware.
   var adaptiveWheelScrubSetting = host.getPreferences().getBooleanSetting(
      "Adaptive Wheel Scrub (Scale with Zoom)", "Wheel Options", false);
   adaptiveWheelScrubSetting.markInterested();
   adaptiveWheelScrubSetting.addValueObserver(function(value) {
      adaptiveWheelScrubEnabled = value;
   });

   var adaptiveWheelScrubPixelsSetting = host.getPreferences().getNumberSetting(
      "Adaptive Wheel Scrub: Pixels per Tick", "Wheel Options", 10, 200, 5, "px", 50);
   adaptiveWheelScrubPixelsSetting.markInterested();
   adaptiveWheelScrubPixelsSetting.addRawValueObserver(function(value) {
      ADAPTIVE_WHEEL_SCRUB_PIXELS_PER_TICK = value;
   });

   // User-configurable wheel-tick threshold for OPTION + Jog Wheel's
   // loop-length halve/double (see loopScaleAccumulator above) - lower
   // values double/halve the loop faster per flick of the wheel.
   var loopScaleThresholdSetting = host.getPreferences().getNumberSetting(
      "OPTION+Wheel: Ticks to Halve/Double Loop Length", "Wheel Options", 2, 64, 1, "ticks", 16);
   loopScaleThresholdSetting.markInterested();
   loopScaleThresholdSetting.addRawValueObserver(function(value) {
      LOOP_SCALE_THRESHOLD = value;
   });

   // Same idea, independently for CTRL/SHIFT+CTRL/ALT+CTRL + Jog Wheel
   // (see CLIP_SELECT_STEP_MESSAGES/SHIFT_CTRL_WHEEL_THRESHOLD/
   // ALT_CTRL_WHEEL_THRESHOLD above) - each combo's sensitivity tunable
   // on its own rather than sharing one setting between all of them. Each
   // observer stores into its own "Individual" var and re-derives the
   // live thresholds via applyWheelTickSettings(), so these keep working
   // as the per-combo values whenever "Override Wheel Combo Thresholds"
   // (below) is off, and stay ready to resume immediately once it's
   // switched off again.
   var clipSelectStepSetting = host.getPreferences().getNumberSetting(
      "CTRL+Wheel: Ticks to Move to Next/Prev Clip or Track", "Wheel Options", 1, 32, 1, "ticks", 4);
   clipSelectStepSetting.markInterested();
   clipSelectStepSetting.addRawValueObserver(function(value) {
      clipSelectStepIndividual = value;
      applyWheelTickSettings();
   });

   // "Scale Clip / Duplicate / Delete" in the label names all 3 possible
   // outcomes since the actual one depends on the separate "SHIFT+CTRL
   // Wheel Action" dropdown (Function Keys category) - this only tunes
   // how many ticks it takes to fire whichever of the three is selected.
   var shiftCtrlWheelThresholdSetting = host.getPreferences().getNumberSetting(
      "SHIFT+CTRL+Wheel: Ticks to Scale Clip / Duplicate / Delete", "Wheel Options", 2, 64, 1, "ticks", 16);
   shiftCtrlWheelThresholdSetting.markInterested();
   shiftCtrlWheelThresholdSetting.addRawValueObserver(function(value) {
      shiftCtrlWheelThresholdIndividual = value;
      applyWheelTickSettings();
   });

   // Same as SHIFT+CTRL+Wheel above - paired with the "ALT+CTRL Wheel
   // Action" dropdown instead.
   var altCtrlWheelThresholdSetting = host.getPreferences().getNumberSetting(
      "ALT+CTRL+Wheel: Ticks to Scale Clip / Duplicate / Delete", "Wheel Options", 2, 64, 1, "ticks", 16);
   altCtrlWheelThresholdSetting.markInterested();
   altCtrlWheelThresholdSetting.addRawValueObserver(function(value) {
      altCtrlWheelThresholdIndividual = value;
      applyWheelTickSettings();
   });

   // "Override Wheel Combo Thresholds" - when on, all three combos above
   // ignore their own individual settings and use the single "Global
   // Tick Threshold (All Combos)" count instead, for anyone who'd rather
   // manage one shared default than three separate values.
   var useGlobalWheelTicksSetting = host.getPreferences().getBooleanSetting(
      "Override Wheel Combo Thresholds", "Wheel Options", false);
   useGlobalWheelTicksSetting.markInterested();
   useGlobalWheelTicksSetting.addValueObserver(function(value) {
      useGlobalWheelTicks = value;
      applyWheelTickSettings();
   });

   var globalWheelTicksSetting = host.getPreferences().getNumberSetting(
      "Global Tick Threshold (All Combos)", "Wheel Options", 1, 64, 1, "ticks", 16);
   globalWheelTicksSetting.markInterested();
   globalWheelTicksSetting.addRawValueObserver(function(value) {
      globalWheelTicks = value;
      applyWheelTickSettings();
   });

   // How long an F1-F8 green-state key's LCD name display lingers after
   // release - see revertBottomRowPopup() above. 0 reverts the instant the
   // button is released; the button-held duration itself is unaffected -
   // this only pads out the minimum for a quick tap that released before
   // there was time to read anything.
   var fkeyHoldLingerSetting = host.getPreferences().getNumberSetting(
      "F-Key Popup Duration After Release (ms)", "Function Keys", 0, 2000, 10, "ms", 300);
   fkeyHoldLingerSetting.markInterested();
   fkeyHoldLingerSetting.addRawValueObserver(function(value) {
      FKEY_HOLD_LINGER_MS = value;
   });

   // How long an F1-F8 green-state key has to stay held before the LCD
   // escalates from a brief single-key popup to the full all-8-key
   // learning reveal - see handleFKeyPress()/handleFKeyRelease() above. A
   // press shorter than this is just a normal tap: invoke + a quick
   // confirmation popup for that one key only, same as any other one-shot
   // LCD popup.
   var fkeyHoldThresholdSetting = host.getPreferences().getNumberSetting(
      "F-Key Hold Threshold (ms)", "Function Keys", 100, 2000, 10, "ms", 400);
   fkeyHoldThresholdSetting.markInterested();
   fkeyHoldThresholdSetting.addRawValueObserver(function(value) {
      FKEY_HOLD_THRESHOLD_MS = value;
   });

   // SHIFT+Encoder Mode/Step Size/Acceleration - see
   // shiftEncoderMode/ENCODER_STEP_SIZE_PERCENT/ENCODER_ACCELERATION_PERCENT
   // and applyEncoderStep()/applyEncoderAcceleration() above (the encoder
   // CC handler in onMidi). Own "Encoders" category since this applies to
   // every encoder target (pan, volume, macros, sends), not just Mixer
   // mode.
   var shiftEncoderModeSetting = host.getPreferences().getEnumSetting(
      "SHIFT+Encoder Mode", "Encoders", ["Stepped", "Fine"], "Stepped");
   shiftEncoderModeSetting.markInterested();
   shiftEncoderModeSetting.addValueObserver(function(value) {
      shiftEncoderMode = value;
   });

   var encoderStepSizeSetting = host.getPreferences().getNumberSetting(
      "Encoder Step Size (%)", "Encoders", 1, 50, 1, "%", 10);
   encoderStepSizeSetting.markInterested();
   encoderStepSizeSetting.addRawValueObserver(function(value) {
      ENCODER_STEP_SIZE_PERCENT = value;
   });

   var encoderAccelerationSetting = host.getPreferences().getNumberSetting(
      "Encoder Acceleration (%)", "Encoders", 0, 100, 1, "%", 0);
   encoderAccelerationSetting.markInterested();
   encoderAccelerationSetting.addRawValueObserver(function(value) {
      ENCODER_ACCELERATION_PERCENT = value;
   });

   // See allowSteppedDuringAutomationWrite above - off by default (Stepped
   // mode falls back to Fine while Arranger Automation Write is enabled),
   // on lets Stepped mode keep working even then, for anyone who actually
   // wants hard, quantized automation steps recorded.
   var allowSteppedDuringAutomationWriteSetting = host.getPreferences().getBooleanSetting(
      "Allow Stepped Encoders While Recording Automation", "Encoders", false);
   allowSteppedDuringAutomationWriteSetting.markInterested();
   allowSteppedDuringAutomationWriteSetting.addValueObserver(function(value) {
      allowSteppedDuringAutomationWrite = value;
   });

   // Auto-Detect Centered Macros by Name - see
   // assumeCenterForBipolarNamedMacros/nameSuggestsBipolar()/
   // BIPOLAR_NAME_KEYWORDS above. Shared by both Finer Resolution Near
   // Center and Encoder Snap to Origin below, so it lives above both.
   var assumeCenterForBipolarNamedMacrosSetting = host.getPreferences().getBooleanSetting(
      "Auto-Detect Centered Macros by Name", "Encoders", true);
   assumeCenterForBipolarNamedMacrosSetting.markInterested();
   assumeCenterForBipolarNamedMacrosSetting.addValueObserver(function(value) {
      assumeCenterForBipolarNamedMacros = value;
   });

   var bipolarNameKeywordsSetting = host.getPreferences().getStringSetting(
      "Centered Macro Keywords", "Encoders", 100, "pan,tune,fine,ftun,offset");
   bipolarNameKeywordsSetting.markInterested();
   bipolarNameKeywordsSetting.addValueObserver(function(value) {
      BIPOLAR_NAME_KEYWORDS = value;
      rebuildBipolarNameRegexes();
   });

   // Encoder Snap to Origin - see deviceSnapToOriginEnabled/
   // mixerSnapToOriginEnabled/isDeviceModeContext() above (the encoder CC
   // handler in onMidi). Own "Encoders" category (moved from "Mixer" now
   // that it's no longer pan-only) rather than piling onto "Wheel
   // Options", since it's a snap distance, not a wheel-tick debounce
   // threshold. Split into
   // Device/Plugin mode vs. Mixer mode (pan/volume/sends) so tuning one
   // context's snap behavior can't silently change the other's - see the
   // big comment above deviceSnapToOriginEnabled for why.
   var deviceSnapToOriginSetting = host.getPreferences().getBooleanSetting(
      "Encoder Snap to Origin (Device/Plugin Mode)", "Encoders", true);
   deviceSnapToOriginSetting.markInterested();
   deviceSnapToOriginSetting.addValueObserver(function(value) {
      deviceSnapToOriginEnabled = value;
   });

   var deviceSnapThresholdSetting = host.getPreferences().getNumberSetting(
      "Encoder Snap Range - Device/Plugin Mode (+/- %)", "Encoders", 0, 10, 0.1, "%", 2);
   deviceSnapThresholdSetting.markInterested();
   deviceSnapThresholdSetting.addRawValueObserver(function(value) {
      DEVICE_ENCODER_SNAP_THRESHOLD = value / 100;
   });

   var mixerSnapToOriginSetting = host.getPreferences().getBooleanSetting(
      "Encoder Snap to Origin (Mixer Mode)", "Encoders", true);
   mixerSnapToOriginSetting.markInterested();
   mixerSnapToOriginSetting.addValueObserver(function(value) {
      mixerSnapToOriginEnabled = value;
   });

   var mixerSnapThresholdSetting = host.getPreferences().getNumberSetting(
      "Encoder Snap Range - Mixer Mode (+/- %)", "Encoders", 0, 10, 0.1, "%", 2);
   mixerSnapThresholdSetting.markInterested();
   mixerSnapThresholdSetting.addRawValueObserver(function(value) {
      MIXER_ENCODER_SNAP_THRESHOLD = value / 100;
   });

   // How long the encoder has to sit idle (no further ticks) before the
   // idle-based check in scheduleEncoderSnapCheck() actually evaluates
   // where it landed - see the comment on encoderSnapGeneration above for
   // why this is idle-based rather than checked on every tick.
   var encoderSnapIdleDelaySetting = host.getPreferences().getNumberSetting(
      "Encoder Snap Idle Delay (ms)", "Encoders", 50, 2000, 10, "ms", 300);
   encoderSnapIdleDelaySetting.markInterested();
   encoderSnapIdleDelaySetting.addRawValueObserver(function(value) {
      ENCODER_SNAP_IDLE_MS = value;
   });

   // Finer Resolution Near Center - see fineZoneNearOriginEnabled/
   // FINE_ZONE_RANGE/FINE_ZONE_RESOLUTION_MULTIPLIER and isNearOrigin()
   // above. Sharpens encoder resolution automatically near a parameter's
   // real origin (e.g. fine-tune macros, pan) so it's actually possible
   // to land back on center by hand.
   var fineZoneNearOriginSetting = host.getPreferences().getBooleanSetting(
      "Finer Resolution Near Center", "Encoders", true);
   fineZoneNearOriginSetting.markInterested();
   fineZoneNearOriginSetting.addValueObserver(function(value) {
      fineZoneNearOriginEnabled = value;
   });

   var fineZoneRangeSetting = host.getPreferences().getNumberSetting(
      "Finer Resolution Range (+/- %)", "Encoders", 0.5, 20, 0.5, "%", 5);
   fineZoneRangeSetting.markInterested();
   fineZoneRangeSetting.addRawValueObserver(function(value) {
      FINE_ZONE_RANGE = value / 100;
   });

   var fineZoneResolutionMultiplierSetting = host.getPreferences().getNumberSetting(
      "Finer Resolution Multiplier", "Encoders", 2, 16, 1, "x", 4);
   fineZoneResolutionMultiplierSetting.markInterested();
   fineZoneResolutionMultiplierSetting.addRawValueObserver(function(value) {
      FINE_ZONE_RESOLUTION_MULTIPLIER = value;
   });

   // Encoder Push Behavior (Device/Plugin Mode) - see
   // deviceEncoderPushBehavior/DEVICE_ENCODER_PUSH_FINE_MULTIPLIER/
   // encoderPushHeld above. Resets encoderPushHeld on change so a mode
   // switch mid-press can't leave a stale "held" flag stuck on from
   // whichever behavior was active when the encoder was physically
   // pressed down.
   var deviceEncoderPushBehaviorSetting = host.getPreferences().getEnumSetting(
      "Encoder Push Behavior (Device/Plugin Mode)", "Encoders",
      ["Fine Resolution", "Reset to Default", "Open/Close Plugin Window"], "Fine Resolution");
   deviceEncoderPushBehaviorSetting.markInterested();
   deviceEncoderPushBehaviorSetting.addValueObserver(function(value) {
      deviceEncoderPushBehavior = value;
      encoderPushHeld = [false, false, false, false, false, false, false, false];
   });

   var deviceEncoderPushFineMultiplierSetting = host.getPreferences().getNumberSetting(
      "Encoder Push Fine Resolution Multiplier", "Encoders", 2, 32, 1, "x", 8);
   deviceEncoderPushFineMultiplierSetting.markInterested();
   deviceEncoderPushFineMultiplierSetting.addRawValueObserver(function(value) {
      DEVICE_ENCODER_PUSH_FINE_MULTIPLIER = value;
   });

   // Select Channel on Fader Touch - see the Fader Touch handling in
   // onMidi (notes 104-112) above. Same name/idea as the identically-named
   // setting in Mossgraber's DrivenByMoss MCU driver.
   var selectChannelOnFaderTouchSetting = host.getPreferences().getBooleanSetting(
      "Select Channel on Fader Touch", "Mixer", true);
   selectChannelOnFaderTouchSetting.markInterested();
   selectChannelOnFaderTouchSetting.addValueObserver(function(value) {
      selectChannelOnFaderTouch = value;
   });

   // See scheduleSelectChannelOnTouch() above - debounces Select Channel
   // on Fader Touch so riding several faders together settles on one
   // selection instead of flickering through each one as you grab it. 0
   // (default) selects immediately, same as classic MCU behavior.
   var selectOnTouchDelaySetting = host.getPreferences().getNumberSetting(
      "Select Channel on Fader Touch Delay (ms)", "Mixer", 0, 1000, 10, "ms", 0);
   selectOnTouchDelaySetting.markInterested();
   selectOnTouchDelaySetting.addRawValueObserver(function(value) {
      SELECT_ON_TOUCH_DELAY_MS = value;
   });

   // Fader Snap to Zero - see faderSnapToZeroEnabled/FADER_SNAP_ZERO_RANGE/
   // FADER_SNAP_ZERO_DELAY_MS and scheduleFaderSnapZeroCheck() above.
   var faderSnapToZeroSetting = host.getPreferences().getBooleanSetting(
      "Fader Snap to Zero", "Mixer", true);
   faderSnapToZeroSetting.markInterested();
   faderSnapToZeroSetting.addValueObserver(function(value) {
      faderSnapToZeroEnabled = value;
   });

   var faderSnapZeroRangeSetting = host.getPreferences().getNumberSetting(
      "Fader Snap to Zero Range (%)", "Mixer", 0, 10, 0.5, "%", 3);
   faderSnapZeroRangeSetting.markInterested();
   faderSnapZeroRangeSetting.addRawValueObserver(function(value) {
      FADER_SNAP_ZERO_RANGE = value / 100;
   });

   var faderSnapZeroDelaySetting = host.getPreferences().getNumberSetting(
      "Fader Snap to Zero Delay (ms)", "Mixer", 100, 3000, 50, "ms", 500);
   faderSnapZeroDelaySetting.markInterested();
   faderSnapZeroDelaySetting.addRawValueObserver(function(value) {
      FADER_SNAP_ZERO_DELAY_MS = value;
   });

   // See sendBankConfiguredPages above - how many pages a normal SEND
   // press cycles through before exiting to Mixer. The underlying send
   // bank stays sized at MAX_SENDS (16) regardless, so this only affects
   // the button's own paging and takes effect live.
   var sendBankSizeSetting = host.getPreferences().getEnumSetting(
      "Send/Return Bank Size", "Mixer", ["8", "16"], "16");
   sendBankSizeSetting.markInterested();
   sendBankSizeSetting.addValueObserver(function(value) {
      sendBankConfiguredPages = value === "8" ? 1 : 2;
   });

   // See mixerPageLoopBehavior/jumpToMarkerAndSetLoop() above.
   var mixerPageLoopBehaviorSetting = host.getPreferences().getEnumSetting(
      "Mixer Mode PAGE: Loop Behavior", "Mixer",
      ["Keep Loop Length", "Loop Between Markers"], "Keep Loop Length");
   mixerPageLoopBehaviorSetting.markInterested();
   mixerPageLoopBehaviorSetting.addValueObserver(function(value) {
      mixerPageLoopBehavior = value;
   });

   // See hideDeactivatedTracksEnabled/refreshMainCursors() above -
   // requested directly, for keeping backup/experimental tracks
   // deactivated-and-hidden in Bitwig itself from also cluttering the
   // 8-channel bank here. "Show All" just blanks the deactivated track's
   // name/value text in place (matches DrivenByMoss's own approach - it
   // never filters a bank, only dims); "Hide" fully excludes it, shifting
   // the next activated track into its slot - Main tracks only, Returns
   // is unaffected either way. Switching live re-syncs the 8 cursors,
   // display, LEDs and fader/encoder bindings immediately.
   var hideDeactivatedTracksSetting = host.getPreferences().getEnumSetting(
      "Deactivated Tracks in Bank", "Mixer",
      ["Show All (Dim Name)", "Hide (Skip and Shift)"], "Show All (Dim Name)");
   hideDeactivatedTracksSetting.markInterested();
   hideDeactivatedTracksSetting.addValueObserver(function (value) {
      hideDeactivatedTracksEnabled = (value === "Hide (Skip and Shift)");
      mainMappingDirty = true;
      if (currentMode === MODE_MIXER) {
         refreshMainCursors();
         refreshDisplayText();
         rebindFaders();
      }
   });

   // See bankScrollLeftSelectIndex/bankScrollRightSelectIndex and
   // selectFirstTrackOfBank()/selectLastTrackOfBank() above - which track
   // (1-8) a left/right bank scroll selects, so Bitwig's own view follows
   // along. Requested directly: the original first-slot/last-slot
   // (1/8) behavior can feel like it always jumps to the window's
   // extreme edge - a slot nearer the center (e.g. 3 on the left, 6 on
   // the right) might make Bitwig's own scrolled-into-view result feel
   // less jarring. Worth experimenting with on hardware, hence
   // configurable rather than a fixed redesign either way.
   var bankScrollLeftSelectSetting = host.getPreferences().getNumberSetting(
      "Bank Scroll Left: Select Track #", "Mixer", 1, 8, 1, "", 1);
   bankScrollLeftSelectSetting.markInterested();
   bankScrollLeftSelectSetting.addRawValueObserver(function (value) {
      bankScrollLeftSelectIndex = value - 1;
   });

   var bankScrollRightSelectSetting = host.getPreferences().getNumberSetting(
      "Bank Scroll Right: Select Track #", "Mixer", 1, 8, 1, "", 8);
   bankScrollRightSelectSetting.markInterested();
   bankScrollRightSelectSetting.addRawValueObserver(function (value) {
      bankScrollRightSelectIndex = value - 1;
   });

   // See selectLedVelocityFor()/armedLedBlinkTick() above. Turning this
   // off immediately restores every SELECT LED to its plain isSelected
   // state via refreshChannelStripLEDs() (selectLedVelocityFor() checks
   // the flag itself, so this doesn't need to wait for the next blink
   // tick to catch up) - otherwise a channel could stay stuck showing
   // whatever step it was on at the exact moment it was disabled.
   var armedLedBlinkEnabledSetting = host.getPreferences().getBooleanSetting(
      "Blink Armed Track's SELECT LED", "Mixer", true);
   armedLedBlinkEnabledSetting.markInterested();
   armedLedBlinkEnabledSetting.addValueObserver(function(value) {
      armedLedBlinkEnabled = value;
      refreshChannelStripLEDs();
   });

   var armedLedBlinkIntervalSetting = host.getPreferences().getNumberSetting(
      "Armed SELECT LED Blink Rate (ms)", "Mixer", 100, 2000, 10, "ms", 1000);
   armedLedBlinkIntervalSetting.markInterested();
   armedLedBlinkIntervalSetting.addRawValueObserver(function(value) {
      ARMED_LED_BLINK_INTERVAL_MS = value;
   });

   // Remote Controls (8 Macros for selected device)
   remoteControls = cursorDevice.createCursorRemoteControlsPage(8);
   // discreteValueCount()/discreteValueNames()/getOrigin() need
   // markInterested() (or an observer) before .get() works, same as any
   // other Value - see applyEncoderStep() for why discreteValueCount/Names
   // matters for macros specifically (telling a macro that's an on/off
   // switch apart from a continuous one) and scheduleEncoderSnapCheck()
   // for getOrigin() (each macro's own real "home" value to snap to).
   for (var rcIdx = 0; rcIdx < 8; rcIdx++) {
      var rcParam = remoteControls.getParameter(rcIdx);
      rcParam.discreteValueCount().markInterested();
      rcParam.discreteValueNames().markInterested();
      rcParam.getOrigin().markInterested();
   }

   // Last-clicked-in-GUI parameter (see ALT + Jog Wheel in the wheel
   // handler above) - id is used for persistent state, per the Javadoc,
   // so keep it stable across versions.
   lastClickedParam = host.createLastClickedParameter("lastClickedParam", "Mouseover Parameter");
   lastClickedParamValue = lastClickedParam.parameter();
   lastClickedParamValue.name().markInterested();
   lastClickedParamLocked = lastClickedParam.isLocked();
   lastClickedParamLocked.markInterested();
   lastClickedParamLocked.addValueObserver(function (locked) {
      host.showPopupNotification((locked ? "Locked to: " : "Unlocked: ") + lastClickedParamValue.name().get());
   });

   // Transport & Application Controls
   transport = host.createTransport();
   application = host.createApplication();
   arranger = host.createArranger();

   // ZOOM+LEFT/RIGHT (see case 98/99 below) - Arranger extends
   // TimelineEditor, whose getHorizontalScrollbarModel() exposes the
   // actual horizontal (timeline) zoom level as a readable/adjustable
   // ScrollbarModel (API version 21+) - previously assumed unavailable
   // ("no API to pan the arranger's visible timeframe independently of
   // the playhead - same limitation as horizontal zoom"), which turned
   // out to only be true for an absolute get/set; a relative
   // zoomAtPosition(position, distance) adjuster does exist.
   // getContentPerPixel() marked interested here in case a future
   // feature wants to read/display the actual zoom level - not used by
   // the arrow-key zoom itself, which only calls zoomAtPosition().
   arrangerHorizontalScrollbar = arranger.getHorizontalScrollbarModel();
   arrangerHorizontalScrollbar.getContentPerPixel().markInterested();

   // SHIFT+HOME's "Bar N" auto-named cue marker (see case 89 below) needs
   // to find the marker it JUST created (Transport has no "add marker
   // and return it"/"add marker with this name" call - only a bare
   // addCueMarkerAtPlaybackPosition()) by matching its position, and
   // Mixer Mode PAGE (see findAdjacentMarkerPosition()/case 82-83 below)
   // needs to scan every marker's position to find the closest one before/
   // after the playhead - so every slot's position() AND exists() (to
   // tell an actual marker apart from an empty slot within the scan
   // depth) need markInterested() up front for .get() to work later.
   // CUE_MARKER_SCAN_DEPTH deep - a generous cap, same "big enough window"
   // approach as EQ_DEVICE_SCAN_DEPTH/TOOL_DEVICE_SCAN_DEPTH elsewhere in
   // this file. name() doesn't need markInterested() - only ever .set()
   // here, never .get() (same as isWindowOpen().set() calls elsewhere in
   // this file working fine without it).
   cueMarkerBank = arranger.createCueMarkerBank(CUE_MARKER_SCAN_DEPTH);
   for (var cueMarkerIdx = 0; cueMarkerIdx < CUE_MARKER_SCAN_DEPTH; cueMarkerIdx++) {
      cueMarkerBank.getItemAt(cueMarkerIdx).position().markInterested();
      cueMarkerBank.getItemAt(cueMarkerIdx).exists().markInterested();
   }

   // Read on-demand (not observed) by END, CTRL+PUNCH IN/OUT, and the jog
   // wheel's bar-jump/loop-shift handling, so they need markInterested() or
   // .get() throws.
   transport.getPosition().markInterested();
   // Used by setTransportPosition() below instead of transport.getPosition()
   // directly for seeking, so jumps also work while playing - see that
   // function's comment.
   transport.playStartPosition().markInterested();
   transport.arrangerLoopStart().markInterested();
   transport.arrangerLoopDuration().markInterested();
   transport.timeSignature().numerator().markInterested();
   transport.timeSignature().denominator().markInterested();
   // Read on-demand by SHIFT+DRAW (case 81) to show the resulting ON/OFF
   // state in its popup, rather than a generic "toggled" message.
   transport.isArrangerAutomationWriteEnabled().markInterested();

   // Segment display (the separate "BEATS" transport-position display,
   // notes 40-53 are NOT it - this is CC 0x40-0x49, 10 digit cells,
   // confirmed via Mossgraber's MCUSegmentDisplay.java) - Bars:Beats:
   // Subdivision:Ticks, 3+2+2+3 = 10 digits, matching genuine MCU layout.
   // This is the display's real, intended default purpose - it was
   // already showing "BEATS" as its own idle label before this script
   // ever sent it anything, waiting for exactly this. See
   // updateSegmentDisplay(), called from flush().
   positionFormatter = host.createBeatTimeFormatter(":", 3, 2, 2, 3);

   // Setup Observers for both Main (via mainTrackCursors - see
   // activeTrackAt() above) and Returns - only the currently-active
   // representation (per isActiveFn) writes to the shared display
   // caches / LEDs.
   var effectTrackBankItems = bankToTrackArray(effectTrackBank);
   setupChannelStripObservers(mainTrackCursors, mainLedState, function (index) {
      return !isViewingReturns && (!hideDeactivatedTracksEnabled || mainCursorHasTrack[index]);
   });
   setupChannelStripObservers(effectTrackBankItems, returnsLedState, function () {
      return isViewingReturns;
   });

   // Enable metering (mode=3: LED + LCD) for each of the 8 channel strips -
   // real MCU protocol per Ableton's own driver (ChannelStrip.py). The
   // fader-motor bug this was once suspected of causing (and briefly
   // disabled to rule out) turned out to be unrelated - see
   // updateFaderOutputs() below - so this is back to its intended state.
   for (var meterStripIdx = 0; meterStripIdx < 8; meterStripIdx++) {
      midiOut.sendSysexBytes([0xF0, 0x00, 0x00, 0x66, 0x14, 0x20, meterStripIdx, 3, 0xF7]);
   }

   // Debug / diagnostics hub (Controller Preferences panel -> "Debug"
   // category) - see the DEBUG_ENABLED/DEBUG_* globals and debugLog()
   // near the top of this file for what each category actually gates.
   // All default to true, matching this project's current maturity.
   // "Enable Debug Logging" is the master switch: besides silencing
   // every category below via DEBUG_ENABLED, it also hide()/show()s
   // their individual checkboxes in this panel - unchecking it collapses
   // the whole hub down to just itself, a preview of retiring debug
   // logging altogether once this project is more mature and end users
   // shouldn't see any of this.
   var debugEnabledSetting = host.getPreferences().getBooleanSetting(
      "Enable Debug Logging", "Debug", true);
   debugEnabledSetting.markInterested();

   var debugRawMidiSetting = host.getPreferences().getBooleanSetting(
      "Log Raw MIDI (Controller Input)", "Debug", true);
   debugRawMidiSetting.markInterested();
   debugRawMidiSetting.addValueObserver(function (value) { DEBUG_RAW_MIDI = value; });

   var debugButtonDispatchSetting = host.getPreferences().getBooleanSetting(
      "Log Button Dispatch", "Debug", true);
   debugButtonDispatchSetting.markInterested();
   debugButtonDispatchSetting.addValueObserver(function (value) { DEBUG_BUTTON_DISPATCH = value; });

   var debugModifierStateSetting = host.getPreferences().getBooleanSetting(
      "Log Modifier State (SHIFT/OPTION/CTRL/ALT) in Raw MIDI", "Debug", true);
   debugModifierStateSetting.markInterested();
   debugModifierStateSetting.addValueObserver(function (value) { DEBUG_MODIFIER_STATE = value; });

   var debugLcdSetting = host.getPreferences().getBooleanSetting(
      "Log LCD Display SysEx", "Debug", true);
   debugLcdSetting.markInterested();
   debugLcdSetting.addValueObserver(function (value) { DEBUG_LCD = value; });

   var debugEncoderSetting = host.getPreferences().getBooleanSetting(
      "Log Encoder Target Classification", "Debug", true);
   debugEncoderSetting.markInterested();
   debugEncoderSetting.addValueObserver(function (value) { DEBUG_ENCODER = value; });

   // Moved here from its own former "Diagnostics" category, per request,
   // for consistency - it's a live hardware-experimentation control same
   // as everything else in this hub, so it belongs alongside it rather
   // than off on its own. Live-testable meter mode for channel 8 only
   // (the other 7 strips stay on the confirmed mode=3 elsewhere) - lets
   // us try each of the 4 real MCU VU-meter modes (confirmed against
   // Mossgraber's switchVuMode()/VUMODE_* in MCUControlSurface.java, not
   // guessed) from the Controller Preferences panel and see the result on
   // hardware immediately, no redeploy needed. Result so far: every mode
   // (including "Off") produced the same live level bar on this unit's
   // LCD, so it doesn't look like this hardware distinguishes between the
   // mode byte values the way genuine Mackie hardware does - didn't
   // reveal anything new, but left in as a live knob in case that's worth
   // revisiting (e.g. after other LCD experiments) rather than concluding
   // this hardware categorically can't do anything more with it.
   var meterTestModeValues = {
      "LED + LCD (default, mode 3)": 3,
      "Off (mode 0)": 0,
      "LED Only (mode 1)": 1,
      "LCD Only (mode 6)": 6
   };
   var meterTestModeSetting = host.getPreferences().getEnumSetting(
      "Channel 8 Meter Test Mode", "Debug",
      ["LED + LCD (default, mode 3)", "Off (mode 0)", "LED Only (mode 1)", "LCD Only (mode 6)"],
      "LED + LCD (default, mode 3)");
   meterTestModeSetting.markInterested();
   meterTestModeSetting.addValueObserver(function (value) {
      midiOut.sendSysexBytes([0xF0, 0x00, 0x00, 0x66, 0x14, 0x20, 7, meterTestModeValues[value], 0xF7]);
   });

   var debugCategorySettings = [
      debugRawMidiSetting, debugButtonDispatchSetting,
      debugModifierStateSetting, debugLcdSetting, debugEncoderSetting,
      meterTestModeSetting
   ];
   debugEnabledSetting.addValueObserver(function (value) {
      DEBUG_ENABLED = value;
      for (var debugSettingIdx = 0; debugSettingIdx < debugCategorySettings.length; debugSettingIdx++) {
         if (value) {
            debugCategorySettings[debugSettingIdx].show();
         } else {
            debugCategorySettings[debugSettingIdx].hide();
         }
      }
   });

   // Track each bank's per-track TOOL_DEVICE_NAME device, if any (see
   // isToolVolumeMode). mainTrackCursors' own createDeviceBank() calls
   // (inside scanTrackForToolDevice()) automatically follow each cursor
   // as it's re-pointed via selectChannel() - same cursor-relative-bank
   // behavior cursorTrack's own device tracking below already relies on.
   setupToolDeviceTracking(mainTrackCursors, mainToolSlot, mainToolRemote);
   setupToolDeviceTracking(effectTrackBankItems, returnsToolSlot, returnsToolRemote);
   cursorToolRemote = scanTrackForToolDevice(
      cursorTrack,
      function (deviceIndex) { cursorToolSlot = deviceIndex; },
      function (deviceIndex) { if (cursorToolSlot === deviceIndex) { cursorToolSlot = -1; } }
   );

   // Setup Observers for 16 Sends on Cursor Track (For Fader Send Control Mode)
   for (var s = 0; s < MAX_SENDS; s++) {
      (function (sendIdx) {
         var sendItem = cursorTrack.sendBank().getItemAt(sendIdx);

         sendItem.value().markInterested();
         sendItem.discreteValueCount().markInterested();
         sendItem.discreteValueNames().markInterested();
         sendItem.getOrigin().markInterested();

         sendItem.displayedValue().addValueObserver(function (dispVal) {
            if (currentMode === MODE_SENDS) {
               var offset = sendBankPage * 8;
               if (sendIdx >= offset && sendIdx < offset + 8) {
                  var channelIdx = sendIdx - offset;
                  bottomRowText[channelIdx] = formatString(dispVal, 7);
                  displayNeedsUpdate = true;
               }
            }
         });

         sendItem.name().addValueObserver(function (sendName) {
            if (currentMode === MODE_SENDS) {
               var offset = sendBankPage * 8;
               if (sendIdx >= offset && sendIdx < offset + 8) {
                  var channelIdx = sendIdx - offset;
                  topRowText[channelIdx] = formatTrackName(sendName || ("Send " + (sendIdx + 1)), 7);
                  displayNeedsUpdate = true;
               }
            }
         });
      })(s);
   }

   // Master Track Volume - kept only for markInterested(), see the
   // comment on the send observer above. discreteValueCount() also needed
   // for Fader Snap to Zero (see scheduleFaderSnapZeroCheck() below) to
   // skip a genuine discrete/switch target the same way the other fader
   // targets (channel volume/pan, sends, macros) already do.
   masterTrack.volume().value().markInterested();
   masterTrack.volume().discreteValueCount().markInterested();

   // Device Parameter Observers (For Custom Device Remote Control Mode)
   for (var j = 0; j < 8; j++) {
      (function (paramIndex) {
         var param = remoteControls.getParameter(paramIndex);

         param.name().addValueObserver(function (name) {
            if (currentMode === MODE_DEVICE) {
               topRowText[paramIndex] = formatTrackName(name, 7);
               displayNeedsUpdate = true;
            }
         });

         param.displayedValue().addValueObserver(function (valueStr) {
            if (currentMode === MODE_DEVICE) {
               bottomRowText[paramIndex] = formatString(valueStr, 7);
               displayNeedsUpdate = true;
            }
         });

         // Kept only for markInterested(), see the comment on the send
         // observer in setupChannelStripObservers.
         param.value().markInterested();
      })(j);
   }

   // Transport Observers
   transport.isPlaying().addValueObserver(function (isPlaying) {
      midiOut.sendMidi(0x90, 94, isPlaying ? 127 : 0); // Play LED
      midiOut.sendMidi(0x90, 93, !isPlaying ? 127 : 0); // Stop LED
   });

   transport.isArrangerRecordEnabled().addValueObserver(function (isRecording) {
      midiOut.sendMidi(0x90, 95, isRecording ? 127 : 0); // Record LED
   });

   transport.isArrangerLoopEnabled().addValueObserver(function (isLoop) {
      midiOut.sendMidi(0x90, 86, isLoop ? 127 : 0); // Loop LED
   });

   transport.isMetronomeEnabled().addValueObserver(function (isClick) {
      midiOut.sendMidi(0x90, 89, isClick ? 127 : 0); // Metronome LED
   });

   // Cursor Track Name Observer
   cursorTrack.name().addValueObserver(function (trackName) {
      if (currentMode === MODE_SENDS) {
         refreshDisplayText();
         rebindFaders();
      }
   });

   // Device Name Observer
   cursorDevice.name().addValueObserver(function (devName) {
      if (currentMode === MODE_DEVICE) {
         host.showPopupNotification("Plugin: " + devName);
      }
   });

   // Point mainTrackCursors at the plain trackBank window before anything
   // reads through activeTrackAt() below (hideDeactivatedTracksEnabled
   // starts false, so this is just the native 8-track window - Hide
   // mode's filtered mapping only takes over once mainMappingTick() has
   // had a chance to populate activeTrackRawIndices, and once the user
   // actually switches the Controller Preferences setting on).
   refreshMainCursors();

   // Flush display initially
   updateModeLEDs();
   rebindFaders();
   host.scheduleTask(displayFlushTask, 100);
   host.scheduleTask(armedLedBlinkTick, ARMED_LED_BLINK_INTERVAL_MS);
   host.scheduleTask(flushWorkaroundTick, 100);
   host.scheduleTask(mainMappingTick, 100);

   println("Midiplus UP Controller Script Ready.");
}

// Returns still uses a plain fixed-window TrackBank directly (unlike Main
// - see mainTrackCursors above), so setupChannelStripObservers()/
// setupToolDeviceTracking() below (which both take a plain 8-item array,
// not a bank) need this to convert it once at init().
function bankToTrackArray(bank) {
   var tracks = [];
   for (var i = 0; i < 8; i++) {
      tracks.push(bank.getItemAt(i));
   }
   return tracks;
}

// Wires up the Name/Volume/Pan/Arm/Solo/Mute/Select observers for one of the
// two 8-track banks (main tracks or return tracks). `ledState` is the cache
// this bank's Arm/Solo/Mute/Select observers update; only when isActiveFn(index)
// is true does this representation actually push MIDI LED updates or
// display text, so Main/Returns (and, for Main, Show All vs. Hide) don't
// fight over the shared hardware state while another one is in the
// background.
// tracks is a plain array of 8 Track-like objects (either 8
// effectTrackBank.getItemAt(i) proxies for Returns, or the 8
// mainTrackCursors for Main tracks - see activeTrackAt() above), not a
// bank object directly, since Main tracks no longer have a single bank
// to pull a fixed getItemAt(index) from. isActiveFn(index) replaces the
// old isViewingReturns === isReturnsBank check - for Main it also folds
// in mainCursorHasTrack (Hide mode's empty trailing slots).
//
// isActivated() blanks a deactivated track's name/value text in place
// (Show All/dim mode's "dim" - this hardware's LCD is monochrome
// text-only, so blanking is the closest equivalent to visually dimming
// it) - harmless to check unconditionally for Returns too, and for Main
// in Hide mode this essentially never trips since deactivated tracks are
// already filtered out of activeTrackRawIndices before a cursor can ever
// point at one.
function setupChannelStripObservers(tracks, ledState, isActiveFn) {
   for (var i = 0; i < 8; i++) {
      (function (index) {
         var track = tracks[index];

         // Read on-demand (not observed) by the SELECT double-press
         // group-fold handler in handleButtonPress, so need markInterested().
         track.isGroup().markInterested();
         track.isGroupExpanded().markInterested();
         track.isActivated().markInterested();

         // Track Name Observer
         track.name().addValueObserver(function (name) {
            if (currentMode === MODE_MIXER && isActiveFn(index)) {
               topRowText[index] = track.isActivated().get() ? formatTrackName(name, 7) : "       ";
               displayNeedsUpdate = true;
            }
         });

         track.volume().value().markInterested();
         track.volume().discreteValueCount().markInterested();
         track.volume().discreteValueNames().markInterested();
         track.volume().getOrigin().markInterested();
         // name() needed for nameSuggestsBipolar() (see resolveOrigin()) -
         // Volume's own getOrigin() is already correctly 0, so this is
         // really just there so resolveOrigin() can safely call
         // target.name().get() on ANY encoder target without an "either
         // call markInterested() or add an observer" error; Volume/Pan's
         // names never actually match the bipolar keyword list, so this
         // can't change their (already correct) origin handling.
         track.volume().name().markInterested();
         track.pan().discreteValueCount().markInterested();
         track.pan().discreteValueNames().markInterested();
         track.pan().getOrigin().markInterested();
         track.pan().name().markInterested();

         track.volume().displayedValue().addValueObserver(function (dispVal) {
            if (currentMode === MODE_MIXER && !isFlipped && isActiveFn(index) &&
                !isShowingPanTemporarily[index]) {
               bottomRowText[index] = track.isActivated().get() ? formatString(dispVal, 7) : "       ";
               displayNeedsUpdate = true;
            }
         });

         // Bottom row's temporary pan reveal while turning the encoder -
         // see revealPanTemporarily() above. Uses the raw value (formatted
         // ourselves via formatPanLR() into the classic "50L"/"50R"/"C"
         // style) rather than Bitwig's own displayedValue() string, which
         // is a plain percentage with no L/R indicator.
         track.pan().value().addValueObserver(function (rawVal) {
            if (currentMode === MODE_MIXER && !isFlipped && isActiveFn(index) &&
                isShowingPanTemporarily[index]) {
               bottomRowText[index] = formatString(formatPanLR(rawVal), 7);
               displayNeedsUpdate = true;
            }
         });

         // Track Color - read on-demand (not observed) by
         // updateChannelColorOutput(), polled every flush() like the
         // fader/V-Pot ring outputs - see there for why. markInterested()
         // needed for .color().red()/.green()/.blue() to be valid.
         track.color().markInterested();

         // Track Meter Observer - real MCU protocol per Ableton's own
         // driver (ChannelStrip.py): meter level (0-12) is sent as a
         // Channel Pressure message on MIDI channel 1 (status 0xD0, always
         // - not per-strip), with a single data byte packing the strip
         // index into the high nibble and the level into the low nibble.
         // Requires the meter-enable SysEx sent once in init() above.
         // Confirmed working on all 8 channels, including channel 8, once
         // audio was actually routed to it (the earlier "not updating"
         // report was a routing issue, not a script bug).
         track.addVuMeterObserver(13, -1, true, function (level) {
            if (currentMode === MODE_MIXER && isActiveFn(index)) {
               midiOut.sendMidi(0xD0, (index << 4) | level, 0);
            }
         });

         // Track Button State Observers (LED Feedback) - cached per-bank,
         // only sent to hardware while this bank is the active one.
         track.arm().addValueObserver(function (isArmed) {
            ledState.arm[index] = isArmed;
            if (isActiveFn(index)) {
               midiOut.sendMidi(0x90, 0 + index, isArmed ? 127 : 0); // Rec Arm LED
               // Select LED reacts too - see selectLedVelocityFor() above,
               // an armed track breathes there regardless of selection.
               midiOut.sendMidi(0x90, 24 + index, selectLedVelocityFor(index, ledState));
            }
         });

         track.solo().addValueObserver(function (isSoloed) {
            ledState.solo[index] = isSoloed;
            if (isActiveFn(index)) {
               midiOut.sendMidi(0x90, 8 + index, isSoloed ? 127 : 0); // Solo LED
            }
         });

         track.mute().addValueObserver(function (isMuted) {
            ledState.mute[index] = isMuted;
            if (isActiveFn(index)) {
               midiOut.sendMidi(0x90, 16 + index, isMuted ? 127 : 0); // Mute LED
            }
         });

         track.addIsSelectedInMixerObserver(function (isSelected) {
            ledState.select[index] = isSelected;
            if (isActiveFn(index)) {
               // Select LED - breathes instead if this track is armed,
               // see selectLedVelocityFor() above.
               midiOut.sendMidi(0x90, 24 + index, selectLedVelocityFor(index, ledState));
               if (isSelected) {
                  // Briefly show the selected track's color as a human
                  // -readable name (there's no color-name API - see
                  // nameForTrackColor()) instead of its usual name/volume
                  // text, so it's easier to spot which track is now
                  // selected at a glance.
                  showBottomRowPopup(index, nameForTrackColor(track.color()));
               }
            }
         });

      })(i);
   }
}

// "EQ Mode" (SHIFT+PLUG-INS - see case 44 below) - requested directly:
// jump straight to whichever EQ is LAST in the selected track's chain
// (several different EQs might be stacked - a corrective one early,
// a tonal one late - "last in chain" is deliberately the one picked,
// not "first match") and toggle its window open/closed. Bitwig has no
// device-category metadata usable for this (Device.deviceType() only
// distinguishes AUDIO_FX/INSTRUMENT/NOTE_FX, not "EQ" vs. any other
// audio effect), and third-party plugin names vary by vendor, so - same
// approach as the Bipolar Macro Name Keywords case earlier - this
// matches the device's own name against a configurable keyword list.
// EQ_DEVICE_NAME_KEYWORDS defaults to "eq,pro-q": "eq" (leading-boundary
// match, i.e. \beq, not \beq\b - see rebuildEqNameRegexes() below) covers
// Bitwig's own built-in EQ+/EQ-2/EQ-5 and any "Equalizer"-named device,
// while deliberately NOT requiring a trailing boundary means a version
// suffix right after the keyword (no space) still matches; "pro-q"
// covers FabFilter Pro-Q 3/4 by name, which - as directly reported - is
// the EQ actually in daily use, and wouldn't match a bare "eq" keyword
// at all ("Pro-Q" has no "eq" substring - the letters aren't even
// adjacent). Leading-boundary-only (not full \bkeyword\b like the
// Bipolar Macro case) specifically because of that trailing-digit
// pattern common in plugin names ("Pro-Q4", "EQ-2") - a trailing \b
// wouldn't match immediately before a digit with no separator. Verified
// against a quick standalone test before shipping: "EQ+"/"EQ-2"/"EQ-5"/
// "Equalizer"/"FabFilter Pro-Q 3"/"Pro-Q4"/"Pro-Q 4" all match; "Sequence"/
// "Note Sequencer"/"Compressor"/"Waves API 550" correctly don't (a bare
// substring match, without the leading boundary, would have wrongly
// matched "Sequence" on "eq").
var EQ_DEVICE_NAME_KEYWORDS = "eq,pro-q";
var eqNameRegexes = [];

function rebuildEqNameRegexes() {
   eqNameRegexes = [];
   var keywords = EQ_DEVICE_NAME_KEYWORDS.split(",");
   for (var i = 0; i < keywords.length; i++) {
      var keyword = keywords[i].trim();
      if (keyword) {
         eqNameRegexes.push(new RegExp("\\b" + escapeRegExp(keyword), "i"));
      }
   }
}
rebuildEqNameRegexes();

function nameMatchesEqKeywords(name) {
   for (var i = 0; i < eqNameRegexes.length; i++) {
      if (eqNameRegexes[i].test(name)) {
         return true;
      }
   }
   return false;
}

// Live-updated by name observers set up in init() (one per
// eqDeviceBank slot, EQ_DEVICE_SCAN_DEPTH deep into the SELECTED
// track's chain) - an empty string means that slot has no device.
var eqDeviceNames = [];

// Returns the index of the LAST device in eqDeviceNames whose name
// matches nameMatchesEqKeywords(), or -1 if none do. Deliberately keeps
// scanning past the first match instead of returning early - "last in
// chain" is the whole point (see the big comment above).
function findLastEqDeviceIndex() {
   var lastMatch = -1;
   for (var i = 0; i < EQ_DEVICE_SCAN_DEPTH; i++) {
      if (eqDeviceNames[i] && nameMatchesEqKeywords(eqDeviceNames[i])) {
         lastMatch = i;
      }
   }
   return lastMatch;
}

// SHIFT+HOME's "Bar N" cue marker naming (case 89) - Transport only
// offers a bare addCueMarkerAtPlaybackPosition(), no "add and return the
// new marker"/"add with this name" call, so the only way to reach the
// just-created marker is to find it again: scans cueMarkerBank for a
// marker whose position matches expectedPositionBeats (the playhead
// position captured at button-press time - the same value Bitwig itself
// assigns the new marker, so an exact-ish match, not a fuzzy search) and
// renames that one. Called from a short host.scheduleTask() delay after
// creating the marker (see case 89), not immediately, since the new
// marker isn't guaranteed to be visible in the bank within the same tick
// it was requested - not yet confirmed on hardware whether this delay is
// long enough, or even necessary; adjust CUE_MARKER_RENAME_DELAY_MS below
// if a real project shows it's too short.
var CUE_MARKER_RENAME_DELAY_MS = 150;
var CUE_MARKER_POSITION_EPSILON = 0.0001; // beats (quarter-notes)

function findAndRenamePendingCueMarker(expectedPositionBeats, newName) {
   for (var i = 0; i < CUE_MARKER_SCAN_DEPTH; i++) {
      var marker = cueMarkerBank.getItemAt(i);
      if (Math.abs(marker.position().get() - expectedPositionBeats) < CUE_MARKER_POSITION_EPSILON) {
         marker.name().set(newName);
         return;
      }
   }
   println("SHIFT+HOME cue marker: couldn't find the marker just created at beat " +
      expectedPositionBeats + " to rename it (scanned " + CUE_MARKER_SCAN_DEPTH +
      " markers) - it still exists with Bitwig's default name.");
}

// "Mixer Mode PAGE" (notes 82/83, MODE_MIXER only - Device mode's own
// paging behavior at the same notes is untouched, see case 82/83 below)
// - requested directly: jump the playhead to the next/previous cue
// marker AND move the arranger loop to follow it, for quickly hopping
// between song sections and looping just the one currently being worked
// on. Scans cueMarkerBank directly (rather than transport.
// jumpToNext/PreviousCueMarker(), which would then need a readback to
// know WHERE it landed) so the target position is already known
// synchronously, with no read-after-jump timing to worry about - unlike
// SHIFT+HOME's marker creation above, there's no "wait for the bank to
// catch up" step needed here at all in the common case.
//
// Finds the marker with the smallest position strictly after
// currentPos (forward) or the largest position strictly before it
// (backward) - i.e. the same "closest adjacent marker" semantics as
// Bitwig's own jump-to-next/previous-marker actions. Returns null if
// none exists in that direction within CUE_MARKER_SCAN_DEPTH.
function findAdjacentMarkerPosition(currentPos, forward) {
   var bestPosition = null;
   for (var i = 0; i < CUE_MARKER_SCAN_DEPTH; i++) {
      var marker = cueMarkerBank.getItemAt(i);
      if (!marker.exists().get()) {
         continue;
      }
      var pos = marker.position().get();
      if (forward) {
         if (pos > currentPos + CUE_MARKER_POSITION_EPSILON &&
            (bestPosition === null || pos < bestPosition)) {
            bestPosition = pos;
         }
      } else {
         if (pos < currentPos - CUE_MARKER_POSITION_EPSILON &&
            (bestPosition === null || pos > bestPosition)) {
            bestPosition = pos;
         }
      }
   }
   return bestPosition;
}

// Finishes the Mixer Mode PAGE gesture once both the target marker's
// position AND the loop's end position are known - moves the playhead
// and sets the loop in one go. Shared by the fast path (loop end is
// either the next marker after the target, or the target position plus
// the existing loop length - both already known synchronously) and the
// jump_to_end_of_arrangement fallback path (which needs a
// host.scheduleTask() first - see jumpToMarkerAndSetLoop() below).
function finishMixerPageJump(targetPosition, loopEndPosition, popupText) {
   setTransportPosition(targetPosition);
   transport.arrangerLoopStart().set(targetPosition);
   transport.arrangerLoopDuration().set(Math.max(0.0625, loopEndPosition - targetPosition));
   host.showPopupNotification(popupText);
}

function jumpToMarkerAndSetLoop(forward) {
   var currentPos = transport.getPosition().get();
   var targetPosition = findAdjacentMarkerPosition(currentPos, forward);
   if (targetPosition === null) {
      host.showPopupNotification(forward ? "No Next Cue Marker" : "No Previous Cue Marker");
      return;
   }

   if (mixerPageLoopBehavior === "Keep Loop Length") {
      var currentLoopLength = transport.arrangerLoopDuration().get();
      finishMixerPageJump(targetPosition, targetPosition + currentLoopLength,
         "Jump to Marker (Loop Kept)");
      return;
   }

   // "Loop Between Markers" - loop end is the NEXT marker after the
   // target, chronologically, regardless of which direction we just
   // navigated (looping "this section" always means target-to-next, not
   // target-to-wherever-we-came-from).
   var nextMarkerAfterTarget = findAdjacentMarkerPosition(targetPosition, true);
   if (nextMarkerAfterTarget !== null) {
      finishMixerPageJump(targetPosition, nextMarkerAfterTarget, "Jump to Marker (Loop to Next Marker)");
      return;
   }

   // Target is the LAST marker - no next marker to loop up to. Bitwig
   // has no direct Controller API query for "end of arrangement content"
   // (no equivalent of scanning every track's longest clip), only the
   // jump_to_end_of_arrangement ACTION - which moves the playhead as a
   // side effect, so this reads the result back via a short
   // host.scheduleTask() (same reasoning as findAndRenamePendingCueMarker()
   // above: not guaranteed to be reflected in the same tick) and then
   // moves the playhead to the actual target marker afterward, since
   // landing at the end of the arrangement was never the point - not yet
   // confirmed on hardware.
   safeInvokeAction("jump_to_end_of_arrangement", null);
   host.scheduleTask(function () {
      var arrangementEnd = transport.getPosition().get();
      finishMixerPageJump(targetPosition, Math.max(arrangementEnd, targetPosition + getBeatsPerBar()),
         "Jump to Marker (Loop to End of Arrangement)");
   }, CUE_MARKER_RENAME_DELAY_MS);
}

// For every track in `bank`, scans the first TOOL_DEVICE_SCAN_DEPTH devices
// in its chain for one named TOOL_DEVICE_NAME, tracking which position (if any) it's
// currently at in `toolSlotState[trackIndex]`, and eagerly creating a
// 2-parameter (assumed Gain, Pan) remote-controls page for every scanned
// position in `toolRemoteState[trackIndex]` so getToolParam() can just index
// into it once the matching slot is known.
// Scans `track`'s device chain (first TOOL_DEVICE_SCAN_DEPTH devices) for
// one named TOOL_DEVICE_NAME. Calls onSlotFound(deviceIndex) once a scanned
// position's device is (re)named to match, onSlotLost(deviceIndex) once a
// previously-matching position's device is renamed away or replaced.
// Returns the per-position remote-controls page array so callers can look
// up parameters once they know which position matched.
function scanTrackForToolDevice(track, onSlotFound, onSlotLost) {
   var deviceBank = track.createDeviceBank(TOOL_DEVICE_SCAN_DEPTH);
   var remotesForTrack = [];

   for (var d = 0; d < TOOL_DEVICE_SCAN_DEPTH; d++) {
      (function (deviceIndex) {
         var device = deviceBank.getItemAt(deviceIndex);
         var remote = device.createCursorRemoteControlsPage(2);
         remotesForTrack[deviceIndex] = remote;

         // Bitwig only syncs a Value's current state (and allows .get()) if
         // it's been observed or markInterested() was called on it during
         // init - refreshDisplayText() reads name()/displayedValue() on
         // demand rather than observing them, so without this it throws
         // "Either call markInterested() or add at least one observer".
         for (var p = 0; p < 2; p++) {
            var param = remote.getParameter(p);
            param.name().markInterested();
            param.displayedValue().markInterested();
            param.value().markInterested();
            param.discreteValueCount().markInterested();
            param.discreteValueNames().markInterested();
            param.getOrigin().markInterested();
         }

         device.name().addValueObserver(function (name) {
            if (name === TOOL_DEVICE_NAME) {
               onSlotFound(deviceIndex);
            } else {
               onSlotLost(deviceIndex);
            }
         });
      })(d);
   }

   return remotesForTrack;
}

// tracks is a plain array of 8 Track-like objects - see
// setupChannelStripObservers() above for why (mainTrackCursors for Main,
// bankToTrackArray(effectTrackBank) for Returns).
function setupToolDeviceTracking(tracks, toolSlotState, toolRemoteState) {
   for (var i = 0; i < 8; i++) {
      (function (trackIndex) {
         toolSlotState[trackIndex] = -1;
         toolRemoteState[trackIndex] = scanTrackForToolDevice(
            tracks[trackIndex],
            function (deviceIndex) {
               toolSlotState[trackIndex] = deviceIndex;
               refreshToolModeIfActive();
            },
            function (deviceIndex) {
               if (toolSlotState[trackIndex] === deviceIndex) {
                  toolSlotState[trackIndex] = -1;
                  refreshToolModeIfActive();
               }
            }
         );
      })(i);
   }
}

// scanTrackForToolDevice()'s onSlotFound/onSlotLost callbacks only update
// the tracking arrays - they don't touch the LCD/fader caches themselves.
// Without this, adding (or removing) a TOOL_DEVICE_NAME device while PAN
// mode is already active leaves the LCD showing its last cached text (e.g.
// "No TRLVL") until something unrelated happens to trigger a refresh, even
// though the fader/encoder already work since those read live state.
function refreshToolModeIfActive() {
   if (currentMode === MODE_MIXER && isToolVolumeMode) {
      refreshDisplayText();
      rebindFaders();
   }
}

// The velocity channel `index`'s SELECT LED (note 24+index) should
// currently be sent - normally just plain on/off from ledState.select[index]
// (is this the selected track), but a track that's armed for recording
// breathes through ARMED_LED_BLINK_VELOCITIES there instead (see "Blink
// Armed Track's SELECT LED" Controller Preferences settings below),
// regardless of whether it's also the selected track - so the SELECT row
// doubles as an always-visible "which tracks are armed" overview, not
// just current selection. armedLedBlinkPhase is a single shared step
// index (see armedLedBlinkTick() below) so every armed channel breathes
// in sync with every other one.
function selectLedVelocityFor(index, ledState) {
   if (armedLedBlinkEnabled && ledState.arm[index]) {
      return ARMED_LED_BLINK_VELOCITIES[armedLedBlinkPhase];
   }
   return ledState.select[index] ? 127 : 0;
}

// Re-sends the cached Arm/Solo/Mute/Select LED state for whichever bank is
// currently active - used after toggling RETURNS so the hardware LEDs catch
// up to the bank that's now actually mapped to the 8 channel strips.
function refreshChannelStripLEDs() {
   var ledState = activeLedState();
   for (var i = 0; i < 8; i++) {
      midiOut.sendMidi(0x90, 0 + i, ledState.arm[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 8 + i, ledState.solo[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 16 + i, ledState.mute[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 24 + i, selectLedVelocityFor(i, ledState));
   }
}

// Self-rescheduling loop (same pattern as displayFlushTask() below,
// started once from init()) - advances armedLedBlinkPhase through the
// 4-step bright/dim/off/dim cycle and re-sends the SELECT LED for every
// currently-armed channel on the active bank, so they breathe in place
// without needing any user input. Keeps rescheduling itself even while
// armedLedBlinkEnabled is off, so toggling the setting back on picks up
// immediately with no reload - just does nothing on each tick while off,
// and refreshChannelStripLEDs()'s own live-updating setting observer (see
// init()) restores solid LEDs immediately the moment it's turned off,
// rather than leaving a channel stuck showing whatever step it was on.
function armedLedBlinkTick() {
   if (armedLedBlinkEnabled) {
      armedLedBlinkPhase = (armedLedBlinkPhase + 1) % ARMED_LED_BLINK_VELOCITIES.length;
      var ledState = activeLedState();
      for (var i = 0; i < 8; i++) {
         if (ledState.arm[i]) {
            midiOut.sendMidi(0x90, 24 + i, ARMED_LED_BLINK_VELOCITIES[armedLedBlinkPhase]);
         }
      }
   }
   host.scheduleTask(armedLedBlinkTick, ARMED_LED_BLINK_INTERVAL_MS);
}

// Scheduled task for LCD Display Refresh (throttled to avoid MIDI flooding)
function displayFlushTask() {
   if (displayNeedsUpdate) {
      renderLCDDisplays();
      displayNeedsUpdate = false;
   }
   host.scheduleTask(displayFlushTask, 100);
}

// Bitwig only invokes flush() (see that function below - it drives
// hwSurface.updateHardware()/updateFaderOutputs()/
// updateVPotRingOutputs()/updateChannelColorOutput()) when a subscribed
// value actually changes; while stopped and otherwise idle, nothing may
// change for a while, so any of those outputs that depend on this
// script's own internal state (rather than a Bitwig value change) could
// go stale until something unrelated happens to trigger the next flush.
// Ported from DrivenByMoss's ModelImpl.flushWorkaround(), which
// documents this as intended Bitwig behavior (not a bug) and works
// around it the same way: force a flush periodically via
// host.requestFlush(). Skipped while playing, since enough flushes
// already happen naturally then (the playhead position alone keeps
// changing every cycle).
function flushWorkaroundTick() {
   if (!transport.isPlaying().get()) {
      host.requestFlush();
   }
   host.scheduleTask(flushWorkaroundTick, 100);
}

// MIDI Input Processing
function onMidi(status, data1, data2) {
   var msgType = status & 0xF0;
   var channel = status & 0x0F;

   // DEBUG: catches any Control Change not otherwise logged below (encoders
   // 16-23 and the jog wheel's CC 60 have their own more specific handling
   // further down) - helps confirm whether an unmapped button really sends
   // nothing, or sends a CC instead of the expected Note-On. Still actively
   // used for verifying remaining button assignments - leave in for now.
   if (msgType === 0xB0 && data1 !== 60 && !(data1 >= 16 && data1 <= 23)) {
      debugLog(DEBUG_RAW_MIDI, "RAW CC received - CC#: " + data1 + ", Value: " + data2);
   }

   // 1. Motorized Pitchbend Faders - handled entirely by the native
   // hwFaders/hwMasterFader hardware bindings (see rebindFaders()), not
   // here. Bitwig reads the incoming pitch-bend and drives the bound
   // parameter (and the physical motor, for any value change regardless of
   // its source) automatically once bound via setBinding().

   // 2. Rotary Encoders (CC 16-23 on Channel 1: 0xB0)
   if (msgType === 0xB0 && data1 >= 16 && data1 <= 23) {
      var encoderIndex = data1 - 16;
      // MCU V-Pot relative encoding is sign-magnitude, NOT two's complement:
      // 1-63 = increment by that amount, 65-127 = decrement by (value - 64)
      var rawDelta = data2 < 64 ? data2 : -(data2 - 64);

      // SHIFT held changes the turn's behavior - see applyEncoderStep()
      // above for the full decision tree (SHIFT vs. SHIFT+Encoder Mode
      // vs. discrete/switch targets vs. acceleration).
      if (isShiftPressed) { shiftUsedForCombo = true; }

      // See getEncoderTarget() below for the exact per-mode/flip rules
      // (encoders always control macros in MODE_DEVICE regardless of
      // FLIP - only the faders swap there; MODE_MIXER's encoder is pan
      // unflipped / volume flipped, the opposite of the fader).
      var encTarget = getEncoderTarget(encoderIndex);
      if (encTarget) {
         applyEncoderStep(encTarget, rawDelta, encoderIndex);
         // Encoder Snap to Origin - see scheduleEncoderSnapCheck() above.
         // Applies to whatever the encoder currently targets, in any mode
         // (pan/volume, a device macro, a send) - skipped only for a
         // genuine discrete/switch target, which has no continuous "close
         // to origin" to land on. Idle-based: this just (re)arms a check
         // for ENCODER_SNAP_IDLE_MS after the LAST tick of this turn, not
         // this specific tick's value.
         if (snapToOriginEnabledForCurrentContext() && encTarget.discreteValueCount().get() <= 0) {
            scheduleEncoderSnapCheck(encoderIndex, encTarget);
         }
      }
      // The bottom LCD row otherwise always shows volume in Mixer mode
      // (see setupChannelStripObservers) - reveal the live pan value
      // instead while actually turning the encoder to adjust pan, since
      // that's the only case where the encoder and the displayed value
      // disagree. See revealPanTemporarily() below.
      if (currentMode === MODE_MIXER && !isFlipped && !isToolVolumeMode) {
         revealPanTemporarily(encoderIndex);
      }
      return;
   }

   // 3. Jog / Scroll Wheel (CC 60 on Channel 1: 0xB0)
   // Default: smooth, un-quantized scrub through the arranger timeline.
   // CTRL held = select next/previous arranger clip/item instead (device
   // stepping in MODE_DEVICE); SHIFT+ALT = nudge the selected item left/
   // right; ALT alone = adjust the last-clicked GUI parameter; SHIFT held
   // = shift the arranger loop by whole bars; holding the wheel down
   // (isWheelPressed, note 101 - see the Jog Wheel Push handler above) =
   // jump the playhead by whole bars instead of scrubbing smoothly.
   // isScrubToggled is currently dead (see its declaration above) - no
   // known hardware SCRUB note exists to set it. See the full
   // priority-ordered writeup in README.md's "Jog wheel modifier combos"
   // section.
   if (msgType === 0xB0 && data1 === 60) {
      // Same sign-magnitude fix as the encoders above
      var backwards = data2 >= 64;
      var rawStep = backwards ? -(data2 - 64) : data2;

      if (currentMode === MODE_SCENE) {
         // BTA / Scene Mode: plain wheel turn moves the selected-scene
         // cursor within the 8-scene bank window (see sceneCursorIndex
         // above) - takes priority over every other modifier combo below,
         // since none of them make sense while browsing scenes. Launching
         // is done separately by note 101's press handler.
         sceneStepAccumulator += Math.abs(rawStep);
         if (sceneStepAccumulator >= SCENE_STEP_MESSAGES) {
            sceneStepAccumulator -= SCENE_STEP_MESSAGES;
            sceneCursorIndex = backwards ?
               Math.max(0, sceneCursorIndex - 1) :
               Math.min(7, sceneCursorIndex + 1);
            var selectedScene = sceneBank.getScene(sceneCursorIndex);
            var selectedSceneName = selectedScene.name().get() || ("Scene " + (sceneCursorIndex + 1));
            host.showPopupNotification("Scene " + (sceneCursorIndex + 1) + ": " + selectedSceneName);
         }
         return;
      }

      if (isControlPressed && isShiftPressed) {
         // SHIFT+CTRL + Jog Wheel: runs whichever action is configured
         // for it (see WHEEL_COMBO_ACTIONS/shiftCtrlWheelAction/
         // performWheelComboAction above) - default "Scale Clip Size".
         // Checked before the plain CTRL branch so it isn't swallowed by
         // it - CTRL alone (step next/previous) still fires normally when
         // SHIFT isn't also held.
         ctrlUsedForCombo = true;
         shiftUsedForCombo = true;
         shiftCtrlWheelAccumulator += Math.abs(rawStep);
         if (shiftCtrlWheelAccumulator >= SHIFT_CTRL_WHEEL_THRESHOLD) {
            shiftCtrlWheelAccumulator -= SHIFT_CTRL_WHEEL_THRESHOLD;
            performWheelComboAction(shiftCtrlWheelAction, backwards);
         }
         return;
      }

      if (isControlPressed && isAltPressed) {
         // ALT+CTRL + Jog Wheel: same mechanism as SHIFT+CTRL above, its
         // own independent action setting (altCtrlWheelAction, default
         // "Duplicate/Delete Track") and its own accumulator - so the two
         // combos can be configured to do either action, in either
         // combination (fully invertible via the two separate Controller
         // Preferences dropdowns, no dedicated "swap" needed). Checked
         // before the plain CTRL branch for the same reason as SHIFT+CTRL.
         ctrlUsedForCombo = true;
         altUsedForCombo = true;
         altCtrlWheelAccumulator += Math.abs(rawStep);
         if (altCtrlWheelAccumulator >= ALT_CTRL_WHEEL_THRESHOLD) {
            altCtrlWheelAccumulator -= ALT_CTRL_WHEEL_THRESHOLD;
            performWheelComboAction(altCtrlWheelAction, backwards);
         }
         return;
      }

      if (isControlPressed) {
         // Using CTRL to modify the wheel means a long-press expanded-view
         // toggle shouldn't also fire when it's released - see the CTRL
         // block above. Checked before the plain ALT/SHIFT+ALT branches
         // below, so CTRL always takes priority over ALT here.
         ctrlUsedForCombo = true;

         if (currentMode === MODE_DEVICE) {
            // CTRL + Jog Wheel in Device mode: step to the next/previous
            // device on the chain, once every PLUGIN_DEVICE_STEP_MESSAGES
            // messages (shares the accumulator with the PLUGIN-held combo -
            // same action, either gesture works).
            pluginDeviceStepAccumulator++;
            if (pluginDeviceStepAccumulator >= PLUGIN_DEVICE_STEP_MESSAGES) {
               pluginDeviceStepAccumulator = 0;
               if (backwards) {
                  cursorDevice.selectPrevious();
               } else {
                  cursorDevice.selectNext();
               }
            }
            return;
         }

         // CTRL + Jog Wheel (outside Device mode): select the next/
         // previous arranger clip/item, via Bitwig's real "Select Next
         // Item"/"Select Previous Item" actions (ids "Select next item"/
         // "Select previous item", confirmed from
         // bitwig-actions-reference.txt) - once every
         // CLIP_SELECT_STEP_MESSAGES messages (its own dedicated,
         // independently configurable threshold - see above). Briefly
         // swapped to "Select item to left"/"Select item to right"
         // (hoping for same-track-only stepping, since these actions
         // don't stay confined to the current track - see below), but
         // reverted after confirming on hardware that those two do
         // nothing at all, even with a clip already selected - same
         // pattern as select_item_at_cursor and Select item above/below
         // (all apparently non-functional when invoked via the Controller
         // API, despite being real, named Bitwig actions). "Select next/
         // previous item" is the only one of this whole family confirmed
         // to actually change the selection on hardware, so it's worth
         // keeping despite its own quirk: once there's no further item in
         // one direction on the current track, it jumps to the next/
         // previous track's item instead of stopping - a working action
         // with an occasional side effect beats a "correct" one that does
         // nothing. Replaces the previous tempo-nudge behavior per
         // request; use SHIFT+ALT + Jog Wheel Press/Turn (see below) to
         // select and then move a clip instead.
         clipSelectStepAccumulator++;
         if (clipSelectStepAccumulator >= CLIP_SELECT_STEP_MESSAGES) {
            clipSelectStepAccumulator = 0;
            safeInvokeAction(backwards ? "Select previous item" : "Select next item", null);
         }
         return;
      }

      if (isShiftPressed && isAltPressed) {
         // SHIFT+ALT + Jog Wheel: nudge whatever's currently selected in
         // the arranger (a clip, automation point, etc - whatever Bitwig's
         // own selection holds, typically set by clicking it) left/right
         // by one grid step per wheel message, via the real "Nudge Events
         // One Step Backward/Forward" actions (ids
         // nudge_events_one_step_earlier/_later, confirmed from
         // bitwig-actions-reference.txt - NOT the similarly-named
         // nudge_events_one_bar_earlier/_later, which despite the "bar" in
         // their id actually map to "Nudge Events Fine/Alternate Amount
         // Backward/Forward", a different and more ambiguous granularity).
         // Click a clip in Bitwig first to select it, then hold SHIFT+ALT
         // and turn the wheel to "drag" it - the visible clip move in
         // Bitwig's own UI is feedback enough, so unlike the plain-ALT
         // combo below this doesn't also show a popup every tick. Checked
         // before the plain-ALT branch so it isn't swallowed by it - ALT
         // alone (mouseover-parameter adjust) still fires normally when
         // SHIFT isn't also held.
         shiftUsedForCombo = true;
         altUsedForCombo = true;
         safeInvokeAction(backwards ? "nudge_events_one_step_earlier" : "nudge_events_one_step_later", null);
         return;
      }

      if (isAltPressed) {
         // ALT + Jog Wheel (CTRL not also held, see above): adjust
         // whatever parameter was last clicked in Bitwig's own GUI
         // (host.createLastClickedParameter(), see lastClickedParam
         // above) - click any knob/slider once in Bitwig, then hold ALT
         // and turn the wheel to dial it in without touching the mouse
         // again. Not true continuous mouseover - Bitwig's Controller API
         // only exposes "last clicked", not live hover position (confirmed
         // against the LastClickedParameter Javadoc) - but functionally
         // close: click once to arm it, then adjust freely. This replaces
         // ALT's old role of halving the default scrub step (see the
         // default branch below, which no longer checks ALT) - was
         // originally SHIFT+OPTION, moved to plain ALT per request. See
         // also note 101's press handler for ALT+wheel-press ("Select item
         // at cursor").
         altUsedForCombo = true;
         lastClickedParamValue.inc(rawStep, 128);
         host.showPopupNotification(lastClickedParamValue.name().get());
         return;
      }

      if (isPluginHeld) {
         // PLUGIN held + Jog Wheel: step to the next/previous device on the
         // selected track, once every PLUGIN_DEVICE_STEP_MESSAGES wheel
         // messages (raw messages arrive far more often than one per
         // physical detent).
         pluginDeviceStepAccumulator++;
         if (pluginDeviceStepAccumulator >= PLUGIN_DEVICE_STEP_MESSAGES) {
            pluginDeviceStepAccumulator = 0;
            if (backwards) {
               cursorDevice.selectPrevious();
            } else {
               cursorDevice.selectNext();
            }
         }
         return;
      }

      if (isBankHeld) {
         // BANK PREV/NEXT held + Jog Wheel: page through the current
         // device's remote-control pages, once every
         // BANK_PAGE_STEP_MESSAGES wheel messages.
         bankPageStepAccumulator++;
         if (bankPageStepAccumulator >= BANK_PAGE_STEP_MESSAGES) {
            bankPageStepAccumulator = 0;
            if (backwards) {
               remoteControls.selectPreviousPage(true);
            } else {
               remoteControls.selectNextPage(true);
            }
         }
         return;
      }

      if (isOptionPressed) {
         // OPTION + Jog Wheel: turn left halves the loop length, turn right
         // doubles it - accumulated across messages, see
         // loopScaleAccumulator above.
         optionUsedForCombo = true;
         loopScaleAccumulator += Math.abs(rawStep);
         if (loopScaleAccumulator >= LOOP_SCALE_THRESHOLD) {
            loopScaleAccumulator -= LOOP_SCALE_THRESHOLD;
            var oldLoopDuration = transport.arrangerLoopDuration().get();
            var newLoopDuration = backwards ? oldLoopDuration / 2.0 : oldLoopDuration * 2.0;
            // Floor at 1 whole bar (not a fixed tiny note value like a
            // 64th note) so repeated halving can't reach zero/negative -
            // requested directly: starting from a non-power-of-2 length
            // (e.g. 3 bars) used to keep halving straight past whole-bar
            // lengths into awkward fractional-bar ones instead of
            // stopping at a clean 1-bar floor. Cap at 256 bars so
            // repeated doubling can't run away forever.
            var loopScaleBeatsPerBar = getBeatsPerBar();
            var maxLoopDuration = 256 * loopScaleBeatsPerBar;
            transport.arrangerLoopDuration().set(Math.max(loopScaleBeatsPerBar, Math.min(maxLoopDuration, newLoopDuration)));
         }
         return;
      }

      if (isShiftPressed) {
         // SHIFT + Jog Wheel: move the whole loop region by one bar per
         // message, keeping its length unchanged.
         shiftUsedForCombo = true;
         var loopBeatsPerBar = getBeatsPerBar();
         var oldLoopStart = transport.arrangerLoopStart().get();
         var newLoopStart = backwards ? oldLoopStart - loopBeatsPerBar : oldLoopStart + loopBeatsPerBar;
         transport.arrangerLoopStart().set(Math.max(0, newLoopStart));
         return;
      }

      if (isScrubToggled || isWheelPressed) {
         // "Pan Mode": jump exactly one bar per wheel message, regardless of
         // how hard it was spun - "increments" of a whole bar, landing
         // precisely on the bar line (incPosition's own snap=true only
         // quantizes to the nearest beat, not the bar, so the target
         // position is computed directly instead). There's no API to pan
         // the arranger's visible timeframe independently of the playhead
         // (confirmed - same limitation as horizontal zoom), so this moves
         // the playhead itself; with Follow Playback on, the visible
         // timeline pans along with it.
         var beatsPerBar = getBeatsPerBar();
         var currentBar = Math.round(transport.getPosition().get() / beatsPerBar);
         var targetBar = backwards ? currentBar - 1 : currentBar + 1;
         setTransportPosition(Math.max(0, targetBar) * beatsPerBar);
         return;
      }

      // Default: jump effectiveWheelScrubBars() whole bars per accumulated
      // WHEEL_SCRUB_TICKS_PER_BAR raw ticks, always landing precisely on a
      // bar start - same "compute the exact target position" approach as
      // the bar-jump (Pan Mode)/loop-shift branches above, generalized to
      // a configurable/adaptive bar count instead of a fixed single bar.
      // Bar-based (not beat-based) and always anchored on the bar grid
      // specifically so it always scrolls bar-to-bar, never landing
      // mid-bar on an individual beat. No longer ALT-modified - ALT
      // alone is now claimed above (mouseover-parameter adjust),
      // unreachable here since it always returns first.
      //
      // Unlike Pan Mode above, this branch cares about how hard the wheel
      // was spun: rawStep's magnitude (ticks batched into this one
      // message) accumulates across messages and only fires a jump once
      // WHEEL_SCRUB_TICKS_PER_BAR is reached, so a fast flick can fire
      // several bar-jumps in one message while a slow turn carries its
      // partial ticks over to the next one instead of losing them.
      wheelScrubAccumulator += rawStep;
      var wheelScrubBeatsPerBar = getBeatsPerBar();
      var wheelScrubBars = effectiveWheelScrubBars();
      while (Math.abs(wheelScrubAccumulator) >= WHEEL_SCRUB_TICKS_PER_BAR) {
         var scrubBackwards = wheelScrubAccumulator < 0;
         wheelScrubAccumulator += scrubBackwards ? WHEEL_SCRUB_TICKS_PER_BAR : -WHEEL_SCRUB_TICKS_PER_BAR;
         var currentBarUnit = Math.round(transport.getPosition().get() / wheelScrubBeatsPerBar);
         var targetBarUnit = scrubBackwards ? currentBarUnit - wheelScrubBars : currentBarUnit + wheelScrubBars;
         setTransportPosition(Math.max(0, targetBarUnit * wheelScrubBeatsPerBar));
      }
      return;
   }

   // 4. Modifier Buttons Press & Release (Note On: 0x90, Note Off: 0x80)
   if (msgType === 0x90 || msgType === 0x80) {
      var isPressed = (msgType === 0x90 && data2 > 0);
      if (isPressed) {
         // Catches modifier buttons too. Optionally includes live
         // modifier/toggle state so a note that varies by what's
         // currently held (reported: the jog wheel's own click reportedly
         // sends different notes depending on modifier state, similar to
         // the already-documented CHANNEL PREV/NEXT wheel-assignment
         // quirk) can be fully characterized from one round of testing
         // instead of many back-and-forth single-note reports. See
         // DEBUG_RAW_MIDI/DEBUG_MODIFIER_STATE above.
         var debugModifierSuffix = DEBUG_MODIFIER_STATE ?
            (" [SHIFT=" + isShiftPressed + " OPTION=" + isOptionPressed +
            " CTRL=" + isControlPressed + " ALT=" + isAltPressed +
            " ZOOM=" + isZoomToggled + " SCRUB=" + isScrubToggled + "]") : "";
         debugLog(DEBUG_RAW_MIDI, "RAW Note-On received - Note: " + data1 + debugModifierSuffix);
      }

      // SHIFT Button (Note 70) - held modifier for other actions (fine
      // encoder adjust, jog wheel loop-shift); standalone tap can be
      // assigned to a Plugin Mode action - see handleModifierTap().
      if (data1 === 70) {
         isShiftPressed = isPressed;
         midiOut.sendMidi(0x90, 70, isShiftPressed ? 127 : 0);
         if (isPressed) { shiftUsedForCombo = false; }
         handleModifierTap(70, isPressed);
         return;
      }

      // OPTION Button (Note 71) - held modifier for the jog wheel's loop
      // halve/double; standalone tap can be assigned to a Plugin Mode
      // action - see handleModifierTap().
      if (data1 === 71) {
         isOptionPressed = isPressed;
         midiOut.sendMidi(0x90, 71, isOptionPressed ? 127 : 0);
         if (isPressed) { optionUsedForCombo = false; }
         handleModifierTap(71, isPressed);
         return;
      }

      // CTRL Button (Note 72) - held modifier for other combos (tempo
      // nudge, CTRL+PUNCH IN/OUT, CTRL+jog device navigation); standalone
      // tap can optionally be assigned to a Plugin Mode action (expanded
      // device view) via the "Expanded Device View Button" Controller
      // Preferences dropdown - see handleModifierTap(). Off by default
      // now (requested directly - CTRL is the most ergonomic modifier and
      // already heavily used for wheel combos; F1-F8 already covers
      // device select + open-window, so a long-press mode-switch on the
      // same button was reported as confusing and prone to firing
      // unintentionally while just trying to use CTRL+wheel).
      if (data1 === 72) {
         isControlPressed = isPressed;
         midiOut.sendMidi(0x90, 72, isControlPressed ? 127 : 0);
         if (isPressed) { ctrlUsedForCombo = false; }
         handleModifierTap(72, isPressed);
         return;
      }

      // ALT Button (Note 73) - held modifier for other actions (tempo
      // nudge fine-grain, jog wheel half-step); standalone tap can be
      // assigned to a Plugin Mode action - see handleModifierTap().
      // Defaults to cycling the selected device's macro bank.
      if (data1 === 73) {
         isAltPressed = isPressed;
         midiOut.sendMidi(0x90, 73, isAltPressed ? 127 : 0);
         if (isPressed) { altUsedForCombo = false; }
         handleModifierTap(73, isPressed);
         return;
      }

      // Jog Wheel Push / Pan Mode (Note 101, not 87 - see isWheelPressed
      // above). Moved here after systematically testing every wheel-
      // assignment button (ZOOM/SCRUB/MARKER/BANK/CHANNEL) with the wheel
      // click: confirmed the click is always note 101, but ONLY fires in
      // the base/idle assignment state - it's silent under ZOOM, MARKER,
      // BANK, and CHANNEL. Note 87 never actually fires at all; wherever
      // that assumption came from, it was wrong from the start. Note 101
      // was ALSO wrongly assumed to be a dedicated "SCRUB Button" (see the
      // removed toggle handler that used to intercept it, below where the
      // BANK/ZOOM toggle handlers still live) - confirmed the real SCRUB
      // control sends no MIDI at all when pressed, so that handler was
      // actually hijacking every wheel click into a spurious fine-scrub
      // toggle instead of ever reaching this code. ALT held + press runs
      // Bitwig's real "Select item at cursor" action (same one the F-key
      // function list offers, see FKEY_FUNCTIONS) - takes priority over
      // the MODE_SCENE scene-launch behavior below, since holding ALT is
      // a deliberate, distinct gesture. Without ALT, in MODE_SCENE a press
      // launches the currently selected scene instead - Pan Mode's
      // bar-jump branch is unreachable in that mode anyway (the wheel
      // handler's MODE_SCENE branch takes priority), so there's no
      // conflict between the two (non-ALT) uses of this note.
      if (data1 === 101) {
         isWheelPressed = isPressed;
         if (isPressed && isAltPressed) {
            // Fires on ALT+press regardless of SHIFT, so this doubles as
            // the "click" step of the SHIFT+ALT clip-drag gesture above -
            // hold SHIFT+ALT, press to select whatever's at the cursor,
            // keep holding and turn to nudge it. If SHIFT happens to be
            // held too, mark it used so its own standalone-tap action
            // (if configured) doesn't also fire on release.
            altUsedForCombo = true;
            if (isShiftPressed) {
               shiftUsedForCombo = true;
            }
            safeInvokeAction("select_item_at_cursor", "Select item at cursor");
         } else if (isPressed && isOptionPressed) {
            // OPTION + press: toggle the ALT+wheel "lock" via
            // LastClickedParameter.smartToggleLock() (see
            // lastClickedParamLocked above) - locks ALT+wheel onto
            // whatever parameter the mouse is currently hovering, no
            // exact click required, and if already locked and the mouse
            // has since moved to a different parameter, re-locks to that
            // one instead of unlocking (Bitwig's own "smart" behavior).
            // Replaces an earlier SHIFT+CTRL/OPTION experiment that tried
            // "Select item below"/"Select item above" here to make clip
            // selection follow a track switch - confirmed on hardware
            // that neither of those two actions does anything at all
            // (same dead end as select_item_at_cursor and "Select item
            // to left/right" - see CTRL+wheel above), so both bindings
            // were retired in favor of this.
            optionUsedForCombo = true;
            lastClickedParam.smartToggleLock();
         } else if (isPressed && currentMode === MODE_SCENE) {
            sceneBank.getScene(sceneCursorIndex).launch();
            host.showPopupNotification("Launch Scene " + (sceneCursorIndex + 1));
         }
         return;
      }

      // PLUG-INS Button (Note 44 - see case 44 below) - track hold state
      // for the jog wheel device navigation combo, but (unlike the pure
      // modifiers above) only `return` on release: a press still needs to
      // fall through to handleButtonPress() below for its own action.
      if (data1 === 44) {
         isPluginHeld = isPressed;
         if (!isPressed) {
            pluginDeviceStepAccumulator = 0;
            return;
         }
      }

      // BANK PREV/NEXT Buttons (Notes 46/47) - track hold state (either
      // one) for the jog wheel device-page navigation combo; same
      // fall-through-on-press pattern as PLUGIN above.
      if (data1 === 46 || data1 === 47) {
         isBankHeld = isPressed;
         if (!isPressed) {
            bankPageStepAccumulator = 0;
            return;
         }
      }

      // ZOOM Button (Note 100) - toggles zoom mode for the cursor arrows
      // (96-99); it is NOT a held modifier in the real protocol.
      if (data1 === 100) {
         if (isPressed) {
            isZoomToggled = !isZoomToggled;
            midiOut.sendMidi(0x90, 100, isZoomToggled ? 127 : 0);
         }
         return;
      }

      // Note 87 - previously (wrongly) assumed to be Jog Wheel Push/Pan
      // Mode; that binding is now at note 101 above, after systematically
      // testing every wheel-assignment button with the wheel click and
      // confirming it's always 101, never 87. Deliberately left unbound
      // until it's confirmed what, if anything, this note actually is -
      // press it (or whatever key/gesture used to send it) and check the
      // console for "RAW Note-On received".
      //
      // Note 101 was ALSO wrongly assumed to be a dedicated "SCRUB
      // Button" here (there used to be a toggle handler on this exact
      // note, hijacking every wheel click into a spurious fine-scrub
      // toggle instead of ever letting it reach the Jog Wheel Push
      // handler above) - confirmed the real SCRUB control sends no MIDI
      // at all when pressed, so there's nothing to rebind it to; the
      // "fine-scrub mode" toggle (isScrubToggled) has no known trigger
      // on this hardware anymore. See README for the full wheel-
      // assignment button investigation (ZOOM/SCRUB/MARKER/BANK/CHANNEL).

      // Fader Touch (Notes 104-111 = channels 1-8, 112 = Master) - the
      // motorized faders send a separate Note-On/Off for touching/
      // releasing the physical cap, independent of the pitch-bend position
      // data the fader itself is driven by (see the top-of-file comment -
      // faders are handled entirely via native hardware-binding, not
      // manual pitch-bend parsing). "Select Channel on Fader Touch"
      // (Mixer category, default on - see selectChannelOnFaderTouch) opts
      // into selecting that channel's track on touch, same call as the
      // SELECT1-8 buttons use (note 24-31 above) - inspired by
      // Mossgraber's DrivenByMoss MCU driver, which offers the identical
      // setting. Master (112) always selects the master track, since the
      // master fader's binding never changes with mode (see hwMasterFader
      // in init()). The 8 channel faders only select a track while in
      // MODE_MIXER - in MODE_SENDS/MODE_DEVICE a fader doesn't correspond
      // to a distinct track per channel (all 8 faders act on the SAME
      // cursor track's sends, or on device macros), so there's nothing
      // sensible to select there. Goes through
      // scheduleSelectChannelOnTouch() (see above) rather than selecting
      // immediately, so riding several faders together can be debounced
      // via "Select Channel on Fader Touch Delay (ms)" instead of the
      // selection flickering through each one as you grab it. Also gated
      // by isFaderTouchLocked() (see above) - a fader other than the one
      // already held can't steal the selection while the held one is
      // still down, whether that other touch is a deliberate second hand
      // or a spurious touch-sense trigger from this hardware.
      if (data1 >= 104 && data1 <= 112) {
         var faderTouchIndex = data1 - 104;
         if (isPressed) {
            if (selectChannelOnFaderTouch) {
               if (isFaderTouchLocked(faderTouchIndex)) {
                  println("Fader touch ignored for selection - channel " +
                     faderTouchIndex + " touched while another fader is still held");
               } else {
                  var touchedTrack = data1 === 112 ? masterTrack :
                     (currentMode === MODE_MIXER && !isMainSlotEmpty(faderTouchIndex) ?
                        activeTrackAt(faderTouchIndex) : null);
                  if (touchedTrack) {
                     scheduleSelectChannelOnTouch(touchedTrack);
                  }
               }
            }
            faderTouchHeld[faderTouchIndex] = true;
         } else {
            faderTouchHeld[faderTouchIndex] = false;
            // Fader Snap to Zero - see scheduleFaderSnapZeroCheck() above.
            // Only arms a check on RELEASE; the check itself re-verifies
            // the fader is still untouched (and still within range) once
            // the delay elapses.
            if (faderSnapToZeroEnabled) {
               scheduleFaderSnapZeroCheck(faderTouchIndex, getFaderSnapZeroTarget(faderTouchIndex));
            }
         }
         return;
      }

      // Encoder Push (Notes 32-39), Device mode only - see
      // deviceEncoderPushBehavior/encoderPushHeld above. Intercepted here
      // (rather than left to fall through to handleButtonPress()/its
      // switch, like Mixer/Sends' own encoder-push-reset case still does)
      // so both press AND release are available for the "Fine
      // Resolution" choice - same reasoning as Fader Touch/F-Keys.
      // Mixer/Sends mode isn't touched at all here - that case still
      // lives in handleButtonPressInner's switch below, firing
      // immediately on press exactly as before.
      if (data1 >= 32 && data1 <= 39 && currentMode === MODE_DEVICE) {
         var pushEncIdx = data1 - 32;
         if (deviceEncoderPushBehavior === "Fine Resolution") {
            encoderPushHeld[pushEncIdx] = isPressed;
         } else if (isPressed && deviceEncoderPushBehavior === "Reset to Default") {
            // Same single-press behavior Mixer mode's own encoder push
            // already uses.
            remoteControls.getParameter(pushEncIdx).reset();
         } else if (isPressed && deviceEncoderPushBehavior === "Open/Close Plugin Window") {
            cursorDevice.isWindowOpen().toggle();
         }
         return;
      }

      // F1-F8 Green State (Notes 62-69) - configurable editing-function
      // keys (see FKEY_FUNCTION_NAMES/invokeFKeyFunction/FKEY_SHORT_NAMES
      // above). Intercepted here (rather than left to fall through to
      // handleButtonPress()/its switch, like case 54-61's orange state
      // still does) so both press AND release are available - see
      // handleFKeyPress()/handleFKeyRelease() above: a normal press still
      // invokes the assigned function immediately and shows a brief
      // popup of just that one action, same as any other one-shot LCD
      // popup; only an actual HOLD (past FKEY_HOLD_THRESHOLD_MS) escalates
      // to revealing every F-key's assignment across all 8 channels, for
      // learning the whole layout without a manual - not on every tap.
      if (data1 >= 62 && data1 <= 69) {
         var fkeyIdx = data1 - 62;
         if (isPressed) {
            handleFKeyPress(fkeyIdx);
         } else {
            handleFKeyRelease(fkeyIdx);
         }
         return;
      }

      // Standard Button Press Handling
      if (isPressed) {
         handleButtonPress(data1);
      }
   }
}

// Button Processing (standard MCU note map - see the file header)
// Wraps the real handler so one throwing button handler can't silently
// break every subsequent button press (Bitwig doesn't surface uncaught
// exceptions from this callback to the console on its own).
function handleButtonPress(note) {
   try {
      handleButtonPressInner(note);
   } catch (e) {
      println("EXCEPTION in handleButtonPress (note " + note + "): " + e);
   }
}

function handleButtonPressInner(note) {
   debugLog(DEBUG_BUTTON_DISPATCH, "Button pressed - Note: " + note);
   // Track Channel Strip Buttons (0 - 31) - always act on whichever bank
   // (main tracks or returns) is currently active.
   if (note >= 0 && note <= 7) {
      // Rec Arm 1-8
      if (isMainSlotEmpty(note)) { return; }
      activeTrackAt(note).arm().toggle();
      return;
   }
   if (note >= 8 && note <= 15) {
      // Solo 1-8 - .set() instead of .toggle() so the resulting state is
      // known synchronously, for the momentary SOLO/UNSOLO LCD popup (see
      // showBottomRowPopup()).
      var soloIdx = note - 8;
      if (isMainSlotEmpty(soloIdx)) { return; }
      var soloTrack = activeTrackAt(soloIdx);
      var newSoloState = !soloTrack.solo().get();
      soloTrack.solo().set(newSoloState);
      showBottomRowPopup(soloIdx, newSoloState ? "SOLO" : "UNSOLO");
      return;
   }
   if (note >= 16 && note <= 23) {
      // Mute 1-8 - same synchronous-state pattern as Solo above, for the
      // momentary MUTE/UNMUTE LCD popup.
      var muteIdx = note - 16;
      if (isMainSlotEmpty(muteIdx)) { return; }
      var muteTrack = activeTrackAt(muteIdx);
      var newMuteState = !muteTrack.mute().get();
      muteTrack.mute().set(newMuteState);
      showBottomRowPopup(muteIdx, newMuteState ? "MUTE" : "UNMUTE");
      return;
   }
   if (note >= 24 && note <= 31) {
      // Select 1-8 - double-pressing a group track's own SELECT button
      // (within DOUBLE_PRESS_MS) folds/unfolds it instead of re-selecting it.
      var selIdx = note - 24;
      if (isMainSlotEmpty(selIdx)) { return; }
      var selectedTrack = activeTrackAt(selIdx);
      var nowMs = Date.now();
      var isDoublePress = (nowMs - lastSelectPressTime[selIdx]) < DOUBLE_PRESS_MS;
      lastSelectPressTime[selIdx] = nowMs;

      if (isDoublePress && selectedTrack.isGroup().get()) {
         selectedTrack.isGroupExpanded().toggle();
         lastSelectPressTime[selIdx] = 0; // don't let a 3rd quick press toggle again
      } else {
         selectedTrack.selectInMixer();
         selectedTrack.selectInEditor();
         cursorTrack.selectChannel(selectedTrack);
      }
      return;
   }
   if (note >= 32 && note <= 39) {
      // Encoder Push Click (Reset Parameter) - Mixer/Sends only; Device
      // mode's encoder push is fully intercepted earlier (see the note
      // 32-39 block above, alongside Fader Touch/F-Keys) since it needs
      // both press AND release for the "Fine Resolution" choice, so this
      // branch is never reached in MODE_DEVICE.
      var encIdx = note - 32;
      if (currentMode === MODE_MIXER) {
         // Pan only - centers the pan, nothing else. A volume-touching
         // version of this (reset to unity, then an attempted -10dB/0dB
         // target) caused real problems on hardware across several
         // implementations and was reverted; see git history if revisiting
         // a volume-reset feature here.
         if (!isMainSlotEmpty(encIdx)) { activeTrackAt(encIdx).pan().reset(); }
      } else if (currentMode === MODE_SENDS) {
         var resetSendIdx = (sendBankPage * 8) + encIdx;
         cursorTrack.sendBank().getItemAt(resetSendIdx).reset();
      }
      return;
   }

   // MCU / Ableton Live Overlay Assignment & Navigation Buttons
   switch (note) {
      case 40: // TRACK / I/O -> Toggle Track Mixer / Track Inspector I/O Panel.
               // No flashLed() here (unlike before) - note 40 is now a
               // persistent state indicator (see updateModeLEDs()), not a
               // one-off tactile flash; flashing it here would incorrectly
               // turn it off even while legitimately still the active
               // Assignment-row LED.
         if (currentMode === MODE_MIXER || isShiftPressed) {
            if (isShiftPressed) { shiftUsedForCombo = true; }
            safeCall(application, "toggleInspector", "Toggle Track Inspector / I/O Panel");
         } else {
            currentMode = MODE_MIXER;
            sendBankPage = 0;
            isToolVolumeMode = false;
            host.showPopupNotification("Mode: Mixer (Volume / Pan)");
            applyModeChange("MIXER");
         }
         break;

      case 41: // SEND -> Cycles through send pages, then exits back to
               // Mixer - how many pages a normal press cycles through is
               // configurable (see sendBankConfiguredPages/"Send/Return
               // Bank Size" above): "8" toggles straight between Sends
               // 1-8 and Mixer (1 press in, 1 press out), "16" (default)
               // is the older 3-state cycle (1-8 -> 9-16 -> Mixer).
               // SHIFT+SEND is an escape hatch regardless of the
               // configured size - jumps straight into Sends 9-16 from
               // anywhere, so the extra 8 sends stay reachable even with
               // the default cycle set to 8.
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            currentMode = MODE_SENDS;
            sendBankPage = 1;
            isToolVolumeMode = false;
            host.showPopupNotification("Mode: Send Faders (Sends 9 - 16)");
            applyModeChange("SENDS");
         } else if (currentMode !== MODE_SENDS) {
            // Leaving whatever we were in before - Device mode's open
            // plugin window doesn't belong once Sends takes over. Closing
            // it is handled centrally by applyModeChange() itself now
            // (see its doc comment), not here.
            currentMode = MODE_SENDS;
            sendBankPage = 0;
            isToolVolumeMode = false;
            host.showPopupNotification("Mode: Send Faders (Sends 1 - 8)");
            applyModeChange("SENDS");
         } else if (sendBankPage === 0 && sendBankConfiguredPages > 1) {
            sendBankPage = 1;
            host.showPopupNotification("Mode: Send Faders (Sends 9 - 16)");
            applyModeChange(null);
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
            applyModeChange("MIXER");
         }
         break;

      case 42: // PAN -> toggle TOOL_DEVICE_NAME Gain/Pan control (see isToolVolumeMode)
         currentMode = MODE_MIXER;
         sendBankPage = 0;
         isToolVolumeMode = !isToolVolumeMode;
         if (isToolVolumeMode && cursorToolSlot < 0) {
            // Selected track has no TOOL_DEVICE_NAME device yet. Scripts
            // can't silently insert a specific built-in device (Bitwig's
            // insertBitwigDevice() needs a real java.util.UUID, which isn't
            // constructible from a .control.js script) - the closest
            // available thing is popping the browser at the end of its
            // chain so you can add one in a couple of clicks.
            cursorTrack.endOfDeviceChainInsertionPoint().browse();
            host.showPopupNotification("No " + TOOL_DEVICE_NAME + " on selected track - opening browser");
         } else {
            host.showPopupNotification(isToolVolumeMode ? "Faders: " + TOOL_DEVICE_NAME + " Gain / Pan" : "Faders: Track Volume / Pan");
         }
         applyModeChange(null);
         break;

      case 43: // FLIP -> Swap Faders and Encoders. Moved here from note 50
               // after the user reported pressing the overlay's printed
               // FLIP button produces note 43, not 50 (confirmed via
               // console log) - the note-43-is-unlabeled assumption below
               // (inherited from testing done before the overlay was
               // reattached) was wrong. Still need to confirm what, if
               // anything, note 50 does now - see README.
               //
               // FLIP does NOT change currentMode - Plugin/Device mode
               // (and any other active mode) stays active; FLIP is purely
               // an additional axis (level vs macro control on the
               // faders) layered on top of it. The explicit
               // updateModeLEDs() call below is required even though FLIP
               // itself doesn't touch any mode LED: the hardware was
               // observed clearing note 44's (PLUG-INS/Device mode) LED on
               // its own when FLIP is pressed (same kind of hardware-local
               // LED behavior already documented for BANK/CHANNEL, see
               // case 48) - re-sending the mode LEDs re-asserts the
               // correct state regardless of what the firmware did.
         isFlipped = !isFlipped;
         midiOut.sendMidi(0x90, 43, isFlipped ? 127 : 0);
         host.showPopupNotification("Fader Flip: " + (isFlipped ? "ON" : "OFF"));
         updateModeLEDs();
         rebindFaders();
         break;

      case 44: // PLUG-INS -> toggle into Device mode, jumping to the first
               // device on the selected track and opening its panel (does
               // NOT touch the expanded device view - that's CTRL
               // long-press, see the CTRL block in onMidi). Pressing again
               // while already in Device mode exits back to Mixer mode and
               // closes the device panel it opened. Hold + jog wheel steps
               // through devices instead (see isPluginHeld). Moved here
               // from note 43 after confirming via console testing that
               // this hardware's Live overlay prints "PLUG-INS" over note
               // 44, not 43.
               //
               // SHIFT+PLUG-INS = "EQ Mode", requested directly: jumps
               // straight to the LAST device in the chain whose name
               // matches EQ_DEVICE_NAME_KEYWORDS (see
               // findLastEqDeviceIndex() above) instead of the first
               // device overall, for a quick peek-modify-leave workflow.
               // Unlike F1-F8 (case 54-61), pressing it again while that
               // exact EQ is already selected exits back to Mixer mode
               // (same as PLUG-INS' own toggle) rather than just toggling
               // the window - closing the window is then a side effect of
               // applyModeChange() leaving MODE_DEVICE (see
               // previousMode above), not something this branch does
               // itself. A third press jumps straight back to the same
               // EQ, same as the first.
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            var eqDeviceIdx = findLastEqDeviceIndex();
            if (eqDeviceIdx === -1) {
               host.showPopupNotification("EQ Mode: No EQ Found in Chain");
               break;
            }
            if (currentMode === MODE_DEVICE && cursorDevice.position().get() === eqDeviceIdx) {
               currentMode = MODE_MIXER;
               host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
               applyModeChange("MIXER");
               break;
            }
            var wasAlreadyInDeviceModeForEq = currentMode === MODE_DEVICE;
            currentMode = MODE_DEVICE;
            if (!wasAlreadyInDeviceModeForEq) {
               sendBankPage = 0;
               isToolVolumeMode = false;
            }
            cursorDevice.selectDevice(eqDeviceBank.getItemAt(eqDeviceIdx));
            closeOtherDeviceWindowsIfConfigured();
            cursorDevice.isWindowOpen().set(true);
            host.showPopupNotification("EQ: " + eqDeviceNames[eqDeviceIdx]);
            applyModeChange(wasAlreadyInDeviceModeForEq ? null : "PLUGIN");
            break;
         }
         if (currentMode !== MODE_DEVICE) {
            currentMode = MODE_DEVICE;
            sendBankPage = 0;
            isToolVolumeMode = false;
            cursorDevice.selectFirst();
            closeOtherDeviceWindowsIfConfigured();
            cursorDevice.isWindowOpen().set(true);
            host.showPopupNotification("Device: First Plugin");
            applyModeChange("PLUGIN");
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
            applyModeChange("MIXER");
         }
         break;

      case 54: case 55: case 56: case 57: case 58: case 59: case 60: case 61:
         // F1-F8, default/orange-lit state (SMPTE/BEATS switches these to
         // notes 62-69 instead - see the note-53 comment above; that green
         // state isn't bound to anything yet). Select device 1-8 directly
         // on the selected track's device chain, entering Device mode if
         // not already active. Unlike PLUG-INS (case 44) this never toggles
         // back OUT of Device mode - it always lands on the requested
         // device, whether that means entering Device mode fresh or just
         // switching devices while already in it.
         var fkeyDeviceIdx = note - 54;
         var wasAlreadyInDeviceMode = currentMode === MODE_DEVICE;
         // Requested directly: pressing the SAME F-key again, for the
         // device that's already selected, toggles that device's own
         // window open/closed instead of reselecting it - cursorDevice.
         // position() (read live, not tracked separately, so this stays
         // correct even if the selection changed some other way - the
         // mouse in Bitwig itself, PLUG-INS, wheel-stepping) is the
         // source of truth for "already selected", not just "which F-key
         // was last pressed".
         if (wasAlreadyInDeviceMode && cursorDevice.position().get() === fkeyDeviceIdx) {
            cursorDevice.isWindowOpen().toggle();
            break;
         }
         currentMode = MODE_DEVICE;
         if (!wasAlreadyInDeviceMode) {
            sendBankPage = 0;
            isToolVolumeMode = false;
         }
         cursorDevice.selectDevice(cursorDeviceBank.getItemAt(fkeyDeviceIdx));
         // Every F-key press opens that device's own window (not just the
         // first one that enters Device mode), so CLOSE_OTHER_PLUGIN_WINDOWS
         // applies when switching devices via F1-F8 too, not just on entry.
         closeOtherDeviceWindowsIfConfigured();
         cursorDevice.isWindowOpen().set(true);
         host.showPopupNotification("Device " + (fkeyDeviceIdx + 1));
         applyModeChange(wasAlreadyInDeviceMode ? null : "PLUGIN");
         break;

      // F1-F8 green-lit state (notes 62-69) is intercepted earlier in
      // onMidi, before it ever reaches this switch - see the "F1-F8 Green
      // State" block there for why (both press AND release matter for the
      // held-name LCD display, and this switch only ever sees presses).

      case 45: // RETURNS -> swap the 8 channel strips to/from the Return
               // Tracks bank. Moved here from note 51 after the user
               // reported pressing the overlay's printed RETURNS button
               // produces note 45, not 51 (same kind of wrong inherited
               // note-number assumption as the FLIP/note-43 fix above -
               // this was previously the bare/Logic-label "INST" guess,
               // never actually confirmed under this overlay).
               //
               // Always forces a clean MODE_MIXER, same as every other
               // Assignment-row button - jumping here straight from Sends
               // or Device mode used to leave stale state behind (Sends'
               // fader bindings kept pointing at the old target because
               // rebindFaders() was only called when already in Mixer
               // mode) - see applyModeChange().
         currentMode = MODE_MIXER;
         sendBankPage = 0;
         isToolVolumeMode = false;
         isViewingReturns = !isViewingReturns;
         host.showPopupNotification(isViewingReturns ? "Viewing Return Tracks" : "Viewing Tracks");
         applyModeChange(isViewingReturns ? "RETURNS" : "MIXER");
         break;

      case 46: // BANK PREV (<) -> jump to bank 0 with SHIFT, else page back
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            scrollActiveBankToStart();
            host.showPopupNotification("Jump to First Bank");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
         } else {
            scrollActiveBankPageBackward();
            host.showPopupNotification("Track Bank Left");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 47: // BANK NEXT (>) -> jump to last bank with SHIFT, else page forward
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            scrollActiveBankToEnd();
            host.showPopupNotification("Jump to Last Bank");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectNextPage(true);
            host.showPopupNotification("Device Page Next");
         } else {
            scrollActiveBankPageForward();
            host.showPopupNotification("Track Bank Right");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 48: // CHANNEL PREV (<) -> nudge 1 channel back, jump to first with
               // SHIFT, or (with CTRL) select previous device / nudge tempo
               // down. This hardware has its own firmware-level "wheel
               // assignment" for CHANNEL: pressing it lights the button's
               // LED locally (confirmed NOT controllable from here - our
               // note-on/off echo is ignored; the LED only clears when a
               // sibling assignment button like BANK is pressed instead),
               // and while lit, turning the jog wheel sends repeated
               // Note-On 48/49 messages instead of CC 60 - confirmed via
               // the RAW Note-On debug log. So there's no separate "mode"
               // to track in software at all: every 48/49 press, whether a
               // real button tap or a wheel-driven repeat, should just
               // nudge one channel immediately. CTRL is checked here rather
               // than in the jog wheel's CTRL branch for the same reason
               // (see that branch's comment).
         if (isControlPressed) {
            ctrlUsedForCombo = true;
            if (currentMode === MODE_DEVICE) {
               cursorDevice.selectPrevious();
            } else {
               if (isAltPressed) { altUsedForCombo = true; }
               transport.tempo().incRaw(isAltPressed ? -0.1 : -1.0);
            }
         } else if (isShiftPressed) {
            shiftUsedForCombo = true;
            scrollActiveBankToStart();
            host.showPopupNotification("Jump to First Channel");
         } else {
            scrollActiveBankStepBackward();
            host.showPopupNotification("Nudge Channel Left");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 49: // CHANNEL NEXT (>) -> nudge 1 channel forward, jump to last
               // with SHIFT, or (with CTRL) select next device / nudge tempo
               // up - see case 48 above for why this is a plain one-shot
               // nudge rather than a tracked mode.
         if (isControlPressed) {
            ctrlUsedForCombo = true;
            if (currentMode === MODE_DEVICE) {
               cursorDevice.selectNext();
            } else {
               if (isAltPressed) { altUsedForCombo = true; }
               transport.tempo().incRaw(isAltPressed ? 0.1 : 1.0);
            }
         } else if (isShiftPressed) {
            shiftUsedForCombo = true;
            scrollActiveBankToEnd();
            host.showPopupNotification("Jump to Last Channel");
         } else {
            scrollActiveBankStepForward();
            host.showPopupNotification("Nudge Channel Right");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 50: // UNDO -> Moved here from note 76 after the user reported
               // pressing the overlay's printed UNDO button produces note
               // 50, not 76 (confirmed via console log) - same kind of
               // wrong inherited note-number assumption as the FLIP/
               // note-43 and RETURNS/note-45 fixes above. Still need to
               // confirm what, if anything, note 76 does now - see README.
         application.undo();
         host.showPopupNotification("Undo");
         break;

      case 51: // REDO -> Moved here from note 79, same reasoning as UNDO/
               // note 50 above - confirmed via console log. Still need to
               // confirm what, if anything, note 79 does now - see README.
         application.redo();
         host.showPopupNotification("Redo");
         break;

      // Note 52 is the generic MCU "Name/Value display" toggle - no
      // meaningful equivalent surfaced in Bitwig's API, left unbound.

      // Note 53 (SMPTE/BEATS) is a pure mode key, deliberately left
      // unbound here: pressing it toggles the F1-F8 row's backlight
      // between red (default/"orange") and green entirely in the
      // hardware's own firmware (confirmed - the button itself sends note
      // 53 but that's not acted on), and which of two note ranges F1-F8
      // sends: red = 54-61 (bound below - direct device select), green =
      // 62-69 (confirmed via console testing - see README; not yet bound
      // to anything). Do not bind anything to note 53 itself.

      case 74: // SESS/ARR -> Toggle Clip Launcher / Arranger View
         arranger.isClipLauncherVisible().toggle();
         host.showPopupNotification("Toggle Session / Arranger View");
         break;

      case 75: // CLIP/FX -> Toggle Device / Clip View (confirmed note via debug log)
         safeCall(application, "toggleDevices", "Toggle Device / Clip View");
         break;

      case 76: // DRAW -> Moved here from note 81 after the user reported
               // pressing the overlay's printed DRAW button produces note
               // 76, not 81 (confirmed via console log) - same kind of
               // wrong inherited note-number assumption as the FLIP/
               // RETURNS/UNDO/REDO fixes above. Cycles through the 6
               // arranger edit tools, one per press (Pointer -> Time
               // Selection -> Pencil -> Spray Can -> Eraser -> Knife ->
               // back to Pointer) - see ARRANGER_TOOL_ACTIONS above.
               // SHIFT+DRAW toggles Arranger Automation Write instead
               // (transport.isArrangerAutomationWriteEnabled() - a real
               // SettableBooleanValue, same call this hardware used for
               // Automation Write when it was briefly bound to SMPTE/BEATS
               // earlier this session, before that was repurposed as a
               // pure hardware-local mode key).
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            // Resulting state, not "toggled" - computed before toggling
            // (rather than reading it back after) since that's guaranteed
            // correct regardless of whether the value updates synchronously.
            var newAutomationWriteState = !transport.isArrangerAutomationWriteEnabled().get();
            transport.isArrangerAutomationWriteEnabled().toggle();
            host.showPopupNotification("Automation Write: " + (newAutomationWriteState ? "ENABLED" : "DISABLED"));
         } else {
            var nextTool = ARRANGER_TOOL_ACTIONS[arrangerToolCycleIndex];
            safeInvokeAction(nextTool.id, nextTool.name);
            arrangerToolCycleIndex = (arrangerToolCycleIndex + 1) % ARRANGER_TOOL_ACTIONS.length;
         }
         break;

      case 77: // BROWSER -> Hide/Show Browser
         safeCall(application, "toggleBrowserVisibility", "Toggle Browser");
         break;

      case 78: // DETAIL -> Hide/Show Detail View
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            safeCall(application, "toggleAutomationEditor", "Toggle Automation Editor Panel");
         } else {
            safeCall(application, "toggleNoteEditor", "Toggle Detail Editor Panel");
         }
         break;

      case 79: // B.T.A. -> Moved here from note 80 after the user reported
               // pressing the overlay's printed B.T.A. button produces note
               // 79, not 80 (confirmed via console log) - same kind of
               // wrong inherited note-number assumption as the fixes
               // above. Repurposed as MODE_SCENE toggle ("Scene Mode"):
               // shows the clip launcher + switches to the Mix panel layout,
               // and the jog wheel selects/launches scenes instead of its
               // usual transport scrub (see the jog wheel handler and note
               // 87's press handler). Second press exits back to Mixer mode
               // AND back to the Arrange panel layout, same toggle pattern
               // as PLUGIN/SEND.
         if (currentMode !== MODE_SCENE) {
            currentMode = MODE_SCENE;
            sendBankPage = 0;
            isToolVolumeMode = false;
            sceneCursorIndex = 0;
            sceneStepAccumulator = 0;
            arranger.isClipLauncherVisible().set(true);
            try {
               application.setPanelLayout("MIX");
            } catch (e) {
               println("Error setting panel layout to MIX: " + e);
            }
            host.showPopupNotification("Mode: Scene Launch");
         } else {
            currentMode = MODE_MIXER;
            arranger.isClipLauncherVisible().set(false);
            try {
               application.setPanelLayout("ARRANGE");
            } catch (e) {
               println("Error setting panel layout to ARRANGE: " + e);
            }
            host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
         }
         applyModeChange(null);
         break;

      // Note 80 - B.T.A. was previously (wrongly) assumed to be here;
      // moved to note 79 above after console-log confirmation. Deliberately
      // left unbound until it's confirmed what, if anything, this button
      // actually does under the current overlay - press it and check the
      // console for "RAW Note-On received".

      // Note 81 - DRAW was previously (wrongly) assumed to be here; moved
      // to note 76 above after console-log confirmation. Deliberately left
      // unbound until it's confirmed what, if anything, this button
      // actually does under the current overlay - press it and check the
      // console for "RAW Note-On received".

      case 82: // Printed "PAGE (left arrow)" under the Ableton overlay, not
               // "MARKER" as previously assumed - confirmed via the
               // console (RAW Note-On 82) after the user reported these
               // two buttons are physically labeled PAGE on their unit.
               // Pages the device's remote-control (macro) banks backward
               // in Plugin/Device mode - the actual "page through the
               // plugin encoder banks" gesture these buttons are printed
               // for, matching BANK PREV's own MODE_DEVICE behavior (see
               // case 46 above). No-op outside Device mode - unlike BANK
               // PREV/NEXT, these aren't shared with track-bank paging,
               // since that already has its own dedicated buttons. Adding
               // a cue marker at the playhead (this note's previous
               // binding) moved to the F1-F8 configurable function list
               // instead - see "Add Cue Marker at Playhead" in
               // FKEY_FUNCTIONS. In Mixer mode, requested directly: jumps
               // the playhead to the previous cue marker and moves the
               // arranger loop to follow it (see "Mixer Mode PAGE: Loop
               // Behavior" and jumpToMarkerAndSetLoop() above).
         if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
            refreshDisplayText();
            rebindFaders();
         } else if (currentMode === MODE_MIXER) {
            jumpToMarkerAndSetLoop(false);
         }
         break;

      case 83: // Printed "PAGE (right arrow)" under the Ableton overlay -
               // see case 82 above. Toggling playback follow (this note's
               // previous binding, along with SHIFT+83's metronome toggle)
               // moved to the F1-F8 configurable function list instead -
               // see "Toggle Follow Playhead" in FKEY_FUNCTIONS. The
               // metronome toggle doesn't have a new home yet; ask if it's
               // wanted back somewhere. In Mixer mode, requested directly:
               // jumps the playhead to the next cue marker and moves the
               // arranger loop to follow it - see case 82 above.
         if (currentMode === MODE_DEVICE) {
            remoteControls.selectNextPage(true);
            host.showPopupNotification("Device Page Next");
            refreshDisplayText();
            rebindFaders();
         } else if (currentMode === MODE_MIXER) {
            jumpToMarkerAndSetLoop(true);
         }
         break;

      case 84: // Jump to Previous Cue Marker
         transport.jumpToPreviousCueMarker();
         host.showPopupNotification("Jump to Previous Cue Marker");
         break;

      case 85: // Jump to Next Cue Marker
         transport.jumpToNextCueMarker();
         host.showPopupNotification("Jump to Next Cue Marker");
         break;

      case 86: // LOOP
         transport.isArrangerLoopEnabled().toggle();
         break;

      // Note 87 (jog wheel push / Pan Mode) is fully handled in onMidi's
      // modifier-button section, not here - see isWheelPressed above.

      case 88: // PUNCH OUT (CTRL+PO: set loop end from playhead)
         if (isControlPressed) {
            ctrlUsedForCombo = true;
            var loopStart = transport.arrangerLoopStart().get();
            var curPos = transport.getPosition().get();
            if (curPos > loopStart) {
               transport.arrangerLoopDuration().set(curPos - loopStart);
            }
            host.showPopupNotification("Set Loop End from Playhead");
         } else {
            transport.isPunchOutEnabled().toggle();
            host.showPopupNotification("Toggle Punch-Out Recording");
         }
         break;

      case 89: // HOME -> Jump Playhead to Beginning of Project (1.1.1).
               // SHIFT+HOME instead adds a cue marker at the current
               // playhead position, auto-named "Bar N" for whichever bar
               // it's actually placed at - requested directly, for
               // quickly dropping named markers while working through a
               // song without touching the mouse or typing a name.
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            // getFormatted(positionFormatter) yields e.g. "003:02:03:045"
            // (Bars:Beats:Subdivision:Ticks - see updateSegmentDisplay()
            // below for the same formatter already used for the segment
            // display) - the bar number is just its first field.
            var barNumber = parseInt(
               transport.getPosition().getFormatted(positionFormatter).split(":")[0], 10);
            var markerBeatPosition = transport.getPosition().get();
            transport.addCueMarkerAtPlaybackPosition();
            (function (expectedPositionBeats, markerName) {
               host.scheduleTask(function () {
                  findAndRenamePendingCueMarker(expectedPositionBeats, markerName);
               }, CUE_MARKER_RENAME_DELAY_MS);
            })(markerBeatPosition, "Bar " + barNumber);
            host.showPopupNotification("Cue Marker: Bar " + barNumber);
            break;
         }
         setTransportPosition(0);
         host.showPopupNotification("Jump to Start (Home)");
         break;

      case 90: // END -> Jump Playhead to the current loop start
         setTransportPosition(transport.arrangerLoopStart().get());
         host.showPopupNotification("Jump to Loop Start");
         break;

      // Cursor Arrows (96-99): navigate normally, or zoom while ZOOM (100)
      // is toggled on - matches Ableton's Transport.__on_cursor_*_pressed()
      // pattern (zoom vs scroll depending on the zoom-toggle state).
      // Notes corrected on hardware: 96/97 are actually UP/DOWN, 98/99 are
      // actually LEFT/RIGHT - the reverse of what an earlier round
      // assumed from the printed labels alone.
      case 96: // UP ARROW
         if (isZoomToggled) {
            safeCall(arranger, "zoomInLaneHeightsSelected", "Zoom In (Track Height)");
         } else {
            safeCall(application, "arrowKeyUp");
         }
         break;

      case 97: // DOWN ARROW
         if (isZoomToggled) {
            safeCall(arranger, "zoomOutLaneHeightsSelected", "Zoom Out (Track Height)");
         } else {
            safeCall(application, "arrowKeyDown");
         }
         break;

      case 98: // LEFT ARROW
         if (currentMode === MODE_DEVICE) {
            // Plugin mode: LEFT/RIGHT select the previous/next device on
            // the current chain, same target as the PLUGIN/CTRL+jog combos.
            cursorDevice.selectPrevious();
         } else if (isZoomToggled) {
            // Zoom OUT (see ZOOM_ARROW_STEP above) - application.zoomIn()/
            // zoomOut() fired without error but never actually changed
            // the arranger's horizontal zoom (confirmed on hardware,
            // arranger focused); arrangerHorizontalScrollbar.
            // zoomAtPosition() is the real, confirmed-working call.
            arrangerHorizontalScrollbar.zoomAtPosition(transport.getPosition().get(), ZOOM_ARROW_STEP);
            host.showPopupNotification("Zoom Out (Timeline)");
         } else {
            safeCall(application, "arrowKeyLeft");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 99: // RIGHT ARROW
         if (currentMode === MODE_DEVICE) {
            cursorDevice.selectNext();
         } else if (isZoomToggled) {
            // Zoom IN - see case 98 above.
            arrangerHorizontalScrollbar.zoomAtPosition(transport.getPosition().get(), -ZOOM_ARROW_STEP);
            host.showPopupNotification("Zoom In (Timeline)");
         } else {
            safeCall(application, "arrowKeyRight");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      // Transport Buttons
      case 91: // REWIND
         if (currentMode === MODE_DEVICE) {
            // Plugin mode: same device-select target as PLUGIN/CTRL-held
            // jog and the LEFT/RIGHT arrow buttons above.
            cursorDevice.selectPrevious();
         } else {
            transport.rewind();
         }
         break;
      case 92: // FAST FORWARD
         if (currentMode === MODE_DEVICE) {
            cursorDevice.selectNext();
         } else {
            transport.fastForward();
         }
         break;
      case 93: // STOP
         transport.stop();
         break;
      case 94: // PLAY
         transport.play();
         break;
      case 95: // RECORD
         transport.record();
         break;
   }
}

// Update Mode Assignment LEDs. The Assignment row (TRACK/IO=40, SEND=41,
// PAN=42, PLUG-INS=44, RETURNS=45 - confirmed via testing that pressing
// SEND clears a stuck RETURNS LED too) is hardware-managed as a
// mutually-exclusive group - confirmed our own note-off is ignored while
// nothing else changes. TRACK/IO (40) is the persistent default/"Mixer,
// nothing special assigned" indicator. RETURNS only visibly affects
// anything while currentMode is MIXER (see case 45), so it only takes
// priority here in that case too - otherwise whichever of SENDS/DEVICE is
// active wins, as before.
//
// Sending "on" for the new note alone was confirmed reliable when the
// new note is 41 (SEND) - it correctly cleared a stuck 44 or 45. But
// lighting 40 (TRACK/IO) alone was confirmed NOT to clear a stuck 45
// (RETURNS pressed a 2nd time correctly reverts isViewingReturns/
// currentMode internally, but the note-45 LED itself stayed lit) - so
// this hardware's assignment group evidently doesn't treat every member
// as equally capable of clearing its siblings. Since we can't fully
// reverse-engineer which notes have that power, this now also sends an
// explicit note-off for whichever note we lit last (tracked in
// lastAssignmentNote) before lighting the new one - cheap, can't make
// things worse, and gives the hardware the best chance of actually
// clearing it regardless of which "clearing" mechanism it's using
// internally.
function updateModeLEDs() {
   var assignmentNote = 40;
   if (currentMode === MODE_SENDS) {
      assignmentNote = 41;
   } else if (isToolVolumeMode) {
      assignmentNote = 42;
   } else if (currentMode === MODE_DEVICE) {
      assignmentNote = 44;
   } else if (currentMode === MODE_MIXER && isViewingReturns) {
      assignmentNote = 45;
   }
   if (assignmentNote !== lastAssignmentNote) {
      midiOut.sendMidi(0x80, lastAssignmentNote, 0);
   }
   midiOut.sendMidi(0x90, assignmentNote, 127);
   lastAssignmentNote = assignmentNote;
   midiOut.sendMidi(0x90, 80, currentMode === MODE_SCENE ? 127 : 0); // B.T.A. LED - not confirmed part of the same matrix
}

// Single choke point for "we just changed which mode/assignment is
// active" - every Assignment-row button (SEND/PAN/PLUG-INS/RETURNS) and
// the F1-F8 device-select case call this exactly once, right after fully
// updating currentMode/isToolVolumeMode/isViewingReturns/sendBankPage and
// any device-selection side effects, instead of each hand-rolling its own
// updateModeLEDs()/refreshDisplayText()/rebindFaders() sequence.
// Previously some paths (e.g. RETURNS pressed while already in Sends
// mode) updated state and the channel-strip LEDs immediately but skipped
// rebindFaders() entirely, because it was gated on "only if currentMode
// is already MIXER" - leaving the faders silently still bound to the OLD
// assignment for as long as you stayed in that mode (reported as faders
// "jumping"/moving out of sync with what's actually selected). Routing
// every mode change through here guarantees the LEDs, display text,
// channel-strip LEDs, and fader/encoder bindings are always resynced
// together in one place - so there's never a in-between state where they
// disagree about what's currently active.
//
// Also the single place that closes the plugin window on leaving
// MODE_DEVICE, via previousMode (tracks currentMode as of the last call
// here). This replaced the same `if (currentMode === MODE_DEVICE) {
// cursorDevice.isWindowOpen().set(false); }` check duplicated by hand at
// every individual mode-changing button (TRACK/IO, SEND, PAN, RETURNS,
// B.T.A., PLUG-INS) right before reassigning currentMode - reported as
// not reliably closing the window on every path, and centralizing here
// removes any chance of a future mode-changing button forgetting the
// check the way the per-site duplication always risked (the exact
// failure mode rebindFaders() had before this same choke point was
// introduced for it).
function applyModeChange(popupText) {
   if (previousMode === MODE_DEVICE && currentMode !== MODE_DEVICE) {
      cursorDevice.isWindowOpen().set(false);
   }
   previousMode = currentMode;
   updateModeLEDs();
   refreshDisplayText();
   refreshChannelStripLEDs();
   rebindFaders();
   if (popupText) {
      showModePopup(popupText);
   }
}

// Fire-and-forget LED flash for actions with no real on/off state to
// reflect back (e.g. I/O's Inspector-panel toggle: Bitwig's Controller API
// exposes application.toggleInspector() but no matching "is it visible"
// getter, so the LED can't honestly track real panel state). Lights the
// LED, then turns it off again after durationMs as tactile "press
// registered" feedback instead.
function flashLed(note, durationMs) {
   midiOut.sendMidi(0x90, note, 127);
   host.scheduleTask(function () {
      midiOut.sendMidi(0x90, note, 0);
   }, durationMs);
}

// Returns whichever Parameter fader `i` (0-7) should currently control,
// depending on mode/flip/tool state - shared by rebindFaders() (input side)
// and updateFaderOutputs() (output side) below so the two can never
// disagree about which parameter is "the" target for a given fader.
function getFaderTarget(i) {
   if (currentMode === MODE_SENDS) {
      var sendIdx = (sendBankPage * 8) + i;
      return cursorTrack.sendBank().getItemAt(sendIdx);
   }
   // Hide mode: no activated track left to fill this slot - nothing to
   // bind (see isMainSlotEmpty() above; rebindFaders() already treats a
   // null target as "clear this binding", same as the existing
   // isToolVolumeMode "no TOOL_DEVICE_NAME found" case below).
   if (currentMode === MODE_MIXER && isMainSlotEmpty(i)) {
      return null;
   }
   if (!isFlipped) {
      if (currentMode === MODE_MIXER && isToolVolumeMode) {
         return getToolParam(i, 0);
      }
      return activeTrackAt(i).volume();
   }
   if (currentMode === MODE_DEVICE) {
      return remoteControls.getParameter(i);
   }
   if (isToolVolumeMode) {
      return getToolParam(i, 1);
   }
   return activeTrackAt(i).pan();
}

// Same as getFaderTarget(), except also covers the master fader (index 8,
// notes 104-112's 9th slot) - which getFaderTarget() itself doesn't handle
// since it's always bound straight to masterTrack.volume() regardless of
// mode/FLIP (see hwMasterFader in init()). Used by Fader Snap to Zero
// (scheduleFaderSnapZeroCheck() above) to resolve whichever fader index
// was actually released to its current live target.
function getFaderSnapZeroTarget(i) {
   return i === 8 ? masterTrack.volume() : getFaderTarget(i);
}

// Returns whichever Parameter encoder `i` (0-7) should currently control -
// shared by the encoder CC handler in onMidi (input side) and
// updateVPotRingOutputs() (the V-Pot ring LED, output side) below, so the
// ring always reflects exactly what the encoder itself controls. Not the
// same set of rules as getFaderTarget(): encoders always control macros
// in MODE_DEVICE regardless of FLIP (only the faders swap with FLIP
// there), and in MODE_MIXER the encoder controls pan (unflipped) or
// volume (flipped) - the opposite of the fader in that mode.
function getEncoderTarget(i) {
   if (currentMode === MODE_SENDS) {
      var sendIdx = (sendBankPage * 8) + i;
      return cursorTrack.sendBank().getItemAt(sendIdx);
   }
   if (currentMode === MODE_DEVICE) {
      return remoteControls.getParameter(i);
   }
   // See getFaderTarget() above - same Hide mode empty-slot guard.
   if (currentMode === MODE_MIXER && isMainSlotEmpty(i)) {
      return null;
   }
   if (!isFlipped) {
      if (currentMode === MODE_MIXER && isToolVolumeMode) {
         return getToolParam(i, 1);
      }
      return activeTrackAt(i).pan();
   }
   if (currentMode === MODE_MIXER && isToolVolumeMode) {
      return getToolParam(i, 0);
   }
   return activeTrackAt(i).volume();
}

// Re-binds each of the 8 hwFaders to whichever Parameter they should
// currently control, whenever the active mode/flip/tool state changes
// (called everywhere the old manual refreshFaders() used to be). This is
// the INPUT side: Bitwig's own hardware-binding system (see hwFaders
// above) routes the physical fader's incoming pitch-bend straight to
// whichever parameter is bound, with no manual onMidi() parsing needed.
function rebindFaders() {
   for (var i = 0; i < 8; i++) {
      var target = getFaderTarget(i);
      if (target) {
         hwFaders[i].setBinding(target);
      } else {
         // No TOOL_DEVICE_NAME parameter found for this slot (isToolVolumeMode) - nothing to bind.
         hwFaders[i].clearBindings();
      }
   }
   // Force an immediate output refresh too, since the newly-bound
   // parameters' values likely differ from whatever was last sent for the
   // previous target (see updateFaderOutputs()/lastSentFaderValue below).
   lastSentFaderValue = [-1, -1, -1, -1, -1, -1, -1, -1, -1];
   lastSentVPotRing = [-1, -1, -1, -1, -1, -1, -1, -1];
   // Also force the channel-color SysEx to re-send - rebindFaders() is
   // called on every bank scroll / RETURNS toggle, which is exactly when
   // the active bank's 8 tracks (and so their colors) change.
   lastSentChannelColors = null;
}

// OUTPUT side: motorized fader feedback is NOT automatic just because a
// HardwareSlider is bound via setBinding() above - Bitwig's own shipped
// Mackie Control driver (and Jurgen Mossgraber's DrivenByMoss MCU driver)
// both confirm this by explicitly polling each fader's current value on
// every flush() call and manually calling sendPitchbend() whenever it's
// changed since the last flush - there's no simpler API for this. Called
// from flush() below, so it naturally covers hardware input, mouse drags,
// automation playback, and mode/bank switches alike (anything that changes
// the bound parameter's value), not just discrete button-triggered events.
function sendFaderPitchBendIfChanged(channel, normalizedValue) {
   if (normalizedValue === undefined || normalizedValue === null) normalizedValue = 0;
   var val14 = Math.max(0, Math.min(16383, Math.round(normalizedValue * 16383)));
   if (val14 === lastSentFaderValue[channel]) {
      return;
   }
   lastSentFaderValue[channel] = val14;
   midiOut.sendMidi(0xE0 + channel, val14 & 0x7F, (val14 >> 7) & 0x7F);
}

function updateFaderOutputs() {
   for (var i = 0; i < 8; i++) {
      var target = getFaderTarget(i);
      sendFaderPitchBendIfChanged(i, target ? target.value().get() : 0);
   }
   sendFaderPitchBendIfChanged(8, masterTrack.volume().value().get());
}

// Sends the V-Pot ring LED position for channel `channel` if it's changed
// since the last flush (same de-dup pattern as sendFaderPitchBendIfChanged
// above) - see lastSentVPotRing above for the protocol details.
function sendVPotRingIfChanged(channel, normalizedValue) {
   if (normalizedValue === undefined || normalizedValue === null) normalizedValue = 0;
   // 0-11 position, rounded, with a nonzero value always showing at least
   // 1 dot lit (matches Mossgraber's setKnobLED() - otherwise small
   // nonzero values would look indistinguishable from exactly zero).
   var position = Math.round(Math.max(0, Math.min(1, normalizedValue)) * 11);
   if (normalizedValue > 0 && position === 0) {
      position = 1;
   }
   if (position === lastSentVPotRing[channel]) {
      return;
   }
   lastSentVPotRing[channel] = position;
   midiOut.sendMidi(0xB0, 0x30 + channel, (VPOT_LED_MODE_SINGLE_DOT << 4) + position);
}

function updateVPotRingOutputs() {
   for (var i = 0; i < 8; i++) {
      var target = getEncoderTarget(i);
      sendVPotRingIfChanged(i, target ? target.value().get() : 0);
   }
}

// EXPERIMENTAL - see lastSentChannelColors above. Sends the active bank's
// 8 track colors as one SysEx, only when at least one of the 24 R/G/B
// bytes has actually changed since the last flush.
function updateChannelColorOutput() {
   var bytes = [];
   for (var i = 0; i < 8; i++) {
      // Hide mode empty slot: activeTrackAt(i) is a stale cursor (still
      // pointing at whatever real, off-screen track it last did) - show
      // black/off rather than that track's real color.
      if (isMainSlotEmpty(i)) {
         bytes.push(0, 0, 0);
         continue;
      }
      var color = activeTrackAt(i).color();
      bytes.push(Math.round(Math.max(0, Math.min(1, color.red())) * 127));
      bytes.push(Math.round(Math.max(0, Math.min(1, color.green())) * 127));
      bytes.push(Math.round(Math.max(0, Math.min(1, color.blue())) * 127));
   }

   var changed = lastSentChannelColors === null;
   if (!changed) {
      for (var c = 0; c < 24; c++) {
         if (bytes[c] !== lastSentChannelColors[c]) {
            changed = true;
            break;
         }
      }
   }
   if (!changed) {
      return;
   }
   lastSentChannelColors = bytes;

   var sysex = [0xF0, 0x00, 0x02, 0x4E, 0x16, 0x14].concat(bytes);
   sysex.push(0xF7);
   midiOut.sendSysexBytes(sysex);
}

// Segment display (transport position) - polled every flush() like the
// fader/V-Pot ring/channel-color outputs above, rather than an observer,
// since BeatTimeValue.getFormatted() is a pull, not a push API (only the
// deprecated addTimeObserver() pushes - avoided here in favor of the
// same polling pattern already used everywhere else in this file).
// getFormatted(positionFormatter) yields e.g. "003:02:03:045" (Bars:
// Beats:Subdivision:Ticks, per the 3/2/2/3 split chosen in init()).
function updateSegmentDisplay() {
   var text = transport.getPosition().getFormatted(positionFormatter);
   if (text === lastSegmentDisplayText) {
      return;
   }
   lastSegmentDisplayText = text;

   // Ports Mossgraber's MCUSegmentDisplay.writeLine(): walk the text
   // right-to-left filling 10 digit cells; a ':' doesn't consume a cell -
   // it sets a flag that ORs 0x40 onto the NEXT (further left) digit's
   // ASCII code, which is how this display's 7-segment protocol encodes
   // "digit with a decimal dot after it". Unfilled cells (string shorter
   // than 10 digits) get a blank space.
   var addDot = false;
   var pos = text.length - 1;
   var i = 0;
   while (i < 10) {
      var c = 0x20;
      if (pos >= 0) {
         var ch = text.charAt(pos);
         pos--;
         if (ch === ":") {
            addDot = true;
            continue;
         }
         c = ch.charCodeAt(0);
         if (addDot) {
            c += 0x40;
         }
      }
      if (c !== segmentDisplayBuffer[i]) {
         midiOut.sendMidi(0xB0, 0x40 + i, c);
         segmentDisplayBuffer[i] = c;
      }
      i++;
      addDot = false;
   }
}

// Force Refresh LCD Text Cache
function refreshDisplayText() {
   for (var i = 0; i < 8; i++) {
      if (currentMode === MODE_SENDS) {
         var sendIdx = (sendBankPage * 8) + i;
         var sendItem = cursorTrack.sendBank().getItemAt(sendIdx);
         topRowText[i] = formatTrackName(sendItem.name().get() || ("Send " + (sendIdx + 1)), 7);
         bottomRowText[i] = formatString(sendItem.displayedValue().get(), 7);
      } else if (currentMode === MODE_MIXER) {
         if (isToolVolumeMode) {
            var gainParam = getToolParam(i, 0);
            if (gainParam) {
               topRowText[i] = formatTrackName(gainParam.name().get(), 7);
               bottomRowText[i] = formatString(gainParam.displayedValue().get(), 7);
            } else {
               topRowText[i] = formatString("No " + TOOL_DEVICE_NAME, 7);
               bottomRowText[i] = formatString("", 7);
            }
         } else if (!isViewingReturns && hideDeactivatedTracksEnabled && !mainCursorHasTrack[i]) {
            // Hide mode: no activated track left to fill this slot - see
            // refreshMainCursors() above, which already blanked
            // topRowText[i]/bottomRowText[i] directly; nothing to read
            // here (the cursor itself is stale/unpointed for this slot).
         } else {
            var track = activeTrackAt(i);
            topRowText[i] = track.isActivated().get() ? formatTrackName(track.name().get(), 7) : "       ";
            bottomRowText[i] = track.isActivated().get() ? formatString(track.volume().displayedValue().get(), 7) : "       ";
         }
      } else if (currentMode === MODE_DEVICE) {
         var param = remoteControls.getParameter(i);
         topRowText[i] = formatTrackName(param.name().get(), 7);
         bottomRowText[i] = formatString(param.displayedValue().get(), 7);
      }
   }
   displayNeedsUpdate = true;
}

// Render MCU LCD Display SysEx Messages
// SysEx Format: F0 00 00 66 14 12 <offset> <ASCII text...> F7
function renderLCDDisplays() {
   var topTextCombined = topRowText.join("");
   var bottomTextCombined = bottomRowText.join("");

   sendMCUSysex(0x00, topTextCombined);   // Top Row (56 chars)
   sendMCUSysex(0x38, bottomTextCombined); // Bottom Row (56 chars offset 56)
}

function sendMCUSysex(offset, text) {
   debugLog(DEBUG_LCD, "LCD SysEx - offset " + offset + ": \"" + text + "\"");
   var header = [0xF0, 0x00, 0x00, 0x66, 0x14, 0x12, offset];
   var sysexBytes = header.slice();

   for (var i = 0; i < text.length && i < 56; i++) {
      var charCode = text.charCodeAt(i) & 0x7F;
      sysexBytes.push(charCode);
   }

   sysexBytes.push(0xF7);
   midiOut.sendSysexBytes(sysexBytes);
}

// Helper: format a raw pan value (0..1, 0.5 = center) as the classic
// mixing-console "50L" / "50R" / "C" style, rather than Bitwig's own
// displayedValue() (a plain percentage string with no L/R indicator).
function formatPanLR(rawValue) {
   if (rawValue === undefined || rawValue === null) rawValue = 0.5;
   var percent = Math.round(Math.abs(rawValue - 0.5) * 200);
   if (percent === 0) {
      return "C";
   }
   return percent + (rawValue < 0.5 ? "L" : "R");
}

// Bitwig's ColorValue only exposes raw red()/green()/blue() (0-1 floats) -
// no color-name API exists (confirmed against the Controller API Javadoc).
// Rather than guessing generic color names, these are Bitwig's REAL
// default track-color palette entries - ported verbatim (name + exact RGB)
// from Mossgraber's DAWColor.java (de.mossgrabers.framework.daw), which
// reverse-engineers this exact 27-color grid for controller color-matching
// in his own DrivenByMoss drivers. Since a track's color almost always
// comes from picking one of these 27 swatches in Bitwig's own color
// picker, nameForTrackColor() below will usually land on an exact (or
// near-exact) match rather than an approximate guess - fixing the earlier
// problem where a generic palette collapsed neighboring swatches like
// Orange/Light Orange into the same name. Names are abbreviated from
// Mossgraber's originals (kept in the comments) to fit the 7-character
// LCD cell limit.
var NAMED_COLORS = [
   { n: "DKGRAY",  r: 0.3294117748737335, g: 0.3294117748737335, b: 0.3294117748737335 }, // Dark Gray
   { n: "GRAY",    r: 0.47843137383461,   g: 0.47843137383461,   b: 0.47843137383461   }, // Gray
   { n: "GRAY50",  r: 0.5,                g: 0.5,                b: 0.5                }, // Gray half
   { n: "LTGRAY",  r: 0.7882353067398071, g: 0.7882353067398071, b: 0.7882353067398071 }, // Light Gray
   { n: "SILVER",  r: 0.5254902243614197, g: 0.5372549295425415, b: 0.6745098233222961 }, // Silver
   { n: "DKBROWN", r: 0.6392157077789307, g: 0.4745098054409027, b: 0.26274511218070984}, // Dark Brown
   { n: "BROWN",   r: 0.7764706015586853, g: 0.6235294342041016, b: 0.43921568989753723}, // Brown
   { n: "DKBLUE",  r: 0.34117648005485535,g: 0.3803921639919281, b: 0.7764706015586853 }, // Dark Blue
   { n: "PRPLBLU", r: 0.5176470875740051, g: 0.5411764979362488, b: 0.8784313797950745 }, // Purplish Blue
   { n: "PURPLE",  r: 0.5843137502670288, g: 0.2862745225429535, b: 0.7960784435272217 }, // Purple
   { n: "PINK",    r: 0.8509804010391235, g: 0.21960784494876862,b: 0.4431372582912445 }, // Pink
   { n: "RED",     r: 0.8509804010391235, g: 0.18039216101169586,b: 0.1411764770746231 }, // Red
   { n: "ORANGE",  r: 1,                  g: 0.34117648005485535,b: 0.0235294122248888 }, // Orange
   { n: "LTORANG", r: 0.8509804010391235, g: 0.615686297416687,  b: 0.062745101749897  }, // Light Orange
   { n: "MOSSGRN", r: 0.26274511218070984,g: 0.8235294222831726, b: 0.7254902124404907 }, // Moss Green
   { n: "GREEN",   r: 0.45098039507865906,g: 0.5960784554481506, b: 0.0784313753247261 }, // Green
   { n: "COLDGRN", r: 0,                  g: 0.615686297416687,  b: 0.27843138575553894}, // Cold Green
   { n: "BLUE",    r: 0.2666666805744171, g: 0.7843137383460999, b: 1                  }, // Blue
   { n: "LTPURPL", r: 0.7372549176216125, g: 0.4627451002597809, b: 0.9411764740943909 }, // Light Purple
   { n: "LTPINK",  r: 0.8823529481887817, g: 0.4000000059604645, b: 0.5686274766921997 }, // Light Pink
   { n: "ROSE",    r: 0.9254902005195618, g: 0.3803921639919281, b: 0.34117648005485535}, // Rose
   { n: "REDBRWN", r: 1,                  g: 0.5137255191802979, b: 0.24313725531101227}, // Redish Brown
   { n: "LTBROWN", r: 0.8941176533699036, g: 0.7176470756530762, b: 0.30588236451148987}, // Light Brown
   { n: "LTGREEN", r: 0.6274510025978088, g: 0.7529411911964417, b: 0.2980392277240753 }, // Light Green
   { n: "BLUGRN",  r: 0,                  g: 0.6509804129600525, b: 0.5803921818733215 }, // Bluish Green
   { n: "GRNBLU",  r: 0.24313725531101227,g: 0.7333333492279053, b: 0.3843137323856354 }, // Greenish Blue
   { n: "LTBLUE",  r: 0,                  g: 0.6000000238418579, b: 0.8509804010391235 }  // Light Blue
];

function nameForTrackColor(color) {
   var r = color.red(), g = color.green(), b = color.blue();
   var bestName = "?";
   var bestDist = Infinity;
   for (var i = 0; i < NAMED_COLORS.length; i++) {
      var c = NAMED_COLORS[i];
      var dr = r - c.r, dg = g - c.g, db = b - c.b;
      var dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
         bestDist = dist;
         bestName = c.n;
      }
   }
   return bestName;
}

// Helper: Format string to fixed length (7 chars, padded or truncated)
function formatString(str, length) {
   if (!str) str = "";
   str = str.trim();
   if (str.length > length) {
      return str.substring(0, length);
   }
   while (str.length < length) {
      str = str + " ";
   }
   return str;
}

// Helper: Format a NAME (track/send/device/param) to fixed length, showing
// the first half and last half of the name (dropping the middle) instead of
// just cutting it off at the end - each LCD cell is only 7 characters (the
// display is 56 chars total / 8 channels), so a name like "Kickdrum Bus" is
// otherwise chopped down to just "Kickdru", losing anything past character
// 7. Splits as ceil(length/2) head + floor(length/2) tail, so for the
// standard 7-char cell that's the first 4 and last 3 characters.
function formatTrackName(str, length) {
   if (!str) str = "";
   str = str.trim();
   if (str.length > length) {
      var headLen = Math.ceil(length / 2);
      var tailLen = length - headLen;
      return str.substring(0, headLen) + str.substring(str.length - tailLen);
   }
   while (str.length < length) {
      str = str + " ";
   }
   return str;
}

function onSysex(data) {
   // SysEx input handling if required
}

// Bitwig calls this periodically. hwSurface.updateHardware() flushes the
// native hardware-surface bindings' queued state (touch lights etc, and
// required in general per the API docs); updateFaderOutputs() is the
// actual motor-feedback push - see its comment above for why that can't
// just be automatic. updateVPotRingOutputs() is the same idea for the
// V-Pot ring LEDs (see lastSentVPotRing above), and
// updateChannelColorOutput() for the (experimental) per-channel colors.
function flush() {
   hwSurface.updateHardware();
   updateFaderOutputs();
   updateVPotRingOutputs();
   updateChannelColorOutput();
   updateSegmentDisplay();
}

function exit() {
   println("Midiplus UP Controller Script Exited.");
}
