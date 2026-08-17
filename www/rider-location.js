/**
 * rider-location.js
 * Wraps @capacitor-community/background-geolocation.
 * Sends live position straight to Supabase (rider_location + rider_track),
 * NOT through GAS/Sheets — see architecture notes.
 *
 * Usage:
 *   RiderLocation.start(riderId, jobId, { supabaseUrl, supabaseKey });
 *   RiderLocation.stop();
 */
window.RiderLocation = (() => {
  let watcherId = null;
  let lastTrackWrite = 0; 
  let cfg = null;
  let lastLocation = null;     // most recent coords, kept fresh even while stationary
  let lastPingSent = 0;        // ms timestamp of the last upsert we actually sent
  let heartbeatTimer = null;   // setInterval handle for the stationary heartbeat
  let currentRiderId = null;

  const TRACK_INTERVAL_MS = 60_000; // matches rider_settings.track_interval_sec
  const PING_INTERVAL_MS  = 10_000; // matches rider_settings.ping_interval_sec

  async function upsertLocation(riderId, coords) {
    const body = {
      rider_id: riderId,
      lat: coords.latitude,
      lng: coords.longitude,
      heading: (coords.heading === undefined || coords.heading === null) ? null : coords.heading,
      speed: (coords.speed === undefined || coords.speed === null) ? null : coords.speed,
      accuracy: (coords.accuracy === undefined || coords.accuracy === null) ? null : coords.accuracy,
      updated_at: new Date().toISOString()
    };
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rider_location?on_conflict=rider_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.supabaseKey,
        "Authorization": "Bearer " + cfg.supabaseKey,
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(body)
    }).catch(function (err) { console.warn("[RiderLocation] ping network error", err); return null; });
    if (res && !res.ok) {
      const text = await res.text().catch(function () { return ""; });
      console.warn("[RiderLocation] ping HTTP error", res.status, text);
    }
    lastPingSent = Date.now();
  }

  async function insertTrackPoint(riderId, jobId, coords) {
    if (!jobId) return; // only log track while a job is active
    const body = {
      job_id: jobId,
      rider_id: riderId,
      lat: coords.latitude,
      lng: coords.longitude,
      recorded_at: new Date().toISOString()
    };
    await fetch(`${cfg.supabaseUrl}/rest/v1/rider_track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.supabaseKey,
        "Authorization": `Bearer ${cfg.supabaseKey}`
      },
      body: JSON.stringify(body)
    }).catch(err => console.warn("[RiderLocation] track write failed", err));
  }

  async function start(riderId, jobId, config) {
    cfg = config;
    // Defensive guard: if start() is ever called again while a watcher is
    // already running (e.g. a future code path calls it twice without an
    // intervening stop(), or start() is called again before a prior call's
    // addWatcher promise has resolved), the OLD watcher would otherwise be
    // silently orphaned — watcherId gets overwritten by the new one, so a
    // later stop() can only ever remove the LATEST watcher, leaving the
    // first one running (and draining battery/data) forever. Tear down any
    // existing watcher first so start() is always safe to call idempotently.
    if (watcherId) {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      try {
        const existing = window.Capacitor.Plugins.BackgroundGeolocation;
        await Promise.resolve(existing.removeWatcher({ id: watcherId })).catch(() => {});
      } catch (e) { /* best effort — proceed to start the new watcher regardless */ }
      watcherId = null;
    }

    // window.Capacitor.registerPlugin does NOT exist for plain <script>-tag
    // (non-bundled/non-ESM) apps like this one — registerPlugin is only an
    // ES module export meant for bundlers (webpack/rollup). The legacy
    // window.Capacitor.Plugins.X proxy DOES exist and DOES find/call
    // addWatcher successfully here — its only issue is the return value
    // isn't always a real thenable Promise for this plugin's callback-style
    // signature, so we normalize it through Promise.resolve() instead of
    // chaining .then() directly on it.
    const BackgroundGeolocation = window.Capacitor.Plugins.BackgroundGeolocation;

    const maybeId = BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: "กำลังส่งตำแหน่งให้ลูกค้าติดตามการจัดส่ง",
        backgroundTitle: "Monshin Rider กำลังทำงาน",
        requestPermissions: true,
        stale: false,
        distanceFilter: 15 // meters — avoid spamming writes while stationary
      },
      async (location, error) => {
        if (error) {
          if (error.code === "NOT_AUTHORIZED") {
            alert("แอพต้องการสิทธิ์ตำแหน่ง (อนุญาตแบบ \"ตลอดเวลา\") เพื่อส่งงานได้");
          }
          console.error("[RiderLocation] error", error);
          return;
        }
        if (!location) return;

        // keep the freshest coords around so the heartbeat has something to resend
        lastLocation = location;

        // fires whenever the rider moves past distanceFilter (real movement)
        await upsertLocation(riderId, location);

        const now = Date.now();
        if (now - lastTrackWrite >= TRACK_INTERVAL_MS) {
          lastTrackWrite = now;
          await insertTrackPoint(riderId, jobId, location);
        }
      }
    );
    watcherId = await Promise.resolve(maybeId).catch(err => {
      console.warn("[RiderLocation] addWatcher id promise rejected", err);
      return null;
    });

    // Heartbeat: addWatcher's callback ONLY fires on real movement past
    // distanceFilter (15m). If the rider is stationary (waiting at a shop,
    // stopped at a light), updated_at would stay frozen and look identical
    // to the app being closed/crashed. This timer resends the last known
    // coords on a fixed cadence so updated_at stays fresh while stationary,
    // letting admin/customer tell "online but not moving" apart from
    // "offline". It never fires sooner than PING_INTERVAL_MS after the last
    // real upsert, so it only fills gaps — it doesn't spam extra writes on
    // top of normal movement pings.
    currentRiderId = riderId;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!lastLocation || !currentRiderId) return;
      if (Date.now() - lastPingSent < PING_INTERVAL_MS) return; // a real ping already covered this window
      upsertLocation(currentRiderId, lastLocation);
    }, PING_INTERVAL_MS);
  }

  async function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    lastLocation = null;
    currentRiderId = null;

    if (!watcherId) return;
    const BackgroundGeolocation = window.Capacitor.Plugins.BackgroundGeolocation;
    await Promise.resolve(BackgroundGeolocation.removeWatcher({ id: watcherId })).catch(err => {
      console.warn("[RiderLocation] removeWatcher failed", err);
    });
    watcherId = null;
  }

  return { start, stop };
})();
