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
var currentMode = MODE_MIXER;
var sendBankPage = 0; // 0 = Sends 1-8, 1 = Sends 9-16
var isFlipped = false;

// Hardware Modifier States (note numbers confirmed against Ableton's own
// MackieControl driver - see file header)
var isShiftPressed = false;   // Note 70
var isOptionPressed = false;  // Note 71
var isControlPressed = false; // Note 72
var isAltPressed = false;     // Note 73

// ZOOM (100) and SCRUB (101) are TOGGLE buttons in the real protocol (press
// to flip state, not held-while-down like SHIFT/OPTION/CTRL/ALT).
var isZoomToggled = false;
var isScrubToggled = false;

// RETURNS (note 51): swap the 8 channel strips between the main track bank
// and the effect ("return") track bank.
var isViewingReturns = false;

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

// Display State Caches (8 channels x 7 chars)
var topRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];
var bottomRowText = ["       ", "       ", "       ", "       ", "       ", "       ", "       ", "       "];

// Display Refresh Throttle Flag
var displayNeedsUpdate = true;

function activeTrackBank() {
   return isViewingReturns ? effectTrackBank : trackBank;
}

function activeLedState() {
   return isViewingReturns ? returnsLedState : mainLedState;
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

   // Setup Observers for both the main track bank and the returns bank -
   // only the currently-active one (per isViewingReturns) writes to the
   // shared display caches / LEDs.
   setupChannelStripObservers(trackBank, mainLedState, false);
   setupChannelStripObservers(effectTrackBank, returnsLedState, true);

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

         // Track Name Observer
         track.name().addValueObserver(function (name) {
            if (currentMode === MODE_MIXER && isViewingReturns === isReturnsBank) {
               topRowText[index] = formatString(name, 7);
               displayNeedsUpdate = true;
            }
         });

         // Track Volume Observer
         track.volume().value().addValueObserver(function (value) {
            if (currentMode === MODE_MIXER && !isFlipped && isViewingReturns === isReturnsBank) {
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
            // Standard Mixer Fader -> Track Volume
            activeTrackBank().getItemAt(channel).volume().set(normalizedVal);
         } else {
            // Flipped Fader behavior
            if (currentMode === MODE_MIXER) {
               activeTrackBank().getItemAt(channel).pan().set(normalizedVal);
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
            activeTrackBank().getItemAt(encoderIndex).pan().inc(delta, resolution);
         } else if (currentMode === MODE_SENDS) {
            var encSendIdx = (sendBankPage * 8) + encoderIndex;
            cursorTrack.sendBank().getItemAt(encSendIdx).inc(delta, resolution);
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.getParameter(encoderIndex).inc(delta, resolution);
         }
      } else {
         // Flipped Encoder -> Track Volume
         activeTrackBank().getItemAt(encoderIndex).volume().inc(delta, resolution);
      }
      return;
   }

   // 3. Jog / Scroll Wheel (CC 60 on Channel 1: 0xB0)
   // Behavior pattern follows Ableton's real MackieControl.Transport
   // handle_jog_wheel_rotation(): CTRL = tempo nudge, ALT = quarter step,
   // SCRUB toggle = fine scrub vs coarse jump, doubled while playing.
   if (msgType === 0xB0 && data1 === 60) {
      // Same sign-magnitude fix as the encoders above
      var backwards = data2 >= 64;
      var rawStep = backwards ? -(data2 - 64) : data2;

      if (isControlPressed) {
         // CTRL + Jog Wheel: Nudge Tempo (fine with ALT held)
         var tempoStep = isAltPressed ? 0.1 : 1.0;
         transport.tempo().incRaw(rawStep * tempoStep);
         return;
      }

      var step = Math.max(1.0, Math.abs(rawStep) / 2.0);
      if (transport.isPlaying().get()) {
         step *= 4.0;
      }
      if (isAltPressed) {
         step /= 4.0;
      }
      if (backwards) {
         step = -step;
      }

      if (isScrubToggled) {
         // Fine scrub - small fixed increments regardless of computed step
         transport.incPosition(backwards ? -0.05 : 0.05, false);
      } else {
         transport.incPosition(step * 0.25, true);
      }
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

      // CTRL Button (Note 72)
      if (data1 === 72) {
         isControlPressed = isPressed;
         midiOut.sendMidi(0x90, 72, isControlPressed ? 127 : 0);
         return;
      }

      // ALT Button (Note 73)
      if (data1 === 73) {
         isAltPressed = isPressed;
         midiOut.sendMidi(0x90, 73, isAltPressed ? 127 : 0);
         return;
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
      // Select 1-8
      activeTrackBank().getItemAt(note - 24).selectInMixer();
      cursorTrack.selectChannel(activeTrackBank().getItemAt(note - 24));
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

      case 46: // BANK PREV (<) -> jump to bank 0 with SHIFT, else page back
         if (isShiftPressed) {
            activeTrackBank().scrollPosition().set(0);
            host.showPopupNotification("Jump to First Bank");
         } else if (currentMode === MODE_DEVICE) {
            remoteControls.selectPreviousPage(true);
            host.showPopupNotification("Device Page Previous");
         } else {
            activeTrackBank().selectPreviousPage();
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
            activeTrackBank().selectNextPage();
            host.showPopupNotification("Track Bank Right");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      case 48: // CHANNEL PREV (<) -> nudge 1 channel back, or jump to first with SHIFT
         if (isShiftPressed) {
            activeTrackBank().scrollPosition().set(0);
            host.showPopupNotification("Jump to First Channel");
         } else {
            activeTrackBank().scrollBackwards();
            host.showPopupNotification("Nudge Channel Left");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      case 49: // CHANNEL NEXT (>) -> nudge 1 channel forward, or jump to last with SHIFT
         if (isShiftPressed) {
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

      case 87: // PUNCH IN (CTRL+PI: set loop start from playhead)
         if (isControlPressed) {
            var oldLoopStart = transport.arrangerLoopStart().get();
            var newLoopStart = transport.getPosition().get();
            transport.arrangerLoopStart().set(newLoopStart);
            transport.arrangerLoopDuration().set(transport.arrangerLoopDuration().get() + (oldLoopStart - newLoopStart));
            host.showPopupNotification("Set Loop Start from Playhead");
         } else {
            transport.isPunchInEnabled().toggle();
            host.showPopupNotification("Toggle Punch-In Recording");
         }
         break;

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

      case 90: // END -> Jump Playhead to end of the arranger loop (approximates
               // Ableton's "last event in the project", which Bitwig doesn't
               // expose directly)
         transport.getPosition().set(transport.arrangerLoopDuration().get());
         host.showPopupNotification("Jump to Loop End");
         break;

      // Cursor Arrows (96-99): navigate normally, or zoom while ZOOM (100)
      // is toggled on - matches Ableton's Transport.__on_cursor_*_pressed()
      // pattern (zoom vs scroll depending on the zoom-toggle state).
      case 96: // LEFT ARROW
         if (isZoomToggled) {
            safeCall(application, "zoomOut", "Zoom Out (Horizontal)");
         } else {
            safeCall(application, "arrowKeyLeft");
         }
         refreshDisplayText();
         refreshFaders();
         break;

      case 97: // RIGHT ARROW
         if (isZoomToggled) {
            safeCall(application, "zoomIn", "Zoom In (Horizontal)");
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
         sendPitchBend(i, activeTrackBank().getItemAt(i).volume().value().get());
      } else {
         if (currentMode === MODE_MIXER) {
            sendPitchBend(i, activeTrackBank().getItemAt(i).pan().value().get());
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
         var track = activeTrackBank().getItemAt(i);
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
