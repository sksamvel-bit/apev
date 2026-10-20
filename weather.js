/**
 * Live Weather Engine
 * Uses Open-Meteo free API (no keys needed) to provide live road conditions,
 * temperature, and wind speed.
 *
 * v3.10.59: rain / snow ahead (the next 2 hours in 15-minute steps) and a road-ice warning at +3 °C or below, the way
 * car makers warn. Each warning is said once per episode, not on every fetch.
 */

// WMO weather codes: drizzle / rain / showers / thunderstorm, and snow
function isRainCode(c) { return (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95; }
function isSnowCode(c) { return (c >= 71 && c <= 77) || c === 85 || c === 86; }

/**
 * Open-Meteo JSON -> { kind: "rain" | "snow", inMin } when it is dry now and wet within the next 2 hours, else null.
 * A slot counts as wet when its code says rain/snow or it brings >= 0.2 mm in 15 minutes.
 */
function precipAhead(json) {
  const cur = json && json.current, m = json && json.minutely_15;
  if (!cur || !m || !Array.isArray(m.precipitation)) return null;
  const wetNow = isRainCode(cur.weather_code) || isSnowCode(cur.weather_code) || cur.precipitation >= 0.2;
  if (wetNow) return null;
  const startIdx = m.time ? Math.max(0, m.time.indexOf(cur.time)) : 0;
  for (let i = startIdx + 1; i < m.precipitation.length && i <= startIdx + 8; i++) {
    const code = m.weather_code ? m.weather_code[i] : 0, mm = m.precipitation[i] || 0;
    if (isSnowCode(code) || isRainCode(code) || mm >= 0.2) {
      const snow = isSnowCode(code) || (mm > 0 && cur.temperature_2m <= 1);
      return { kind: snow ? "snow" : "rain", inMin: (i - startIdx) * 15 };
    }
  }
  return null;
}

/** Text for a precipitation warning ("ყურადღება" makes speech.js play the alert chime). */
function precipText(p) {
  const what = p.kind === "snow" ? "თოვლი" : "წვიმა";
  return "ყურადღება, " + what + " მოსალოდნელია დაახლოებით " + p.inMin + " წუთში";
}

const ICE_TEMP_C = 3;            // air at +3 °C can mean ice on bridges and shaded road
const REPEAT_MS = 60 * 60 * 1000;

class WeatherEngine {
  constructor(opts) {
    this.lastFetched = 0;
    this.lastLat = null;
    this.lastLng = null;
    this.cachedData = null;
    this.fetchFn = (opts && opts.fetchFn) || ((...a) => fetch(...a));
    this.lastPrecipAt = 0;
    this.lastPrecipKind = null;
    this.iceWarned = false;
  }

  getWeatherIconAndText(code) {
    if (code === 0) return { icon: "☀️", text: "მზიანი" };
    if (code >= 1 && code <= 3) return { icon: "⛅", text: "მოღრუბლული" };
    if (code === 45 || code === 48) return { icon: "🌫️", text: "ნისლი" };
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return { icon: "🌧️", text: "წვიმა" };
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return { icon: "❄️", text: "თოვლი" };
    if (code >= 95) return { icon: "⛈️", text: "ჭექა-ქუხილი" };
    return { icon: "🌤️", text: "ნათელი" };
  }

  async fetchWeather(lat, lng) {
    const now = Date.now();
    // Throttle: don't re-fetch within 10 minutes unless moved > 5km
    if (this.cachedData && (now - this.lastFetched < 600000)) {
      if (this.lastLat && Math.abs(lat - this.lastLat) < 0.05 && Math.abs(lng - this.lastLng) < 0.05) {
        return this.cachedData;
      }
    }

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&minutely_15=precipitation,weather_code&forecast_minutely_15=9&timezone=auto`;
      const res = await this.fetchFn(url);
      if (!res.ok) return null;

      const data = await res.json();
      const curr = data.current;
      const condition = this.getWeatherIconAndText(curr.weather_code);

      this.cachedData = {
        temp: Math.round(curr.temperature_2m),
        tempExact: curr.temperature_2m,
        windKmh: Math.round(curr.wind_speed_10m),
        humidity: curr.relative_humidity_2m,
        icon: condition.icon,
        text: condition.text,
        precip: precipAhead(data)
      };

      this.lastFetched = now;
      this.lastLat = lat;
      this.lastLng = lng;

      return this.cachedData;
    } catch (e) {
      console.warn("Weather fetch notice:", e.message);
      return null;
    }
  }

  /**
   * Warnings worth saying for this data, each once per episode: [{ kind: "rain"|"snow"|"ice", text }].
   * Rain/snow again only after an hour or when the kind changes; ice again only after the air was above +3 °C.
   */
  alertsFor(data, now = Date.now()) {
    const out = [];
    if (!data) return out;
    const p = data.precip;
    if (p && (p.kind !== this.lastPrecipKind || now - this.lastPrecipAt > REPEAT_MS)) {
      this.lastPrecipKind = p.kind;
      this.lastPrecipAt = now;
      out.push({ kind: p.kind, text: precipText(p) });
    }
    const t = data.tempExact != null ? data.tempExact : data.temp;
    if (isFinite(t)) {
      if (t <= ICE_TEMP_C && !this.iceWarned) {
        this.iceWarned = true;
        out.push({ kind: "ice", text: "ყურადღება, ჰაერი " + Math.round(t) + " გრადუსია: ხიდებზე და ჩრდილში შესაძლოა ყინული იყოს" });
      } else if (t > ICE_TEMP_C + 1) {
        this.iceWarned = false;
      }
    }
    return out;
  }
}

if (typeof window !== "undefined") window.WeatherEngine = WeatherEngine;
if (typeof module === "object" && module.exports) module.exports = { WeatherEngine, precipAhead, precipText, isRainCode, isSnowCode, ICE_TEMP_C };
