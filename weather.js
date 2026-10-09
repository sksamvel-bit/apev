/**
 * Live Weather Engine
 * Uses Open-Meteo free API (no keys needed) to provide live road conditions,
 * temperature, and wind speed.
 */

class WeatherEngine {
  constructor() {
    this.lastFetched = 0;
    this.lastLat = null;
    this.lastLng = null;
    this.cachedData = null;
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
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data = await res.json();
      const curr = data.current;
      const condition = this.getWeatherIconAndText(curr.weather_code);

      this.cachedData = {
        temp: Math.round(curr.temperature_2m),
        windKmh: Math.round(curr.wind_speed_10m),
        humidity: curr.relative_humidity_2m,
        icon: condition.icon,
        text: condition.text
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
}

window.WeatherEngine = WeatherEngine;
