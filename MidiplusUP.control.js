// Midiplus UP Bitwig Controller Script (MCU Engine + Ableton Live Overlay Template)
// Author: Antigravity
// API Version: 25

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
var currentMode = MODE_MIXER;
var sendBankPage = 0; // 0 = Sends 1-8, 1 = Sends 9-16
var isFlipped = false;

// Hardware Modifier States
var isShiftPressed = false;

// Safely invoke a named Bitwig application action.
// getAction() can return null if the action isn't available in the
// current context (e.g. "Zoom Arranger to Selection" with no active
// time selection) - this avoids crashing the whole script in that case.
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

// Try several possible real getter/method names for a boolean toggle value
// (Bitwig API method names for panel visibility aren't always the same as
// the display name in Settings > Shortcuts). Falls back to invokeAction()
// with the given action name if none of the direct methods exist.
function toggleBooleanCandidate(obj, methodNames, fallbackActionName, popupText) {
   for (var i = 0; i < methodNames.length; i++) {
      var m = methodNames[i];
      try {
         if (typeof obj[m] === "function") {
            var val = obj[m]();
            if (val && typeof val.toggle === "function") {
               val.toggle();
               if (popupText) { host.showPopupNotification(popupText); }
               println("Used direct method: " + m + "()");
               return true;
            }
         }
      } catch (e) {
         // try next candidate
      }
   }
   println("No direct method found among: " + methodNames.join(", ") + " - falling back to action");
   return invokeAction(fallbackActionName, popupText);
}

// Try a list of candidates in order (mix of direct boolean-toggle methods on
// different objects, or getAction() names) - stops at first success.
// Each candidate is either {obj, method} for a direct SettableBooleanValue
// getter, or {action} for an application action name.
function tryCandidates(candidates, popupText) {
   for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      try {
         if (c.method) {
            if (typeof c.obj[c.method] === "function") {
               var val = c.obj[c.method]();
               if (val && typeof val.toggle === "function") {
                  val.toggle();
                  if (popupText) { host.showPopupNotification(popupText); }
                  println("Used direct method: " + c.method + "()");
                  return true;
               }
            }
         } else if (c.action) {
            var action = application.getAction(c.action);
            if (action) {
               action.invoke();
               if (popupText) { host.showPopupNotification(popupText); }
               println("Used action: \"" + c.action + "\"");
               return true;
            }
         }
      } catch (e) {
         // try next candidate
      }
   }
   println("No working candidate found for: " + popupText);
   host.showPopupNotification((popupText || "Action") + " (not available)");
   return false;
}

function invokeAction(actionName, popupText) {
   try {
      var action = application.getAction(actionName);
      if (action === null || action === undefined) {
         println("Action not available right now: " + actionName);
         host.showPopupNotification((popupText || actionName) + " (not available right now)");
         return false;
      }
      action.invoke();
      if (popupText) {
         host.showPopupNotification(popupText);
      }
      return true;
   } catch (e) {
      println("Error invoking action \"" + actionName + "\": " + e);
      return false;
   }
}
var isOptionPressed = false;
var isAltPressed = false;
var isZoomPressed = false;
var isChannelPressed = false;

// Host Objects
var trackBank = null;
var masterTrack = null;
var cursorTrack = null;
var cursorDevice = null;
var remoteControls = null;
var transport = null;
var application = null;
var arranger = null;
var midiOut = null;

// Display State Caches (8 channels x 7 chars)
var topRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];
var bottomRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];

// Display Refresh Throttle Flag
var displayNeedsUpdate = true;

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

   // Initialize Master Track
   masterTrack = host.createMasterTrack(0);

   // Initialize Cursor Track & Send Bank (16 Send slots for focused track)
   cursorTrack = host.createCursorTrack("MIDIPLUS_CURSOR_TRACK", "Cursor Track", 16, 0, true);
   cursorDevice = cursorTrack.createCursorDevice("MIDIPLUS_CURSOR_DEVICE", "Cursor Device", 0, CursorDeviceFollowMode.FIRST_INSTRUMENT_OR_DEVICE);
   
   // Remote Controls (8 Macros for selected device)
   remoteControls = cursorDevice.createCursorRemoteControlsPage(8);

   // Transport & Application Controls
   transport = host.createTransport();
   application = host.createApplication();
   arranger = host.createArranger();

   // Setup Observers for Main 8 Tracks
   for (var i = 0; i < 8; i++) {
      (function (index) {
         var track = trackBank.getItemAt(index);

         // Track Name Observer
         track.name().addValueObserver(function (name) {
            if (currentMode === MODE_MIXER) {
               topRowText[index] = formatString(name, 7);
               displayNeedsUpdate = true;
            }
         });

         // Track Volume Observer
         track.volume().value().addValueObserver(function (value) {
            if (currentMode === MODE_MIXER && !isFlipped) {
               sendPitchBend(index, value);
            }
         });

         track.volume().displayedValue().addValueObserver(function (dispVal) {
            if (currentMode === MODE_MIXER && !isFlipped) {
               bottomRowText[index] = formatString(dispVal, 7);
               displayNeedsUpdate = true;
            }
         });

         // Track Pan Observer
         track.pan().value().addValueObserver(function (value) {
            if (currentMode === MODE_MIXER && isFlipped) {
               sendPitchBend(index, value);
            }
         });

         // Track Button State Observers (LED Feedback)
         track.arm().addValueObserver(function (isArmed) {
            midiOut.sendMidi(0x90, 0 + index, isArmed ? 127 : 0); // Rec Arm LED
         });

         track.solo().addValueObserver(function (isSoloed) {
            midiOut.sendMidi(0x90, 8 + index, isSoloed ? 127 : 0); // Solo LED
         });

         track.mute().addValueObserver(function (isMuted) {
            midiOut.sendMidi(0x90, 16 + index, isMuted ? 127 : 0); // Mute LED
         });

         track.addIsSelectedInMixerObserver(function (isSelected) {
            midiOut.sendMidi(0x90, 24 + index, isSelected ? 127 : 0); // Select LED
         });

      })(i);
   }

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
                  topRowText[channelIdx] = formatString(sendName || ("Send " + (sendIdx + 1)), 7);
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
               topRowText[paramIndex] = formatString(name, 7);
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
      if (isChannelPressed) {
         host.showPopupNotification("Selected Track: " + trackName);
      }
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
            // Standard Mixer Fader -> Track Volume
            trackBank.getItemAt(channel).volume().set(normalizedVal);
         } else {
            // Flipped Fader behavior
            if (currentMode === MODE_MIXER) {
               trackBank.getItemAt(channel).pan().set(normalizedVal);
            } else if (currentMode === MODE_DEVICE) {
               remoteControls.getParameter(channel).set(normalizedVal);
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
            trackBank.getItemAt(encoderIndex).pan().inc(delta, resolution);
         } else if (currentMode === MODE_SENDS) {
            var encSendIdx = (sendBankPage * 8) + encoderIndex;
            cursorTrack.sendBank().getItemAt(encSendIdx).inc(delta, resolution);
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.getParameter(encoderIndex).inc(delta, resolution);
         }
      } else {
         // Flipped Encoder -> Track Volume
         trackBank.getItemAt(encoderIndex).volume().inc(delta, resolution);
      }
      return;
   }

   // 3. Jog / Scroll Wheel (CC 60 on Channel 1: 0xB0)
   if (msgType === 0xB0 && data1 === 60) {
      // Same sign-magnitude fix as the encoders above
      var jogDelta = data2 < 64 ? data2 : -(data2 - 64);

      if (isChannelPressed) {
         // CHANNEL + Jog Wheel: Scroll / Select Active Track Directly!
         if (jogDelta > 0) {
            cursorTrack.selectNext();
         } else {
            cursorTrack.selectPrevious();
         }
         refreshDisplayText();
         refreshFaders();
         return;
      } else if (isAltPressed || isZoomPressed) {
         // ALT or ZOOM held + Jog Wheel: Zoom Timeline In / Out
         if (jogDelta > 0) {
            invokeAction("Zoom In Arranger");
         } else {
            invokeAction("Zoom Out Arranger");
         }
      } else if (isShiftPressed) {
         // SHIFT + Jog Wheel: Mark / Adjust Region End (Expand/Shrink Arranger Selection)
         transport.arrangerLoopDuration().inc(jogDelta, 128);
         host.showPopupNotification("Mark Time Region (Loop Duration)");
      } else if (isOptionPressed) {
         // OPTION + Jog Wheel: Move Section Start Position
         transport.arrangerLoopStart().inc(jogDelta, 128);
         host.showPopupNotification("Move Region Start");
      } else {
         // Standard Jog Wheel: Move Playhead
         transport.incPosition(jogDelta * 0.25, true);
      }
      return;
   }

   // 4. Modifier Buttons Press & Release (Note On: 0x90, Note Off: 0x80)
   if (msgType === 0x90 || msgType === 0x80) {
      var isPressed = (msgType === 0x90 && data2 > 0);
      if (isPressed) {
         println("RAW Note-On received - Note: " + data1); // DEBUG: catches modifier buttons too
      }

      // SHIFT Button (Note 54 or Note 70)
      if (data1 === 54 || data1 === 70) {
         isShiftPressed = isPressed;
         midiOut.sendMidi(0x90, data1, isShiftPressed ? 127 : 0);
         return;
      }

      // OPTION Button (Note 71)
      if (data1 === 71) {
         isOptionPressed = isPressed;
         midiOut.sendMidi(0x90, 71, isOptionPressed ? 127 : 0);
         return;
      }

      // ALT Button (Note 73 or Note 57)
      if (data1 === 73 || data1 === 57) {
         isAltPressed = isPressed;
         midiOut.sendMidi(0x90, data1, isAltPressed ? 127 : 0);
         return;
      }

      // ZOOM Button (Note 100, Note 85)
      if (data1 === 100 || data1 === 85) {
         isZoomPressed = isPressed;
         midiOut.sendMidi(0x90, data1, isZoomPressed ? 127 : 0);
         if (isPressed) {
            if (isShiftPressed) {
               invokeAction("Zoom Arranger to Fit", "Zoom To Fit All Tracks");
            } else {
               invokeAction("Zoom Arranger to Selection", "Zoom To Selected Region");
            }
         }
         return;
      }

      // CHAN / CHANNEL Button (Note 48, Note 49) - Track Modifier
      // BUG FIX: this was missing a `return`, unlike every other modifier
      // (SHIFT/OPTION/ALT/ZOOM) above. Without it, every CHANNEL press also
      // fell through into handleButtonPress(), which used to bind notes
      // 48/49 to "nudge track left/right" (case 48/49, now removed below
      // since it's identical to the SHIFT+BANK PREV/NEXT nudge on notes
      // 46/47) - so holding CHANNEL was simultaneously toggling the modifier
      // AND nudging the track bank on every press.
      if (data1 === 48 || data1 === 49) {
         isChannelPressed = isPressed;
         midiOut.sendMidi(0x90, data1, isChannelPressed ? 127 : 0);
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
   // Track Channel Strip Buttons (0 - 31)
   if (note >= 0 && note <= 7) {
      // Rec Arm 1-8
      trackBank.getItemAt(note).arm().toggle();
      return;
   }
   if (note >= 8 && note <= 15) {
      // Solo 1-8
      trackBank.getItemAt(note - 8).solo().toggle();
      return;
   }
   if (note >= 16 && note <= 23) {
      // Mute 1-8
      trackBank.getItemAt(note - 16).mute().toggle();
      return;
   }
   if (note >= 24 && note <= 31) {
      // Select 1-8
      trackBank.getItemAt(note - 24).selectInMixer();
      cursorTrack.selectChannel(trackBank.getItemAt(note - 24));
      return;
   }
   if (note >= 32 && note <= 39) {
      // Encoder Push Click (Reset Parameter)
      var encIdx = note - 32;
      if (currentMode === MODE_MIXER) {
         trackBank.getItemAt(encIdx).pan().reset();
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
            invokeAction("Toggle Inspector Panel", "Toggle Track Inspector / I/O Panel");
         } else {
            currentMode = MODE_MIXER;
            host.showPopupNotification("Mode: Mixer (Volume / Pan)");
            updateModeLEDs();
            refreshDisplayText();
            refreshFaders();
         }
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

      case 42: // PAN -> Pan Mode
         currentMode = MODE_MIXER;
         host.showPopupNotification("Mode: Pan");
         updateModeLEDs();
         refreshDisplayText();
         refreshFaders();
         break;

      case 43: // PLUG-IN / DEVICE -> Cycle Available Plugins on Track
         if (currentMode === MODE_DEVICE) {
            if (isShiftPressed) {
               cursorDevice.selectPrevious();
            } else {
               cursorDevice.selectNext();
            }
         } else {
            currentMode = MODE_DEVICE;
            host.showPopupNotification("Mode: Device Remote Controls (Macros)");
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

      case 46: // BANK PREV (<)
         if (isShiftPressed) {
            trackBank.scrollBackwards(); // Shift + Bank = Nudge 1 track left
            host.showPopupNotification("Nudge Track Left");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
         } else {
            trackBank.selectPreviousPage();
            host.showPopupNotification("Track Bank Left");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      case 47: // BANK NEXT (>)
         if (isShiftPressed) {
            trackBank.scrollForwards(); // Shift + Bank = Nudge 1 track right
            host.showPopupNotification("Nudge Track Right");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectNextPage(true);
            host.showPopupNotification("Device Page Next");
         } else {
            trackBank.selectNextPage();
            host.showPopupNotification("Track Bank Right");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      // Notes 48/49 used to have a duplicate "CHAN PREV/NEXT" nudge case
      // here, but they're now consumed as the CHANNEL modifier (with a
      // `return`) above and are unreachable in this switch. The same nudge
      // is already available via SHIFT + BANK PREV/NEXT (notes 46/47).

      case 50: // FLIP -> Swap Faders and Encoders
         isFlipped = !isFlipped;
         midiOut.sendMidi(0x90, 50, isFlipped ? 127 : 0);
         host.showPopupNotification("Fader Flip: " + (isFlipped ? "ON" : "OFF"));
         refreshFaders();
         break;

      case 51: // DETAIL -> Toggle Detail Editor / Automation (CLIP/FX is the separate note 75)
      case 53: // DETAIL alternate note
         if (isShiftPressed) {
            invokeAction("Show Automation Editor", "Toggle Automation Editor Panel");
         } else {
            safeCall(application, "toggleNoteEditor", "Toggle Detail Editor Panel");
         }
         break;

      case 52: // BROWSER -> Hide/Show Browser (Draw and Duplicate were previously
               // incorrectly guessed onto this same note - laut Handbuch sind
               // BROWSER und DRAW getrennte Tasten, DRAW-Note noch nicht bestätigt)
         invokeAction("Toggle Browser Panel", "Toggle Browser");
         break;

      case 75: // CLIP/FX -> Toggle Device / Clip View (confirmed note via debug log)
         tryCandidates([
            { obj: arranger, method: "isDevicesVisible" },
            { obj: arranger, method: "getDevicesVisible" },
            { obj: arranger, method: "isClipLauncherVisible" },
            { action: "Show Device Panel" },
            { action: "Toggle Device Panel" },
            { action: "Toggle Clip Editor Panel" },
            { action: "Toggle Detail Editor Panel" }
         ], "Toggle Device / Clip View");
         break;

      case 58: // B.T.A. (Back To Arrangement)
         for (var btaIdx = 0; btaIdx < 8; btaIdx++) {
            trackBank.getItemAt(btaIdx).returnToArrangement();
         }
         cursorTrack.returnToArrangement();
         host.showPopupNotification("Back To Arrangement");
         break;

      case 59: // S CLEAR (Solo Clear) -> If SHIFT held, do M CLEAR (Mute Clear)
      case 80:
         if (isShiftPressed) {
            for (var mIdx1 = 0; mIdx1 < 8; mIdx1++) {
               trackBank.getItemAt(mIdx1).mute().set(false);
            }
            host.showPopupNotification("Mute Clear (Unmute All Tracks)");
         } else {
            for (var sIdx = 0; sIdx < 8; sIdx++) {
               trackBank.getItemAt(sIdx).solo().set(false);
            }
            host.showPopupNotification("Solo Clear (Unsolo All Tracks)");
         }
         break;

      case 81: // M CLEAR (Mute Clear) -> Unmute all tracks in Bitwig
         for (var mIdx2 = 0; mIdx2 < 8; mIdx2++) {
            trackBank.getItemAt(mIdx2).mute().set(false);
         }
         host.showPopupNotification("Mute Clear (Unmute All Tracks)");
         break;

      case 76: // UNDO (this hardware sends this note for the UNDO button)
         application.undo();
         host.showPopupNotification("Undo");
         break;

      case 79: // REDO (this hardware sends this note for the REDO button)
         application.redo();
         host.showPopupNotification("Redo");
         break;

      case 60: // UNDO (or REDO if SHIFT is held) - alternate/legacy mapping, kept as fallback
         if (isShiftPressed) {
            application.redo();
            host.showPopupNotification("Redo");
         } else {
            application.undo();
            host.showPopupNotification("Undo");
         }
         break;

      case 61: // REDO -> Redo in Bitwig - alternate/legacy mapping, kept as fallback
         application.redo();
         host.showPopupNotification("Redo");
         break;

      case 62: // FOLLOW (this hardware sends this note for the FOLLOW button)
      case 83: // MASTER alternative note
         if (isShiftPressed) {
            transport.isMetronomeEnabled().toggle();
            host.showPopupNotification("Toggle Metronome");
         } else {
            invokeAction("View follows playhead", "Toggle Follow Playhead (Auto-Scroll)");
         }
         break;

      case 64: // PUNCH IN
         transport.isPunchInEnabled().toggle();
         host.showPopupNotification("Toggle Punch-In Recording");
         break;

      case 65: // PUNCH OUT
         transport.isPunchOutEnabled().toggle();
         host.showPopupNotification("Toggle Punch-Out Recording");
         break;

      case 82: // HOME -> Jump Playhead to Beginning of Project (1.1.1)
         transport.getPosition().set(0);
         host.showPopupNotification("Jump to Start (Home)");
         break;

      // BUG: case 85 (END) below is currently unreachable - note 85 is also
      // claimed as an alternate ZOOM note in onMidi() (search "isZoomPressed"),
      // which returns before handleButtonPress() is ever called. Confirm the
      // real END note via the "RAW Note-On received" debug log and either
      // remap ZOOM's alternate note or END's note once known.
      case 85: // END -> Jump Playhead to End of Loop Region
         transport.getPosition().set(transport.arrangerLoopDuration().get());
         host.showPopupNotification("Jump to Loop End");
         break;

      // Session View / Clip Launcher Navigation Arrows (Left, Right, Up, Down)
      case 96: // LEFT ARROW -> Select Left Clip / Track
         safeCall(application, "arrowKeyLeft");
         refreshDisplayText();
         refreshFaders();
         break;

      case 97: // RIGHT ARROW -> Select Right Clip / Track
         safeCall(application, "arrowKeyRight");
         refreshDisplayText();
         refreshFaders();
         break;

      case 98: // UP ARROW -> Select Upper Clip / Scene
         safeCall(application, "arrowKeyUp");
         break;

      case 99: // DOWN ARROW -> Select Lower Clip / Scene
         safeCall(application, "arrowKeyDown");
         break;

      // Top 5 Unlabeled Quick-Access Buttons (F1 - F5): Dedicated MIDI / MPE Expression Quick-Keys
      // BUG: case 54 (F1) below is currently unreachable - note 54 is also
      // one of the two SHIFT notes in onMidi() (search "isShiftPressed"),
      // which returns before handleButtonPress() is ever called. Confirm F1's
      // real note via the "RAW Note-On received" debug log.
      case 54: // Top Button 1 (F1) -> Note Chance % Attribute
         safeCall(application, "toggleNoteEditor", "MIDI Note Expression: CHANCE %");
         break;
      case 55: // Top Button 2 (F2) -> Note Velocity Attribute
         safeCall(application, "toggleNoteEditor", "MIDI Note Expression: VELOCITY");
         break;
      case 56: // Top Button 3 (F3) -> MPE Pressure (Aftertouch)
         safeCall(application, "toggleNoteEditor", "MIDI MPE Expression: PRESSURE");
         break;
      // BUG: case 57 (F4) below is currently unreachable - note 57 is also
      // one of the two ALT notes in onMidi() (search "isAltPressed"), which
      // returns before handleButtonPress() is ever called. Confirm F4's real
      // note via the "RAW Note-On received" debug log.
      case 57: // Top Button 4 (F4) -> MPE Timbre / Slide (Y-Axis)
         safeCall(application, "toggleNoteEditor", "MIDI MPE Expression: TIMBRE / SLIDE");
         break;
      case 63: // Top Button 5 (F5) -> MPE Pitch Bend / Tuning
      case 67:
         safeCall(application, "toggleNoteEditor", "MIDI MPE Expression: PITCH BEND / TUNING");
         break;

      case 84: // possible SCRUB/alternate note (kept as fallback, unconfirmed)
      case 74: // SESS/ARR -> Toggle Clip Launcher / Arranger View (confirmed via debug log)
         toggleBooleanCandidate(
            arranger,
            ["isClipLauncherVisible", "getClipLauncherVisible", "clipLauncherVisible", "isClipLauncherSectionVisible"],
            "Toggle Clip Launcher",
            "Toggle Session / Arranger View"
         );
         break;

      // Jog Push / Bounce / Zoom Actions
      case 101: // JOG WHEEL PUSH
         if (isAltPressed || isOptionPressed || isZoomPressed) {
            invokeAction("Zoom Arranger to Selection", "Zoom To Selected Region");
         } else if (isShiftPressed) {
            invokeAction("Bounce In Place (Post-Fader)", "Bounce In Place");
         } else {
            invokeAction("Bounce\u2026", "Bounce Selected Time Region Window");
         }
         break;

      // Transport Buttons
      case 86: // LOOP
         transport.isArrangerLoopEnabled().toggle();
         break;
      case 89: // MARKER / BOUNCE -> Add Cue Marker at Playhead (Shift: Bounce)
         if (isShiftPressed) {
            invokeAction("Bounce\u2026", "Bounce Window");
         } else {
            invokeAction("Insert Cue Marker Here", "Add Cue Marker at Playhead");
         }
         break;
      case 91: // REWIND
         transport.rewind();
         break;
      case 92: // FAST FORWARD
         transport.fastForward();
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
   midiOut.sendMidi(0x90, 40, currentMode === MODE_MIXER ? 127 : 0); // TRACK LED
   midiOut.sendMidi(0x90, 41, currentMode === MODE_SENDS ? 127 : 0); // SEND LED
   midiOut.sendMidi(0x90, 42, currentMode === MODE_MIXER ? 127 : 0); // PAN LED
   midiOut.sendMidi(0x90, 43, currentMode === MODE_DEVICE ? 127 : 0); // PLUG-IN LED
}

// Refresh Motorized Faders upon Flip or Mode Change
function refreshFaders() {
   for (var i = 0; i < 8; i++) {
      if (currentMode === MODE_SENDS) {
         var sendIdx = (sendBankPage * 8) + i;
         sendPitchBend(i, cursorTrack.sendBank().getItemAt(sendIdx).value().get());
      } else if (!isFlipped) {
         sendPitchBend(i, trackBank.getItemAt(i).volume().value().get());
      } else {
         if (currentMode === MODE_MIXER) {
            sendPitchBend(i, trackBank.getItemAt(i).pan().value().get());
         } else if (currentMode === MODE_DEVICE) {
            sendPitchBend(i, remoteControls.getParameter(i).value().get());
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
         topRowText[i] = formatString(sendItem.name().get() || ("Send " + (sendIdx + 1)), 7);
         bottomRowText[i] = formatString(sendItem.displayedValue().get(), 7);
      } else if (currentMode === MODE_MIXER) {
         var track = trackBank.getItemAt(i);
         topRowText[i] = formatString(track.name().get(), 7);
         bottomRowText[i] = formatString(track.volume().displayedValue().get(), 7);
      } else if (currentMode === MODE_DEVICE) {
         var param = remoteControls.getParameter(i);
         topRowText[i] = formatString(param.name().get(), 7);
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

function onSysex(data) {
   // SysEx input handling if required
}

function exit() {
   println("Midiplus UP Controller Script Exited.");
}
