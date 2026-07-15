// Reality Engine · services/sensors — the ONE permission-gated sensor pipeline.
// Every mode gets its sensors from here so permission handling (especially iOS's
// user-gesture requirement) lives in exactly one place, and the shell can force-release
// everything on teardown as a safety net.
//
// iOS rules encoded here:
//  - DeviceMotion/DeviceOrientation need `requestPermission()` called from a user gesture.
//  - getUserMedia (camera/mic) must also be triggered from a gesture the first time.
//  → modes call the request* methods from their own "Enable" button handlers.

const motionListeners = new Set();
const orientationListeners = new Set();
const activeStreams = new Set();
const geoWatchIds = new Set();

let motionAttached = false;
let orientationAttached = false;

function fanoutMotion(e) { for (const fn of motionListeners) { try { fn(e); } catch (err) { console.error(err); } } }
function fanoutOrientation(e) { for (const fn of orientationListeners) { try { fn(e); } catch (err) { console.error(err); } } }

async function gestureGatedPermission(EventClass) {
  // iOS 13+ exposes requestPermission and requires a user gesture; elsewhere it's absent.
  if (typeof EventClass !== "undefined" && typeof EventClass.requestPermission === "function") {
    const res = await EventClass.requestPermission();
    if (res !== "granted") throw new Error("Permission denied");
  }
}

export const sensors = {
  // ---- motion (DeviceMotion: accelerometer + gyro) ----
  async requestMotion() {
    await gestureGatedPermission(typeof DeviceMotionEvent !== "undefined" ? DeviceMotionEvent : undefined);
    return true;
  },
  onMotion(fn) {
    motionListeners.add(fn);
    if (!motionAttached) { window.addEventListener("devicemotion", fanoutMotion); motionAttached = true; }
    return () => {
      motionListeners.delete(fn);
      if (motionListeners.size === 0 && motionAttached) {
        window.removeEventListener("devicemotion", fanoutMotion); motionAttached = false;
      }
    };
  },

  // ---- orientation (DeviceOrientation: compass/attitude) ----
  async requestOrientation() {
    await gestureGatedPermission(typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : undefined);
    return true;
  },
  onOrientation(fn) {
    orientationListeners.add(fn);
    if (!orientationAttached) { window.addEventListener("deviceorientation", fanoutOrientation); orientationAttached = true; }
    return () => {
      orientationListeners.delete(fn);
      if (orientationListeners.size === 0 && orientationAttached) {
        window.removeEventListener("deviceorientation", fanoutOrientation); orientationAttached = false;
      }
    };
  },

  // ---- camera ----
  async requestCamera(constraints = { video: { facingMode: "environment" }, audio: false }) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    activeStreams.add(stream);
    return stream;
  },

  // ---- microphone ----
  async requestMic(constraints = { audio: true, video: false }) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    activeStreams.add(stream);
    return stream;
  },

  releaseStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    activeStreams.delete(stream);
  },

  // ---- GPS ----
  getPosition(options = { enableHighAccuracy: true, timeout: 10000 }) {
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, options));
  },
  watchPosition(fn, onError, options = { enableHighAccuracy: true }) {
    const id = navigator.geolocation.watchPosition(fn, onError, options);
    geoWatchIds.add(id);
    return () => { navigator.geolocation.clearWatch(id); geoWatchIds.delete(id); };
  },

  // ---- shell safety net: called on every mode teardown ----
  releaseAll() {
    for (const stream of activeStreams) for (const track of stream.getTracks()) track.stop();
    activeStreams.clear();
    for (const id of geoWatchIds) navigator.geolocation.clearWatch(id);
    geoWatchIds.clear();
    motionListeners.clear();
    orientationListeners.clear();
    if (motionAttached) { window.removeEventListener("devicemotion", fanoutMotion); motionAttached = false; }
    if (orientationAttached) { window.removeEventListener("deviceorientation", fanoutOrientation); orientationAttached = false; }
  },
};

export default sensors;
