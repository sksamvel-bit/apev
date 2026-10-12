/**
 * Tesla Model 3 & Model Y Official Battery & Energy Consumption Engine
 * Based on Tesla Official Owner's Manuals, EPA Certification, and EV-Database specifications (2018-2023).
 * Calculates trip energy (kWh), arrival battery state of charge (%),
 * remaining range, and low charge alerts.
 */

const TESLA_MODELS = {
  // ─── Tesla Model 3 (2018 - 2023) ───
  "m3_rwd_lfp": {
    name: "Model 3 RWD (2021-2023)",
    series: "Model 3",
    year: "2021-2023",
    drive: "RWD (უკანა)",
    chemistry: "LFP (CATL)",
    batteryKwh: 60,
    usableKwh: 57.5,
    consumptionPer100Km: 14.2,
    officialRangeKm: 491,
    chargeTip: "💡 LFP ბატარეა: Tesla-ს რეკომენდაციით დატენეთ 100%-მდე კვირაში ერთხელ"
  },
  "m3_sr_plus": {
    name: "Model 3 Standard Range+ (2018-2020)",
    series: "Model 3",
    year: "2018-2020",
    drive: "RWD (უკანა)",
    chemistry: "NCA (Panasonic 2170)",
    batteryKwh: 54,
    usableKwh: 50.0,
    consumptionPer100Km: 14.6,
    officialRangeKm: 409,
    chargeTip: "💡 NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },
  "m3_lr_awd": {
    name: "Model 3 Long Range AWD (2021-2023)",
    series: "Model 3",
    year: "2021-2023",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NMC/NCA + Heat Pump",
    batteryKwh: 82,
    usableKwh: 78.1,
    consumptionPer100Km: 15.0,
    officialRangeKm: 602,
    chargeTip: "💡 NMC/NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },
  "m3_lr_awd_pre": {
    name: "Model 3 Long Range AWD (2018-2020)",
    series: "Model 3",
    year: "2018-2020",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NCA (Panasonic 2170)",
    batteryKwh: 75,
    usableKwh: 72.5,
    consumptionPer100Km: 15.6,
    officialRangeKm: 560,
    chargeTip: "💡 NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },
  "m3_perf": {
    name: "Model 3 Performance AWD (2021-2023)",
    series: "Model 3",
    year: "2021-2023",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NMC/NCA + Heat Pump",
    batteryKwh: 82,
    usableKwh: 78.1,
    consumptionPer100Km: 16.5,
    officialRangeKm: 547,
    chargeTip: "💡 NMC/NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },
  "m3_perf_pre": {
    name: "Model 3 Performance AWD (2018-2020)",
    series: "Model 3",
    year: "2018-2020",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NCA (Panasonic 2170)",
    batteryKwh: 75,
    usableKwh: 72.5,
    consumptionPer100Km: 16.8,
    officialRangeKm: 530,
    chargeTip: "💡 NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },

  // ─── Tesla Model Y (2020 - 2023) ───
  "my_rwd_lfp": {
    name: "Model Y RWD (2022-2023)",
    series: "Model Y",
    year: "2022-2023",
    drive: "RWD (უკანა)",
    chemistry: "LFP (CATL)",
    batteryKwh: 60,
    usableKwh: 57.5,
    consumptionPer100Km: 15.7,
    officialRangeKm: 455,
    chargeTip: "💡 LFP ბატარეა: Tesla-ს რეკომენდაციით დატენეთ 100%-მდე კვირაში ერთხელ"
  },
  "my_lr_awd": {
    name: "Model Y Long Range AWD (2020-2023)",
    series: "Model Y",
    year: "2020-2023",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NMC/NCA (LG/Panasonic)",
    batteryKwh: 82,
    usableKwh: 75.0,
    consumptionPer100Km: 16.9,
    officialRangeKm: 533,
    chargeTip: "💡 NMC/NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  },
  "my_perf": {
    name: "Model Y Performance AWD (2020-2023)",
    series: "Model Y",
    year: "2020-2023",
    drive: "Dual Motor AWD (სრული)",
    chemistry: "NMC/NCA (21\" Überturbine)",
    batteryKwh: 82,
    usableKwh: 79.0,
    consumptionPer100Km: 17.3,
    officialRangeKm: 514,
    chargeTip: "💡 NMC/NCA ბატარეა: ყოველდღიურად რეკომენდებულია 80-90%-მდე დამუხტვა"
  }
};

// Aliases for backward compatibility with previously stored localStorage keys
const MODEL_KEY_ALIASES = {
  "sr": "m3_rwd_lfp",
  "lr": "m3_lr_awd",
  "perf": "m3_perf"
};

class BatteryEngine {
  constructor() {
    let savedKey = localStorage.getItem("tesla_model_type") || "m3_lr_awd";
    if (MODEL_KEY_ALIASES[savedKey]) savedKey = MODEL_KEY_ALIASES[savedKey];
    this.modelKey = TESLA_MODELS[savedKey] ? savedKey : "m3_lr_awd";
    this.currentSoC = parseInt(localStorage.getItem("tesla_current_soc") || "82", 10);
    this.onBatteryChange = null;
  }

  getModelConfig() {
    return TESLA_MODELS[this.modelKey] || TESLA_MODELS["m3_lr_awd"];
  }

  setModel(key) {
    const resolvedKey = MODEL_KEY_ALIASES[key] || key;
    if (TESLA_MODELS[resolvedKey]) {
      this.modelKey = resolvedKey;
      localStorage.setItem("tesla_model_type", resolvedKey);
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
    const effectiveKwh = config.usableKwh || config.batteryKwh;
    const remainingRangeKm = Math.round((this.currentSoC / 100) * (effectiveKwh / (config.consumptionPer100Km / 100)));
    return {
      key: this.modelKey,
      modelName: config.name,
      series: config.series,
      year: config.year,
      drive: config.drive,
      chemistry: config.chemistry,
      batteryKwh: config.batteryKwh,
      usableKwh: effectiveKwh,
      consumptionPer100Km: config.consumptionPer100Km,
      officialRangeKm: config.officialRangeKm,
      chargeTip: config.chargeTip,
      currentSoC: this.currentSoC,
      remainingRangeKm: remainingRangeKm
    };
  }

  calculateTripEnergy(distanceKm) {
    const config = this.getModelConfig();
    const effectiveKwh = config.usableKwh || config.batteryKwh;
    const energyKwh = (distanceKm * config.consumptionPer100Km) / 100;
    const socUsed = (energyKwh / effectiveKwh) * 100;
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

window.TESLA_MODELS = TESLA_MODELS;
window.BatteryEngine = BatteryEngine;
