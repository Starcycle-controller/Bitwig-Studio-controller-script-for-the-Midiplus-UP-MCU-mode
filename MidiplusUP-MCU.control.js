// Midiplus UP Bitwig Controller Script (Standard MCU Mode)
// Author: Antigravity
// API Version: 25
//
// This hardware is run in the Up/Up+'s standard "MCU" control mode (not one
// of the Logic/Cubase/Live "customized" modes - see the manual, section 3.3
// and section 8), with the plastic Ableton Live overlay removed, so the
// buttons show their real printed labels. Note numbers below match the
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
   "Antigravity"
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
// named TOOL_DEVICE_NAME. Raise if you nest it deeper than this in your
// chains.
var TOOL_DEVICE_SCAN_DEPTH = 4;
var currentMode = MODE_MIXER;
var sendBankPage = 0; // 0 = Sends 1-8, 1 = Sends 9-16
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
// bank. -1 means "None" (disabled). Defaults: CTRL long-press for
// expanded view (also opening the plugin window), ALT tap for macro
// bank.
var MODIFIER_NAME_TO_NOTE = { "SHIFT": 70, "OPTION": 71, "CTRL": 72, "ALT": 73, "None": -1 };
var EXPANDED_VIEW_BUTTON = 72;
var EXPANDED_VIEW_INSTANT = false; // false = long press, true = instant tap
// Whether the Expanded Device View action also opens (and, on the next
// press, closes) the plugin window - so the button both expands AND shows
// the device, in one press, instead of needing PLUG-INS/F1-F8 pressed
// first.
var EXPANDED_VIEW_OPENS_WINDOW = true;
var MACRO_CYCLE_BUTTON = 73;
// Whether opening a device's plugin window (PLUG-INS, F1-F8 direct
// select, or the Expanded Device View action above) first closes every
// OTHER device's window on the current track's chain, for an "only one
// plugin window open at a time" workflow - see
// closeOtherDeviceWindowsIfConfigured() below. Scoped to the current
// track's 8-slot device chain (cursorDeviceBank) only - the Controller
// API has no way to enumerate open plugin windows project-wide.
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

// Green-state F1-F8 (notes 62-69, see case 62-69 below) - configurable
// "editing function" keys, set via the 8 "F1-F8 Function (Green State)"
// Controller Preferences dropdowns in init(). Every press shows the
// action name both as a Bitwig on-screen popup (host.showPopupNotification,
// same as the orange state's "Device N" popup) AND as a momentary LCD
// popup on that F-key's own channel strip (showBottomRowPopup, truncated
// to 7 characters like every other LCD popup) - see invokeFKeyFunction().
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
   "Click button": { actionId: "Click button" }
};

// Explicit ordered list (rather than Object.keys(FKEY_FUNCTIONS), whose
// key order isn't guaranteed in every JS engine) for the dropdown option
// lists - "None" first, then FKEY_FUNCTIONS' entries in the order above.
var FKEY_FUNCTION_NAMES = ["None"].concat(Object.keys(FKEY_FUNCTIONS));

function invokeFKeyFunction(name, fkeyIndex) {
   if (name === "None") {
      return;
   }
   host.showPopupNotification(name);
   showBottomRowPopup(fkeyIndex, name);

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
// arranger clip/item, throttled the same way as device-stepping above
// (reuses PLUGIN_DEVICE_STEP_MESSAGES rather than a separate constant,
// since it's the same "step through a list" granularity).
var clipSelectStepAccumulator = 0;

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

// ZOOM (100) and SCRUB (101) are TOGGLE buttons in the real protocol (press
// to flip state, not held-while-down like SHIFT/OPTION/CTRL/ALT).
var isZoomToggled = false;
var isScrubToggled = false;

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
var masterTrack = null;
var cursorTrack = null;
var cursorDevice = null;
var cursorDeviceBank = null; // 8-slot device chain bank for the F1-F8 (notes 54-61) direct device-select feature
var remoteControls = null;
var transport = null;
var application = null;
var arranger = null;
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

function activeTrackBank() {
   return isViewingReturns ? effectTrackBank : trackBank;
}

// Length of one bar in beats (quarter notes) under the project's current
// time signature - e.g. 4/4 -> 4, 6/8 -> 3. Transport.incPosition() and
// arrangerLoopStart()/Duration() are all denominated in beats, not bars, so
// jog-wheel bar-jump/loop-shift math needs this conversion.
function getBeatsPerBar() {
   return transport.timeSignature().numerator().get() * (4.0 / transport.timeSignature().denominator().get());
}

function activeLedState() {
   return isViewingReturns ? returnsLedState : mainLedState;
}

// Returns the Gain (paramIndex 0) or Pan (paramIndex 1) parameter of the
// TOOL_DEVICE_NAME device on the given track slot of the active bank, or
// null if that track has no such device within the first
// TOOL_DEVICE_SCAN_DEPTH positions of its chain.
function getToolParam(trackIndex, paramIndex) {
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

   // Toggled on-demand (not observed) by CTRL's long-press handling above,
   // so needs markInterested() or .toggle()/.get() throws.
   cursorDevice.isExpanded().markInterested();

   // Plugin Mode settings (Controller Preferences panel in Bitwig Studio ->
   // this controller -> "Plugin Mode" category) - which modifier button
   // toggles the expanded device view and cycles the macro bank, whether
   // the expanded-view toggle is an instant tap or a long press, and (for
   // the long-press case) how long that press needs to be held. All four
   // observers fire immediately with the initial value and again any time
   // the user edits it live, so the corresponding globals (see
   // EXPANDED_VIEW_BUTTON etc. above) always reflect the current setting
   // without needing a restart. Defaults match this session's original
   // hardcoded behavior.
   var expandedViewButtonSetting = host.getPreferences().getEnumSetting(
      "Expanded Device View Button", "Plugin Mode", ["CTRL", "ALT", "OPTION", "SHIFT", "None"], "CTRL");
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

   // Function Keys settings (Controller Preferences panel -> "Function
   // Keys" category) - what each of the 8 green-state F1-F8 buttons (see
   // FKEY_FUNCTION_NAMES/invokeFKeyFunction above, and case 62-69 below)
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

   // User-configurable wheel-tick threshold for OPTION + Jog Wheel's
   // loop-length halve/double (see loopScaleAccumulator above) - lower
   // values double/halve the loop faster per flick of the wheel.
   var loopScaleThresholdSetting = host.getPreferences().getNumberSetting(
      "Loop Halve/Double Wheel Ticks", "Timing", 2, 64, 1, "ticks", 16);
   loopScaleThresholdSetting.markInterested();
   loopScaleThresholdSetting.addRawValueObserver(function(value) {
      LOOP_SCALE_THRESHOLD = value;
   });

   // Remote Controls (8 Macros for selected device)
   remoteControls = cursorDevice.createCursorRemoteControlsPage(8);

   // Last-clicked-in-GUI parameter (see ALT + Jog Wheel in the wheel
   // handler above) - id is used for persistent state, per the Javadoc,
   // so keep it stable across versions.
   lastClickedParam = host.createLastClickedParameter("lastClickedParam", "Mouseover Parameter");
   lastClickedParamValue = lastClickedParam.parameter();
   lastClickedParamValue.name().markInterested();

   // Transport & Application Controls
   transport = host.createTransport();
   application = host.createApplication();
   arranger = host.createArranger();

   // Read on-demand (not observed) by END, CTRL+PUNCH IN/OUT, and the jog
   // wheel's bar-jump/loop-shift handling, so they need markInterested() or
   // .get() throws.
   transport.getPosition().markInterested();
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

   // Setup Observers for both the main track bank and the returns bank -
   // only the currently-active one (per isViewingReturns) writes to the
   // shared display caches / LEDs.
   setupChannelStripObservers(trackBank, mainLedState, false);
   setupChannelStripObservers(effectTrackBank, returnsLedState, true);

   // Enable metering (mode=3: LED + LCD) for each of the 8 channel strips -
   // real MCU protocol per Ableton's own driver (ChannelStrip.py). The
   // fader-motor bug this was once suspected of causing (and briefly
   // disabled to rule out) turned out to be unrelated - see
   // updateFaderOutputs() below - so this is back to its intended state.
   for (var meterStripIdx = 0; meterStripIdx < 8; meterStripIdx++) {
      midiOut.sendSysexBytes([0xF0, 0x00, 0x00, 0x66, 0x14, 0x20, meterStripIdx, 3, 0xF7]);
   }

   // Diagnostics: live-testable meter mode for channel 8 only (the other 7
   // strips stay on the confirmed mode=3 above) - lets us try each of the
   // 4 real MCU VU-meter modes (confirmed against Mossgraber's
   // switchVuMode()/VUMODE_* in MCUControlSurface.java, not guessed) from
   // the Controller Preferences panel and see the result on hardware
   // immediately, no redeploy needed, while investigating what channel 8's
   // LCD bar graph actually shows and whether it can be repurposed to
   // display track color instead of level.
   var meterTestModeValues = {
      "LED + LCD (default, mode 3)": 3,
      "Off (mode 0)": 0,
      "LED Only (mode 1)": 1,
      "LCD Only (mode 6)": 6
   };
   var meterTestModeSetting = host.getPreferences().getEnumSetting(
      "Channel 8 Meter Test Mode", "Diagnostics",
      ["LED + LCD (default, mode 3)", "Off (mode 0)", "LED Only (mode 1)", "LCD Only (mode 6)"],
      "LED + LCD (default, mode 3)");
   meterTestModeSetting.markInterested();
   meterTestModeSetting.addValueObserver(function (value) {
      midiOut.sendSysexBytes([0xF0, 0x00, 0x00, 0x66, 0x14, 0x20, 7, meterTestModeValues[value], 0xF7]);
   });

   // Track each bank's per-track TOOL_DEVICE_NAME device, if any (see isToolVolumeMode).
   setupToolDeviceTracking(trackBank, mainToolSlot, mainToolRemote);
   setupToolDeviceTracking(effectTrackBank, returnsToolSlot, returnsToolRemote);
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
   // comment on the send observer above.
   masterTrack.volume().value().markInterested();

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

   // Flush display initially
   updateModeLEDs();
   rebindFaders();
   host.scheduleTask(displayFlushTask, 100);

   println("Midiplus UP Controller Script Ready.");
}

// Wires up the Name/Volume/Pan/Arm/Solo/Mute/Select observers for one of the
// two 8-track banks (main tracks or return tracks). `ledState` is the cache
// this bank's Arm/Solo/Mute/Select observers update; only the currently
// active bank (isViewingReturns === isReturnsBank) actually pushes MIDI LED
// updates or display text, so the two banks don't fight over the shared
// hardware state while the other one is in the background.
function setupChannelStripObservers(bank, ledState, isReturnsBank) {
   for (var i = 0; i < 8; i++) {
      (function (index) {
         var track = bank.getItemAt(index);

         // Read on-demand (not observed) by the SELECT double-press
         // group-fold handler in handleButtonPress, so need markInterested().
         track.isGroup().markInterested();
         track.isGroupExpanded().markInterested();

         // Track Name Observer
         track.name().addValueObserver(function (name) {
            if (currentMode === MODE_MIXER && isViewingReturns === isReturnsBank) {
               topRowText[index] = formatTrackName(name, 7);
               displayNeedsUpdate = true;
            }
         });

         track.volume().value().markInterested();

         track.volume().displayedValue().addValueObserver(function (dispVal) {
            if (currentMode === MODE_MIXER && !isFlipped && isViewingReturns === isReturnsBank &&
                !isShowingPanTemporarily[index]) {
               bottomRowText[index] = formatString(dispVal, 7);
               displayNeedsUpdate = true;
            }
         });

         // Bottom row's temporary pan reveal while turning the encoder -
         // see revealPanTemporarily() above. Uses the raw value (formatted
         // ourselves via formatPanLR() into the classic "50L"/"50R"/"C"
         // style) rather than Bitwig's own displayedValue() string, which
         // is a plain percentage with no L/R indicator.
         track.pan().value().addValueObserver(function (rawVal) {
            if (currentMode === MODE_MIXER && !isFlipped && isViewingReturns === isReturnsBank &&
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
            if (currentMode === MODE_MIXER && isViewingReturns === isReturnsBank) {
               midiOut.sendMidi(0xD0, (index << 4) | level, 0);
            }
         });

         // Track Button State Observers (LED Feedback) - cached per-bank,
         // only sent to hardware while this bank is the active one.
         track.arm().addValueObserver(function (isArmed) {
            ledState.arm[index] = isArmed;
            if (isViewingReturns === isReturnsBank) {
               midiOut.sendMidi(0x90, 0 + index, isArmed ? 127 : 0); // Rec Arm LED
            }
         });

         track.solo().addValueObserver(function (isSoloed) {
            ledState.solo[index] = isSoloed;
            if (isViewingReturns === isReturnsBank) {
               midiOut.sendMidi(0x90, 8 + index, isSoloed ? 127 : 0); // Solo LED
            }
         });

         track.mute().addValueObserver(function (isMuted) {
            ledState.mute[index] = isMuted;
            if (isViewingReturns === isReturnsBank) {
               midiOut.sendMidi(0x90, 16 + index, isMuted ? 127 : 0); // Mute LED
            }
         });

         track.addIsSelectedInMixerObserver(function (isSelected) {
            ledState.select[index] = isSelected;
            if (isViewingReturns === isReturnsBank) {
               midiOut.sendMidi(0x90, 24 + index, isSelected ? 127 : 0); // Select LED
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

function setupToolDeviceTracking(bank, toolSlotState, toolRemoteState) {
   for (var i = 0; i < 8; i++) {
      (function (trackIndex) {
         toolSlotState[trackIndex] = -1;
         toolRemoteState[trackIndex] = scanTrackForToolDevice(
            bank.getItemAt(trackIndex),
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

// Re-sends the cached Arm/Solo/Mute/Select LED state for whichever bank is
// currently active - used after toggling RETURNS so the hardware LEDs catch
// up to the bank that's now actually mapped to the 8 channel strips.
function refreshChannelStripLEDs() {
   var ledState = activeLedState();
   for (var i = 0; i < 8; i++) {
      midiOut.sendMidi(0x90, 0 + i, ledState.arm[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 8 + i, ledState.solo[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 16 + i, ledState.mute[i] ? 127 : 0);
      midiOut.sendMidi(0x90, 24 + i, ledState.select[i] ? 127 : 0);
   }
}

// Scheduled task for LCD Display Refresh (throttled to avoid MIDI flooding)
function displayFlushTask() {
   if (displayNeedsUpdate) {
      renderLCDDisplays();
      displayNeedsUpdate = false;
   }
   host.scheduleTask(displayFlushTask, 100);
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
      println("RAW CC received - CC#: " + data1 + ", Value: " + data2);
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

      // If SHIFT is held, use fine-grain adjustments (0.2x scaling)
      if (isShiftPressed) { shiftUsedForCombo = true; }
      var delta = isShiftPressed ? (rawDelta * 0.2) : rawDelta;
      var resolution = isShiftPressed ? 512 : 128;

      // See getEncoderTarget() below for the exact per-mode/flip rules
      // (encoders always control macros in MODE_DEVICE regardless of
      // FLIP - only the faders swap there; MODE_MIXER's encoder is pan
      // unflipped / volume flipped, the opposite of the fader).
      var encTarget = getEncoderTarget(encoderIndex);
      if (encTarget) {
         encTarget.inc(delta, resolution);
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
   // = shift the arranger loop by whole bars; SCRUB toggle (note 101) =
   // jump the playhead by whole bars instead of scrubbing smoothly. See
   // the full priority-ordered writeup in README.md's "Jog wheel modifier
   // combos" section.
   if (msgType === 0xB0 && data1 === 60) {
      // Same sign-magnitude fix as the encoders above
      var backwards = data2 >= 64;
      var rawStep = backwards ? -(data2 - 64) : data2;

      if (currentMode === MODE_SCENE) {
         // BTA / Scene Mode: plain wheel turn moves the selected-scene
         // cursor within the 8-scene bank window (see sceneCursorIndex
         // above) - takes priority over every other modifier combo below,
         // since none of them make sense while browsing scenes. Launching
         // is done separately by note 87's press handler.
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
         // PLUGIN_DEVICE_STEP_MESSAGES messages, same throttling as the
         // device-step case above. Replaces the previous tempo-nudge
         // behavior per request; use SHIFT+ALT + Jog Wheel Press/Turn (see
         // below) to select and then move a clip instead.
         clipSelectStepAccumulator++;
         if (clipSelectStepAccumulator >= PLUGIN_DEVICE_STEP_MESSAGES) {
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
         // also note 87's press handler for ALT+wheel-press ("Select item
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
            // Floor at a 64th note so repeated halving can't reach zero/negative,
            // and cap at 256 bars so repeated doubling can't run away forever.
            var maxLoopDuration = 256 * getBeatsPerBar();
            transport.arrangerLoopDuration().set(Math.max(0.0625, Math.min(maxLoopDuration, newLoopDuration)));
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
         transport.getPosition().set(Math.max(0, targetBar) * beatsPerBar);
         return;
      }

      // Default: jump exactly one quarter note per wheel message, landing
      // precisely on the beat grid line - same "compute the exact target
      // position" approach as the bar-jump/loop-shift branches above,
      // rather than a smooth but grid-imprecise scrub. No longer
      // ALT-modified - ALT alone is now claimed above (mouseover-parameter
      // adjust), unreachable here since it always returns first.
      var currentBeatUnit = Math.round(transport.getPosition().get());
      var targetBeatUnit = backwards ? currentBeatUnit - 1 : currentBeatUnit + 1;
      transport.getPosition().set(Math.max(0, targetBeatUnit));
      return;
   }

   // 4. Modifier Buttons Press & Release (Note On: 0x90, Note Off: 0x80)
   if (msgType === 0x90 || msgType === 0x80) {
      var isPressed = (msgType === 0x90 && data2 > 0);
      if (isPressed) {
         println("RAW Note-On received - Note: " + data1); // DEBUG: catches modifier buttons too
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
      // tap can be assigned to a Plugin Mode action - see
      // handleModifierTap(). Defaults to toggling the expanded device
      // view on a long press, per the Plugin Mode settings in init().
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

      // Jog Wheel Push / Pan Mode (Note 87 - see isWheelPressed above).
      // ALT held + press runs Bitwig's real "Select item at cursor" action
      // (same one the F-key function list offers, see FKEY_FUNCTIONS) -
      // takes priority over the MODE_SCENE scene-launch behavior below,
      // since holding ALT is a deliberate, distinct gesture. Without ALT,
      // in MODE_SCENE a press launches the currently selected scene
      // instead - Pan Mode's bar-jump branch is unreachable in that mode
      // anyway (the wheel handler's MODE_SCENE branch takes priority), so
      // there's no conflict between the two (non-ALT) uses of this note.
      if (data1 === 87) {
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

      // SCRUB Button (Note 101) - toggles fine-scrub mode for the Jog Wheel;
      // also not a held modifier.
      if (data1 === 101) {
         if (isPressed) {
            isScrubToggled = !isScrubToggled;
            midiOut.sendMidi(0x90, 101, isScrubToggled ? 127 : 0);
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
   println("Button pressed - Note: " + note); // DEBUG: remove once all mappings are confirmed
   // Track Channel Strip Buttons (0 - 31) - always act on whichever bank
   // (main tracks or returns) is currently active.
   if (note >= 0 && note <= 7) {
      // Rec Arm 1-8
      activeTrackBank().getItemAt(note).arm().toggle();
      return;
   }
   if (note >= 8 && note <= 15) {
      // Solo 1-8 - .set() instead of .toggle() so the resulting state is
      // known synchronously, for the momentary SOLO/UNSOLO LCD popup (see
      // showBottomRowPopup()).
      var soloIdx = note - 8;
      var soloTrack = activeTrackBank().getItemAt(soloIdx);
      var newSoloState = !soloTrack.solo().get();
      soloTrack.solo().set(newSoloState);
      showBottomRowPopup(soloIdx, newSoloState ? "SOLO" : "UNSOLO");
      return;
   }
   if (note >= 16 && note <= 23) {
      // Mute 1-8 - same synchronous-state pattern as Solo above, for the
      // momentary MUTE/UNMUTE LCD popup.
      var muteIdx = note - 16;
      var muteTrack = activeTrackBank().getItemAt(muteIdx);
      var newMuteState = !muteTrack.mute().get();
      muteTrack.mute().set(newMuteState);
      showBottomRowPopup(muteIdx, newMuteState ? "MUTE" : "UNMUTE");
      return;
   }
   if (note >= 24 && note <= 31) {
      // Select 1-8 - double-pressing a group track's own SELECT button
      // (within DOUBLE_PRESS_MS) folds/unfolds it instead of re-selecting it.
      var selIdx = note - 24;
      var selectedTrack = activeTrackBank().getItemAt(selIdx);
      var nowMs = Date.now();
      var isDoublePress = (nowMs - lastSelectPressTime[selIdx]) < DOUBLE_PRESS_MS;
      lastSelectPressTime[selIdx] = nowMs;

      if (isDoublePress && selectedTrack.isGroup().get()) {
         selectedTrack.isGroupExpanded().toggle();
         lastSelectPressTime[selIdx] = 0; // don't let a 3rd quick press toggle again
      } else {
         selectedTrack.selectInMixer();
         cursorTrack.selectChannel(selectedTrack);
      }
      return;
   }
   if (note >= 32 && note <= 39) {
      // Encoder Push Click (Reset Parameter)
      var encIdx = note - 32;
      if (currentMode === MODE_MIXER) {
         // Pan only - centers the pan, nothing else. A volume-touching
         // version of this (reset to unity, then an attempted -10dB/0dB
         // target) caused real problems on hardware across several
         // implementations and was reverted; see git history if revisiting
         // a volume-reset feature here.
         activeTrackBank().getItemAt(encIdx).pan().reset();
      } else if (currentMode === MODE_SENDS) {
         var resetSendIdx = (sendBankPage * 8) + encIdx;
         cursorTrack.sendBank().getItemAt(resetSendIdx).reset();
      } else if (currentMode === MODE_DEVICE) {
         remoteControls.getParameter(encIdx).reset();
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
            if (currentMode === MODE_DEVICE) {
               cursorDevice.isWindowOpen().set(false);
            }
            currentMode = MODE_MIXER;
            sendBankPage = 0;
            isToolVolumeMode = false;
            host.showPopupNotification("Mode: Mixer (Volume / Pan)");
            applyModeChange("MIXER");
         }
         break;

      case 41: // SEND -> 3-State Send Mode: 1st Press (Sends 1-8) -> 2nd Press (Sends 9-16) -> 3rd Press (Exit Send Mode)
         if (currentMode !== MODE_SENDS) {
            // Leaving whatever we were in before - Device mode's open
            // plugin window doesn't belong once Sends takes over (see
            // applyModeChange()'s doc comment - every mode jump needs to
            // fully clean up the mode it's leaving, not just enter the
            // new one).
            if (currentMode === MODE_DEVICE) {
               cursorDevice.isWindowOpen().set(false);
            }
            currentMode = MODE_SENDS;
            sendBankPage = 0;
            isToolVolumeMode = false;
            host.showPopupNotification("Mode: Send Faders (Sends 1 - 8)");
            applyModeChange("SENDS");
         } else if (sendBankPage === 0) {
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
         if (currentMode === MODE_DEVICE) {
            cursorDevice.isWindowOpen().set(false);
         }
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
            cursorDevice.isWindowOpen().set(false);
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

      case 62: case 63: case 64: case 65: case 66: case 67: case 68: case 69:
         // F1-F8, green-lit state (SMPTE/BEATS toggles this, see note 53
         // above). Configurable editing-function keys - see
         // FKEY_FUNCTION_NAMES/invokeFKeyFunction above and the
         // "Function Keys" Controller Preferences category in init() -
         // rather than a fixed built-in action like the orange/default
         // state (case 54-61).
         invokeFKeyFunction(fKeyFunctionAssignment[note - 62], note - 62);
         break;

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
         if (currentMode === MODE_DEVICE) {
            cursorDevice.isWindowOpen().set(false);
         }
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
            activeTrackBank().scrollPosition().set(0);
            host.showPopupNotification("Jump to First Bank");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
         } else {
            activeTrackBank().scrollPageBackwards();
            host.showPopupNotification("Track Bank Left");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 47: // BANK NEXT (>) -> jump to last bank with SHIFT, else page forward
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            var maxOffsetBank = Math.max(0, activeTrackBank().itemCount().get() - 8);
            activeTrackBank().scrollPosition().set(maxOffsetBank);
            host.showPopupNotification("Jump to Last Bank");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectNextPage(true);
            host.showPopupNotification("Device Page Next");
         } else {
            activeTrackBank().scrollPageForwards();
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
            activeTrackBank().scrollPosition().set(0);
            host.showPopupNotification("Jump to First Channel");
         } else {
            activeTrackBank().scrollBackwards();
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
            var maxOffsetCh = Math.max(0, activeTrackBank().itemCount().get() - 8);
            activeTrackBank().scrollPosition().set(maxOffsetCh);
            host.showPopupNotification("Jump to Last Channel");
         } else {
            activeTrackBank().scrollForwards();
            host.showPopupNotification("Nudge Channel Right");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      // Note 50 - FLIP was previously (wrongly) assumed to be here; moved
      // to note 43 above after console-log confirmation. Deliberately left
      // unbound until it's confirmed what, if anything, this button
      // actually does under the current overlay - press it and check the
      // console for "RAW Note-On received".

      // Note 51 - RETURNS was previously (wrongly) assumed to be here;
      // moved to note 45 above after console-log confirmation. Deliberately
      // left unbound until it's confirmed what, if anything, this button
      // actually does under the current overlay - press it and check the
      // console for "RAW Note-On received".

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

      case 76: // UNDO
         application.undo();
         host.showPopupNotification("Undo");
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

      case 79: // REDO
         application.redo();
         host.showPopupNotification("Redo");
         break;

      case 80: // B.T.A. -> repurposed as MODE_SCENE toggle ("Scene Mode"):
               // shows the clip launcher + switches to the Mix panel layout,
               // and the jog wheel selects/launches scenes instead of its
               // usual transport scrub (see the jog wheel handler and note
               // 87's press handler). Second press exits back to Mixer mode
               // AND back to the Arrange panel layout, same toggle pattern
               // as PLUGIN/SEND.
         if (currentMode !== MODE_SCENE) {
            if (currentMode === MODE_DEVICE) {
               cursorDevice.isWindowOpen().set(false);
            }
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

      case 81: // DRAW -> cycle through the 6 arranger edit tools, one per
               // press (Pointer -> Time Selection -> Pencil -> Spray Can ->
               // Eraser -> Knife -> back to Pointer) - see
               // ARRANGER_TOOL_ACTIONS above. SHIFT+DRAW toggles Arranger
               // Automation Write instead (transport.
               // isArrangerAutomationWriteEnabled() - a real
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

      case 82: // MARKER -> Add Cue Marker at Playhead
         transport.addCueMarkerAtPlaybackPosition();
         host.showPopupNotification("Add Cue Marker at Playhead");
         break;

      case 83: // FOLLOW
         if (isShiftPressed) {
            shiftUsedForCombo = true;
            transport.isMetronomeEnabled().toggle();
            host.showPopupNotification("Toggle Metronome");
         } else {
            arranger.isPlaybackFollowEnabled().toggle();
            host.showPopupNotification("Toggle Follow Playhead (Auto-Scroll)");
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

      case 89: // HOME -> Jump Playhead to Beginning of Project (1.1.1)
         transport.getPosition().set(0);
         host.showPopupNotification("Jump to Start (Home)");
         break;

      case 90: // END -> Jump Playhead to the current loop start
         transport.getPosition().set(transport.arrangerLoopStart().get());
         host.showPopupNotification("Jump to Loop Start");
         break;

      // Cursor Arrows (96-99): navigate normally, or zoom while ZOOM (100)
      // is toggled on - matches Ableton's Transport.__on_cursor_*_pressed()
      // pattern (zoom vs scroll depending on the zoom-toggle state).
      case 96: // LEFT ARROW
         if (currentMode === MODE_DEVICE) {
            // Plugin mode: LEFT/RIGHT select the previous/next device on
            // the current chain, same target as the PLUGIN/CTRL+jog combos.
            cursorDevice.selectPrevious();
         } else if (isZoomToggled) {
            // application.zoomIn()/zoomOut() fired without error but never
            // actually changed the arranger's horizontal zoom (confirmed on
            // hardware, arranger focused) - trying zoomToFit() instead,
            // since it's a distinct, confirmed-real method.
            safeCall(application, "zoomToFit", "Zoom to Fit");
         } else {
            safeCall(application, "arrowKeyLeft");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 97: // RIGHT ARROW
         if (currentMode === MODE_DEVICE) {
            cursorDevice.selectNext();
         } else if (isZoomToggled) {
            safeCall(application, "zoomToSelection", "Zoom to Selection");
         } else {
            safeCall(application, "arrowKeyRight");
         }
         refreshDisplayText();
         rebindFaders();
         break;

      case 98: // UP ARROW
         if (isZoomToggled) {
            safeCall(arranger, "zoomInLaneHeightsSelected", "Zoom In (Track Height)");
         } else {
            safeCall(application, "arrowKeyUp");
         }
         break;

      case 99: // DOWN ARROW
         if (isZoomToggled) {
            safeCall(arranger, "zoomOutLaneHeightsSelected", "Zoom Out (Track Height)");
         } else {
            safeCall(application, "arrowKeyDown");
         }
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
function applyModeChange(popupText) {
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
   if (!isFlipped) {
      if (currentMode === MODE_MIXER && isToolVolumeMode) {
         return getToolParam(i, 0);
      }
      return activeTrackBank().getItemAt(i).volume();
   }
   if (currentMode === MODE_DEVICE) {
      return remoteControls.getParameter(i);
   }
   if (isToolVolumeMode) {
      return getToolParam(i, 1);
   }
   return activeTrackBank().getItemAt(i).pan();
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
   if (!isFlipped) {
      if (currentMode === MODE_MIXER && isToolVolumeMode) {
         return getToolParam(i, 1);
      }
      return activeTrackBank().getItemAt(i).pan();
   }
   if (currentMode === MODE_MIXER && isToolVolumeMode) {
      return getToolParam(i, 0);
   }
   return activeTrackBank().getItemAt(i).volume();
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
      var color = activeTrackBank().getItemAt(i).color();
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
         } else {
            var track = activeTrackBank().getItemAt(i);
            topRowText[i] = formatTrackName(track.name().get(), 7);
            bottomRowText[i] = formatString(track.volume().displayedValue().get(), 7);
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
