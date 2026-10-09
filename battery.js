/**
 * Tesla Model 3 Battery & Energy Consumption Engine
 * Calculates trip energy (kWh), arrival battery state of charge (%),
 * remaining range, and low charge alerts.
 */

const TESLA_MODELS = {
  "sr": {
    name: "Model 3 Standard Range",
    batteryKwh: 60,
    consumptionPer100Km: 14.8
  },
  "lr": {
    name: "Model 3 Long Range",
    batteryKwh: 78,
    consumptionPer100Km: 15.6
  },
  "perf": {
    name: "Model 3 Performance",
    batteryKwh: 82,
    consumptionPer100Km: 16.8
  }
};

class BatteryEngine {
  constructor() {
    this.modelKey = localStorage.getItem("tesla_model_type") || "lr";
    this.currentSoC = parseInt(localStorage.getItem("tesla_current_soc") || "82", 10);
    this.onBatteryChange = null;
  }

  getModelConfig() {
    return TESLA_MODELS[this.modelKey] || TESLA_MODELS["lr"];
  }

  setModel(key) {
    if (TESLA_MODELS[key]) {
      this.modelKey = key;
      localStorage.setItem("tesla_model_type", key);
      if (this.onBatteryChange) this.onBatteryChange(this.getStats());
    }
  }

  setSoC(percent) {
    this.currentSoC = Math.min(100, Math.max(1, Math.round(percent)));
    localStorage.setItem("tesla_current_soc", this.currentSoC.toString());
    if (this.onBatteryChange) this.onBatteryChange(this.getStats());
  }

  getStats() {
    const config = this.getModelConfig();
    const remainingRangeKm = Math.round((this.currentSoC / 100) * (config.batteryKwh / (config.consumptionPer100Km / 100)));
    return {
      modelName: config.name,
      batteryKwh: config.batteryKwh,
      currentSoC: this.currentSoC,
      remainingRangeKm: remainingRangeKm
    };
  }

  calculateTripEnergy(distanceKm) {
    const config = this.getModelConfig();
    const energyKwh = (distanceKm * config.consumptionPer100Km) / 100;
    const socUsed = (energyKwh / config.batteryKwh) * 100;
    const arrivalSoC = Math.round(this.currentSoC - socUsed);

    let status = "ok"; // ok, low, critical
    if (arrivalSoC <= 5) status = "critical";
    else if (arrivalSoC <= 18) status = "low";

    return {
      energyKwh: energyKwh.toFixed(1),
      arrivalSoC: arrivalSoC,
      status: status
    };
  }
}

window.BatteryEngine = BatteryEngine;
