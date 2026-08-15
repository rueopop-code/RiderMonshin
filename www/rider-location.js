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
const RiderLocation = (() => {
  let watcherId = null;
  let lastTrackWrite = 0;
  let cfg = null;

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
    const { BackgroundGeolocation } = window.Capacitor.Plugins;

    await BackgroundGeolocation.addWatcher(
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

        // ping every ~10s regardless (this callback fires on distanceFilter/interval)
        await upsertLocation(riderId, location);

        const now = Date.now();
        if (now - lastTrackWrite >= TRACK_INTERVAL_MS) {
          lastTrackWrite = now;
          await insertTrackPoint(riderId, jobId, location);
        }
      }
    ).then(id => { watcherId = id; });
  }

  async function stop() {
    if (!watcherId) return;
    const { BackgroundGeolocation } = window.Capacitor.Plugins;
    await BackgroundGeolocation.removeWatcher({ id: watcherId });
    watcherId = null;
  }

  return { start, stop };
})();
