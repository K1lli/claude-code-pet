// watchers/weather.js - Open-Meteo weather watcher (free, no API key)
const https = require("https");

class WeatherWatcher {
  constructor(config, onWeatherUpdate) {
    this.latitude = config.latitude || null;
    this.longitude = config.longitude || null;
    this.pollIntervalMin = config.pollIntervalMin || 30;
    this.showTemperature = config.showTemperature !== false;
    this.onWeatherUpdate = onWeatherUpdate;
    this.timer = null;
    this.lastWeather = null;
    this._state = null;
  }

  start() {
    if (this.latitude && this.longitude) {
      // Initial fetch after 10s delay
      setTimeout(() => this.fetchWeather(), 10000);
      this.timer = setInterval(() => this.fetchWeather(), this.pollIntervalMin * 60 * 1000);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateLocation(lat, lon) {
    this.latitude = lat;
    this.longitude = lon;
    if (lat && lon) {
      this.fetchWeather();
    }
  }

  fetchWeather() {
    if (!this.latitude || !this.longitude) return;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.latitude}&longitude=${this.longitude}&current_weather=true`;

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.current_weather) {
            const cw = json.current_weather;
            const weatherData = {
              temperature: cw.temperature,
              weatherCode: cw.weathercode,
              windSpeed: cw.windspeed,
              isDay: cw.is_day === 1,
            };

            // Only notify on change
            const key = `${cw.weathercode}-${Math.round(cw.temperature)}`;
            if (key !== this.lastWeather) {
              this.lastWeather = key;
              this._state = this._weatherToStatus(cw.weathercode);
              if (this.onWeatherUpdate) {
                this.onWeatherUpdate(weatherData);
              }
            }
          }
        } catch (e) {
          console.error("[Weather] Parse error:", e.message);
        }
      });
    }).on("error", (e) => {
      console.error("[Weather] Fetch error:", e.message);
    });
  }

  _weatherToStatus(code) {
    // WMO weather codes → pet status
    if (code === 0 || code === 1) return { status: "idle" }; // Clear
    if (code === 2 || code === 3) return { status: "idle" }; // Cloudy
    if (code >= 51 && code <= 67) return { status: "idle" }; // Rain
    if (code >= 71 && code <= 77) return { status: "idle" }; // Snow
    if (code >= 95) return { status: "idle" }; // Storm
    return null;
  }

  getState() {
    return this._state;
  }

  // Static geocoding method using Open-Meteo Geocoding API
  static geocodeCity(cityName) {
    return new Promise((resolve, reject) => {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1`;
      https.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.results && json.results.length > 0) {
              const r = json.results[0];
              resolve({ latitude: r.latitude, longitude: r.longitude, name: r.name, country: r.country });
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on("error", reject);
    });
  }
}

module.exports = { WeatherWatcher };
