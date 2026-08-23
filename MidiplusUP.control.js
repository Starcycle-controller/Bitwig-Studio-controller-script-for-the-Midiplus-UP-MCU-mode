// Midiplus UP Bitwig Controller Script (MCU Engine + Ableton Live Overlay Template)
// Author: Antigravity
// API Version: 25
//
// Note numbers below are sourced from Ableton's own shipped "MackieControl"
// remote script (consts.py / Transport.py / SoftwareController.py /
// ChannelStripController.py - identical SID values in the Live 9 and Live 12
// releases), since the Midiplus UP's "Live" control mode implements the
// standard Mackie Control protocol that Ableton's built-in driver expects
// (see the Midiplus UP manual, section 6.2: "set Control Surface 1 to
// Mackie Control"). Where the manual documents a Live-only function
// (RETURNS, SMPTE/BEATS, DRAW, MARKER, PUNCH IN/OUT, HOME/END, ...) but
// this script's Bitwig behavior differs from Ableton's, that's a deliberate
// Bitwig-appropriate adaptation, not an attempt at 1:1 parity - only the
// physical button -> note number mapping needs to match the hardware.

loadAPI(25);

// Define Controller Metadata
host.defineController(
   "Midiplus",
   "Midiplus UP (Ableton Live Overlay)",
   "1.0.0",
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
var isFlipped = false;

// Hardware Modifier States (note numbers confirmed against Ableton's own
// MackieControl driver - see file header)
var isShiftPressed = false;   // Note 70
var isOptionPressed = false;  // Note 71
var isControlPressed = false; // Note 72
var isAltPressed = false;     // Note 73

// CTRL long-press-to-toggle-expanded-view tracking (see the CTRL block in
// onMidi and cursorDevice.isExpanded() below). ctrlUsedForCombo is set true
// as soon as CTRL is used to modify the jog wheel, so releasing it
// afterwards doesn't also toggle the expanded view.
var ctrlPressStartTime = 0;
var ctrlUsedForCombo = false;
// Default; overridden live from the Controller Preferences panel setting
// created in init() below (see ctrlHoldTimeSetting).
var CTRL_LONG_PRESS_MS = 500;

// Physical jog wheel push/click, note 87 on this hardware (also the
// standard Mackie Control protocol's PUNCH IN note - it was briefly wired
// up as a Punch-In toggle on release, but this hardware re-sends Note-On 87
// unreliably while held whenever another button is pressed alongside it,
// making press/release tracking too flaky for a tap-to-toggle action - so
// that's been dropped). Pure momentary hold modifier: while held, the jog
// wheel pans the arranger timeline left/right by whole bars instead of the
// default quarter-note scrub (same jump-target math as toggling SCRUB).
var isWheelPressed = false;

// PLUGIN Button (Note 43): a press still reaches handleButtonPress() for
// its own action (jump to the first device on the selected track and open
// its panel), but held state is also tracked here so the jog wheel can
// step through devices while it's held - see isPluginHeld below.
var isPluginHeld = false;
var pluginDeviceStepAccumulator = 0;
var PLUGIN_DEVICE_STEP_MESSAGES = 4;

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

// Host Objects
var trackBank = null;
var effectTrackBank = null; // "Returns" bank, shown when isViewingReturns is true
var masterTrack = null;
var cursorTrack = null;
var cursorDevice = null;
var remoteControls = null;
var transport = null;
var application = null;
var arranger = null;
var midiOut = null;

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

   // Enable SysEx handling
   host.getMidiInPort(0).setSysexCallback(onSysex);

   // Set MIDI callback
   host.getMidiInPort(0).setMidiCallback(onMidi);

   // Initialize Main Track Bank (8 tracks, 16 sends, 8 scenes)
   trackBank = host.createMainTrackBank(8, MAX_SENDS, 8);

   // Initialize Effect ("Returns") Track Bank - shown via the RETURNS button
   effectTrackBank = host.createEffectTrackBank(8, MAX_SENDS, 8);

   // Read on-demand (not observed) by the SHIFT+BANK/CHANNEL "jump to last"
   // handlers below, so they need markInterested() or .get() throws.
   trackBank.itemCount().markInterested();
   effectTrackBank.itemCount().markInterested();

   // Initialize Master Track
   masterTrack = host.createMasterTrack(0);

   // Initialize Cursor Track & Send Bank (16 Send slots for focused track)
   cursorTrack = host.createCursorTrack("MIDIPLUS_CURSOR_TRACK", "Cursor Track", 16, 0, true);
   cursorDevice = cursorTrack.createCursorDevice("MIDIPLUS_CURSOR_DEVICE", "Cursor Device", 0, CursorDeviceFollowMode.FIRST_INSTRUMENT_OR_DEVICE);

   // Toggled on-demand (not observed) by CTRL's long-press handling above,
   // so needs markInterested() or .toggle()/.get() throws.
   cursorDevice.isExpanded().markInterested();

   // User-configurable CTRL long-press duration (Controller Preferences
   // panel in Bitwig Studio -> this controller -> "Timing" category).
   // addRawValueObserver fires immediately with the initial value and again
   // any time the user edits it live, so CTRL_LONG_PRESS_MS always reflects
   // the current setting without needing a restart.
   var ctrlHoldTimeSetting = host.getPreferences().getNumberSetting(
      "CTRL Hold Time (Expanded Device View)", "Timing", 200, 2000, 10, "ms", 500);
   ctrlHoldTimeSetting.markInterested();
   ctrlHoldTimeSetting.addRawValueObserver(function(value) {
      CTRL_LONG_PRESS_MS = value;
   });

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

   // Setup Observers for both the main track bank and the returns bank -
   // only the currently-active one (per isViewingReturns) writes to the
   // shared display caches / LEDs.
   setupChannelStripObservers(trackBank, mainLedState, false);
   setupChannelStripObservers(effectTrackBank, returnsLedState, true);

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

         sendItem.value().addValueObserver(function (val) {
            if (currentMode === MODE_SENDS) {
               var offset = sendBankPage * 8;
               if (sendIdx >= offset && sendIdx < offset + 8) {
                  var channelIdx = sendIdx - offset;
                  sendPitchBend(channelIdx, val);
               }
            }
         });

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

   // Master Track Volume Observer
   masterTrack.volume().value().addValueObserver(function (value) {
      sendPitchBend(8, value); // Channel 9 (0xE8) for Master Fader
   });

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

         param.value().addValueObserver(function (value) {
            if (currentMode === MODE_DEVICE && isFlipped) {
               sendPitchBend(paramIndex, value);
            }
         });
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
         refreshFaders();
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

         // Track Volume Observer - live-updates the fader while it's showing
         // track volume, which (per the FLIP overlay) is both MIXER-unflipped
         // and DEVICE-unflipped.
         track.volume().value().addValueObserver(function (value) {
            if (!isFlipped && (currentMode === MODE_MIXER || currentMode === MODE_DEVICE) &&
                isViewingReturns === isReturnsBank) {
               sendPitchBend(index, value);
            }
         });

         track.volume().displayedValue().addValueObserver(function (dispVal) {
            if (currentMode === MODE_MIXER && !isFlipped && isViewingReturns === isReturnsBank) {
               bottomRowText[index] = formatString(dispVal, 7);
               displayNeedsUpdate = true;
            }
         });

         // Track Pan Observer
         track.pan().value().addValueObserver(function (value) {
            if (currentMode === MODE_MIXER && isFlipped && isViewingReturns === isReturnsBank) {
               sendPitchBend(index, value);
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
         // init - refreshFaders()/refreshDisplayText() read these on-demand
         // rather than observing them, so without this they throw
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
      refreshFaders();
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

   // 1. Motorized Pitchbend Faders (14-bit resolution)
   if (msgType === 0xE0) {
      var val14 = (data2 << 7) | data1;
      var normalizedVal = val14 / 16383.0;

      if (channel >= 0 && channel < 8) {
         if (currentMode === MODE_SENDS) {
            // Sends Mode: Faders 1-8 control Sends on focused track
            var sendTargetIndex = (sendBankPage * 8) + channel;
            cursorTrack.sendBank().getItemAt(sendTargetIndex).set(normalizedVal);
         } else if (!isFlipped) {
            // Standard Fader -> Track Volume (or Tool Gain in isToolVolumeMode).
            // Applies in both MIXER and DEVICE modes - FLIP is the overlay
            // that swaps faders/encoders between volume and macros.
            if (currentMode === MODE_MIXER && isToolVolumeMode) {
               var gainParam = getToolParam(channel, 0);
               if (gainParam) {
                  gainParam.set(normalizedVal);
               }
            } else {
               activeTrackBank().getItemAt(channel).volume().set(normalizedVal);
            }
         } else if (currentMode === MODE_DEVICE) {
            // Flipped + Plugin mode: faders control the device macros
            // (encoders take over track volume - see the encoder handler).
            remoteControls.getParameter(channel).set(normalizedVal);
         } else {
            // Flipped Fader behavior (MIXER)
            if (isToolVolumeMode) {
               var panParam = getToolParam(channel, 1);
               if (panParam) {
                  panParam.set(normalizedVal);
               }
            } else {
               activeTrackBank().getItemAt(channel).pan().set(normalizedVal);
            }
         }
      } else if (channel === 8) {
         // Master Fader
         masterTrack.volume().set(normalizedVal);
      }
      return;
   }

   // 2. Rotary Encoders (CC 16-23 on Channel 1: 0xB0)
   if (msgType === 0xB0 && data1 >= 16 && data1 <= 23) {
      var encoderIndex = data1 - 16;
      // MCU V-Pot relative encoding is sign-magnitude, NOT two's complement:
      // 1-63 = increment by that amount, 65-127 = decrement by (value - 64)
      var rawDelta = data2 < 64 ? data2 : -(data2 - 64);

      // If SHIFT is held, use fine-grain adjustments (0.2x scaling)
      var delta = isShiftPressed ? (rawDelta * 0.2) : rawDelta;
      var resolution = isShiftPressed ? 512 : 128;

      if (!isFlipped) {
         if (currentMode === MODE_MIXER) {
            if (isToolVolumeMode) {
               var encPanParam = getToolParam(encoderIndex, 1);
               if (encPanParam) {
                  encPanParam.inc(delta, resolution);
               }
            } else {
               activeTrackBank().getItemAt(encoderIndex).pan().inc(delta, resolution);
            }
         } else if (currentMode === MODE_SENDS) {
            var encSendIdx = (sendBankPage * 8) + encoderIndex;
            cursorTrack.sendBank().getItemAt(encSendIdx).inc(delta, resolution);
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.getParameter(encoderIndex).inc(delta, resolution);
         }
      } else {
         // Flipped Encoder -> Track Volume (or Tool Gain in isToolVolumeMode)
         if (currentMode === MODE_MIXER && isToolVolumeMode) {
            var encGainParam = getToolParam(encoderIndex, 0);
            if (encGainParam) {
               encGainParam.inc(delta, resolution);
            }
         } else {
            activeTrackBank().getItemAt(encoderIndex).volume().inc(delta, resolution);
         }
      }
      return;
   }

   // 3. Jog / Scroll Wheel (CC 60 on Channel 1: 0xB0)
   // Default: smooth, un-quantized scrub through the arranger timeline.
   // CTRL held = nudge tempo instead; SHIFT held = shift the arranger loop
   // by whole bars; SCRUB toggle (note 101) = jump the playhead by whole
   // bars instead of scrubbing smoothly; ALT halves the default scrub step.
   if (msgType === 0xB0 && data1 === 60) {
      // Same sign-magnitude fix as the encoders above
      var backwards = data2 >= 64;
      var rawStep = backwards ? -(data2 - 64) : data2;

      if (isControlPressed) {
         // Using CTRL to modify the wheel means a long-press expanded-view
         // toggle shouldn't also fire when it's released - see the CTRL
         // block above.
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

         // CTRL + Jog Wheel (outside Device mode): Nudge Tempo (fine with
         // ALT held)
         var tempoStep = isAltPressed ? 0.1 : 1.0;
         transport.tempo().incRaw(rawStep * tempoStep);
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

      // Default: jump exactly one quarter note per wheel message (half of
      // that, an eighth note, with ALT held), landing precisely on the
      // beat grid line - same "compute the exact target position" approach
      // as the bar-jump/loop-shift branches above, rather than a smooth
      // but grid-imprecise scrub.
      var beatStep = isAltPressed ? 0.5 : 1.0;
      var currentBeatUnit = Math.round(transport.getPosition().get() / beatStep);
      var targetBeatUnit = backwards ? currentBeatUnit - 1 : currentBeatUnit + 1;
      transport.getPosition().set(Math.max(0, targetBeatUnit) * beatStep);
      return;
   }

   // 4. Modifier Buttons Press & Release (Note On: 0x90, Note Off: 0x80)
   if (msgType === 0x90 || msgType === 0x80) {
      var isPressed = (msgType === 0x90 && data2 > 0);
      if (isPressed) {
         println("RAW Note-On received - Note: " + data1); // DEBUG: catches modifier buttons too
      }

      // SHIFT Button (Note 70)
      if (data1 === 70) {
         isShiftPressed = isPressed;
         midiOut.sendMidi(0x90, 70, isShiftPressed ? 127 : 0);
         return;
      }

      // OPTION Button (Note 71)
      if (data1 === 71) {
         isOptionPressed = isPressed;
         midiOut.sendMidi(0x90, 71, isOptionPressed ? 127 : 0);
         return;
      }

      // CTRL Button (Note 72) - a standalone LONG press (held without also
      // turning the jog wheel) toggles the expanded device view while in
      // Device mode. Still tracked as a modifier for other combos (tempo
      // nudge, CTRL+PUNCH IN/OUT, CTRL+jog device navigation) regardless of
      // hold duration - see ctrlUsedForCombo below.
      if (data1 === 72) {
         isControlPressed = isPressed;
         midiOut.sendMidi(0x90, 72, isControlPressed ? 127 : 0);
         if (isPressed) {
            ctrlPressStartTime = Date.now();
            ctrlUsedForCombo = false;
         } else if (!ctrlUsedForCombo && currentMode === MODE_DEVICE &&
                    (Date.now() - ctrlPressStartTime) >= CTRL_LONG_PRESS_MS) {
            cursorDevice.isExpanded().toggle();
         }
         return;
      }

      // ALT Button (Note 73)
      if (data1 === 73) {
         isAltPressed = isPressed;
         midiOut.sendMidi(0x90, 73, isAltPressed ? 127 : 0);
         return;
      }

      // Jog Wheel Push / Pan Mode (Note 87 - see isWheelPressed above)
      if (data1 === 87) {
         isWheelPressed = isPressed;
         return;
      }

      // PLUGIN Button (Note 43) - track hold state for the jog wheel device
      // navigation combo, but (unlike the pure modifiers above) only
      // `return` on release: a press still needs to fall through to
      // handleButtonPress() below for its own action.
      if (data1 === 43) {
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

// Ableton Live MCU Overlay Button Processing
function handleButtonPress(note) {
   println("Button pressed - Note: " + note); // DEBUG: remove once all mappings are confirmed
   // Track Channel Strip Buttons (0 - 31) - always act on whichever bank
   // (main tracks or returns) is currently active.
   if (note >= 0 && note <= 7) {
      // Rec Arm 1-8
      activeTrackBank().getItemAt(note).arm().toggle();
      return;
   }
   if (note >= 8 && note <= 15) {
      // Solo 1-8
      activeTrackBank().getItemAt(note - 8).solo().toggle();
      return;
   }
   if (note >= 16 && note <= 23) {
      // Mute 1-8
      activeTrackBank().getItemAt(note - 16).mute().toggle();
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
      case 40: // TRACK / I/O -> Toggle Track Mixer / Track Inspector I/O Panel
         if (currentMode === MODE_MIXER || isShiftPressed) {
            safeCall(application, "toggleInspector", "Toggle Track Inspector / I/O Panel");
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Volume / Pan)");
            updateModeLEDs();
            refreshDisplayText();
            refreshFaders();
         }
         flashLed(40, 150);
         break;

      case 41: // SEND -> 3-State Send Mode: 1st Press (Sends 1-8) -> 2nd Press (Sends 9-16) -> 3rd Press (Exit Send Mode)
         if (currentMode !== MODE_SENDS) {
            currentMode = MODE_SENDS;
            sendBankPage = 0;
            host.showPopupNotification("Mode: Send Faders (Sends 1 - 8)");
         } else if (sendBankPage === 0) {
            sendBankPage = 1;
            host.showPopupNotification("Mode: Send Faders (Sends 9 - 16)");
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
         }
         updateModeLEDs();
         refreshDisplayText();
         refreshFaders();
         break;

      case 42: // PAN -> toggle TOOL_DEVICE_NAME Gain/Pan control (see isToolVolumeMode)
         currentMode = MODE_MIXER;
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
         updateModeLEDs();
         refreshDisplayText();
         refreshFaders();
         break;

      case 43: // PLUG-IN / DEVICE -> toggle into Device mode, jumping to the
               // first device on the selected track and opening its panel
               // (does NOT touch the expanded device view - that's CTRL
               // long-press, see the CTRL block in onMidi). Pressing again
               // while already in Device mode exits back to Mixer mode.
               // Hold + jog wheel steps through devices instead (see
               // isPluginHeld).
         if (currentMode !== MODE_DEVICE) {
            currentMode = MODE_DEVICE;
            cursorDevice.selectFirst();
            cursorDevice.isWindowOpen().set(true);
            host.showPopupNotification("Device: First Plugin");
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Track Volume / Pan)");
         }
         updateModeLEDs();
         refreshDisplayText();
         refreshFaders();
         break;

      case 44: // PAGE PREV / EQ -> Focus EQ / Prev Parameter Page
         if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
         } else {
            try {
               cursorDevice.selectFirstInKeyTrack();
            } catch (e) {
               println("Warning: selectFirstInKeyTrack() not available: " + e);
            }
            host.showPopupNotification("Device: EQ / Primary FX");
         }
         break;

      case 45: // PAGE NEXT / INST -> Focus Instrument / Next Parameter Page
         if (currentMode === MODE_DEVICE) {
            remoteControls.selectNextPage(true);
            host.showPopupNotification("Device Page Next");
         } else {
            try {
               cursorTrack.selectFirst();
            } catch (e) {
               println("Warning: selectFirst() not available: " + e);
            }
            host.showPopupNotification("Track Instrument Selected");
         }
         break;

      case 46: // BANK PREV (<) -> jump to bank 0 with SHIFT, else page back
         if (isShiftPressed) {
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
         refreshFaders();
         break;

      case 47: // BANK NEXT (>) -> jump to last bank with SHIFT, else page forward
         if (isShiftPressed) {
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
         refreshFaders();
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
               transport.tempo().incRaw(isAltPressed ? -0.1 : -1.0);
            }
         } else if (isShiftPressed) {
            activeTrackBank().scrollPosition().set(0);
            host.showPopupNotification("Jump to First Channel");
         } else {
            activeTrackBank().scrollBackwards();
            host.showPopupNotification("Nudge Channel Left");
         }
         refreshDisplayText();
         refreshFaders();
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
               transport.tempo().incRaw(isAltPressed ? 0.1 : 1.0);
            }
         } else if (isShiftPressed) {
            var maxOffsetCh = Math.max(0, activeTrackBank().itemCount().get() - 8);
            activeTrackBank().scrollPosition().set(maxOffsetCh);
            host.showPopupNotification("Jump to Last Channel");
         } else {
            activeTrackBank().scrollForwards();
            host.showPopupNotification("Nudge Channel Right");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      case 50: // FLIP -> Swap Faders and Encoders
         isFlipped = !isFlipped;
         midiOut.sendMidi(0x90, 50, isFlipped ? 127 : 0);
         host.showPopupNotification("Fader Flip: " + (isFlipped ? "ON" : "OFF"));
         refreshFaders();
         break;

      case 51: // RETURNS -> swap the 8 channel strips to/from the Return Tracks bank
         isViewingReturns = !isViewingReturns;
         midiOut.sendMidi(0x90, 51, isViewingReturns ? 127 : 0);
         host.showPopupNotification(isViewingReturns ? "Viewing Return Tracks" : "Viewing Tracks");
         refreshChannelStripLEDs();
         if (currentMode === MODE_MIXER) {
            refreshDisplayText();
            refreshFaders();
         }
         break;

      // Note 52 is the generic MCU "Name/Value display" toggle - no
      // meaningful equivalent surfaced in Bitwig's API, left unbound.

      // Note 53 (SMPTE/BEATS) has no equivalent surfaced in Bitwig's
      // Controller API (no time-display-format toggle found on Transport),
      // so it's left unbound rather than guessing an action string.

      // F1-F8 (notes 54-61) and F9-F16 (notes 62-69): Ableton's own driver
      // no-ops on all of these (SoftwareController.handle_function_key_switch_ids
      // is a no-op), and the Midiplus manual confirms "the other buttons
      // with no label are not available in Live" - so they're intentionally
      // left unbound here rather than guessing fictional behavior for them.

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
            safeCall(application, "toggleAutomationEditor", "Toggle Automation Editor Panel");
         } else {
            safeCall(application, "toggleNoteEditor", "Toggle Detail Editor Panel");
         }
         break;

      case 79: // REDO
         application.redo();
         host.showPopupNotification("Redo");
         break;

      case 80: // B.T.A. (Back To Arrangement)
         for (var btaIdx = 0; btaIdx < 8; btaIdx++) {
            trackBank.getItemAt(btaIdx).returnToArrangement();
         }
         cursorTrack.returnToArrangement();
         host.showPopupNotification("Back To Arrangement");
         break;

      // Note 81 (DRAW) has no equivalent anywhere in Bitwig's Controller API
      // (no "draw mode" concept exists), so it's left unbound.

      case 82: // MARKER -> Add Cue Marker at Playhead
         transport.addCueMarkerAtPlaybackPosition();
         host.showPopupNotification("Add Cue Marker at Playhead");
         break;

      case 83: // FOLLOW
         if (isShiftPressed) {
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
         refreshFaders();
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
         refreshFaders();
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

// Update Mode Assignment LEDs
function updateModeLEDs() {
   // Note 40 (TRACK/IO) isn't handled here - see flashLed() in case 40.
   midiOut.sendMidi(0x90, 41, currentMode === MODE_SENDS ? 127 : 0); // SEND LED
   midiOut.sendMidi(0x90, 42, isToolVolumeMode ? 127 : 0); // PAN LED - lit while Tool Gain/Pan mode is active
   midiOut.sendMidi(0x90, 43, currentMode === MODE_DEVICE ? 127 : 0); // PLUG-IN LED
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

// Refresh Motorized Faders upon Flip or Mode Change
function refreshFaders() {
   for (var i = 0; i < 8; i++) {
      if (currentMode === MODE_SENDS) {
         var sendIdx = (sendBankPage * 8) + i;
         sendPitchBend(i, cursorTrack.sendBank().getItemAt(sendIdx).value().get());
      } else if (!isFlipped) {
         if (currentMode === MODE_MIXER && isToolVolumeMode) {
            var gainParam = getToolParam(i, 0);
            sendPitchBend(i, gainParam ? gainParam.value().get() : 0);
         } else {
            sendPitchBend(i, activeTrackBank().getItemAt(i).volume().value().get());
         }
      } else if (currentMode === MODE_DEVICE) {
         sendPitchBend(i, remoteControls.getParameter(i).value().get());
      } else {
         if (isToolVolumeMode) {
            var panParam = getToolParam(i, 1);
            sendPitchBend(i, panParam ? panParam.value().get() : 0.5);
         } else {
            sendPitchBend(i, activeTrackBank().getItemAt(i).pan().value().get());
         }
      }
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

// Helper: Send MCU Pitchbend Message (14-bit)
function sendPitchBend(channel, normalizedValue) {
   if (normalizedValue === undefined || normalizedValue === null) normalizedValue = 0;
   var val14 = Math.round(normalizedValue * 16383);
   val14 = Math.max(0, Math.min(16383, val14));

   var lsb = val14 & 0x7F;
   var msb = (val14 >> 7) & 0x7F;

   midiOut.sendMidi(0xE0 + channel, lsb, msb);
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

function exit() {
   println("Midiplus UP Controller Script Exited.");
}
