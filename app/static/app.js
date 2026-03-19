const FRIENDLY_LABELS = {
  temperature: "Temperature",
  humidity: "Humidity",
  pressure: "Pressure",
  light_intensity: "Luminance",
  battery_level: "Battery",
  altitude_estimate: "Estimated Altitude",
};

const PRIORITY_METRICS = ["temperature", "humidity", "pressure", "light_intensity", "altitude_estimate"];
const DAYLIGHT_START_HOUR = 6;
const DAYLIGHT_END_HOUR = 18;
const STANDARD_SEA_LEVEL_PRESSURE_HPA = 1013.25;
const HPA_TO_INHG = 0.0295299830714;
const METERS_TO_FEET = 3.28084;
const MOBILE_LAYOUT_QUERY = "(max-width: 720px)";

const deviceId = document.querySelector("#device-id");
const connectorType = document.querySelector("#connector-type");
const bleAddress = document.querySelector("#ble-address");
const lastSuccess = document.querySelector("#last-success");
const lastPoll = document.querySelector("#last-poll");
const lastResult = document.querySelector("#last-result");
const connectionStatus = document.querySelector("#connection-status");
const connectionError = document.querySelector("#connection-error");
const batteryLevel = document.querySelector("#battery-level");
const batteryFill = document.querySelector("#battery-fill");
const batteryTime = document.querySelector("#battery-time");
const conditionsCards = document.querySelector("#conditions-cards");
const windowChipGroup = document.querySelector("#window-chip-group");
const modeChipGroup = document.querySelector("#mode-chip-group");
const trendWorkspace = document.querySelector("#trend-workspace");
const tableBody = document.querySelector("#table-body");
const luminanceCanvas = document.querySelector("#luminance-chart");
const temperatureCanvas = document.querySelector("#temperature-chart");
const humidityPressureCanvas = document.querySelector("#humidity-pressure-chart");
const luminancePlotCard = document.querySelector("#luminance-plot-card");
const samplesPanel = document.querySelector("#samples-panel");
const mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);

let selectedHours = 24;
let selectedMode = "past";
let luminanceChart = null;
let temperatureChart = null;
let humidityPressureChart = null;
let latestPollerStatus = null;
let liveEvents = null;
let reloadTimer = null;
let dashboardLoadInFlight = null;
let lastResponsiveMode = null;

const dayNightPlugin = {
  id: "dayNightBackground",
  beforeDraw(chart) {
    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!chartArea || !xScale) {
      return;
    }

    const min = xScale.min;
    const max = xScale.max;
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return;
    }

    ctx.save();
    ctx.fillStyle = "rgba(2, 6, 23, 0.55)";
    ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);

    const cursor = new Date(min);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() < max + 86400000) {
      const dayStart = new Date(cursor);
      dayStart.setHours(DAYLIGHT_START_HOUR, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setHours(DAYLIGHT_END_HOUR, 0, 0, 0);

      const visibleStart = Math.max(min, dayStart.getTime());
      const visibleEnd = Math.min(max, dayEnd.getTime());
      if (visibleEnd > visibleStart) {
        const left = xScale.getPixelForValue(visibleStart);
        const right = xScale.getPixelForValue(visibleEnd);
        ctx.fillStyle = "rgba(148, 163, 184, 0.10)";
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    ctx.restore();
  },
};

const freezingLinePlugin = {
  id: "freezingLine",
  afterDraw(chart) {
    if (chart.canvas !== temperatureCanvas) {
      return;
    }

    const yScale = chart.scales.y;
    const chartArea = chart.chartArea;
    if (!yScale || !chartArea) {
      return;
    }

    const y = yScale.getPixelForValue(32);
    if (!Number.isFinite(y)) {
      return;
    }

    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = "rgba(248, 113, 113, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(248, 113, 113, 0.95)";
    ctx.font = isMobileLayout() ? "11px Segoe UI" : "12px Segoe UI";
    ctx.textAlign = "right";
    ctx.fillText("32 F", chartArea.right - 8, y - 6);
    ctx.restore();
  },
};

Chart.register(dayNightPlugin, freezingLinePlugin);

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const detail = payload?.detail || `Request failed: ${response.status}`;
    throw new Error(detail);
  }

  return payload;
}

function isMobileLayout() {
  return mobileLayout.matches;
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function formatAxisTime(value) {
  const date = new Date(Number(value));
  return isMobileLayout()
    ? date.toLocaleTimeString([], { hour: "numeric" })
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function pressureToInHg(valueHpa) {
  return valueHpa * HPA_TO_INHG;
}

function celsiusToFahrenheit(valueCelsius) {
  return (valueCelsius * 9) / 5 + 32;
}

function estimateAltitudeFeet(pressureHpa, seaLevelPressureHpa = STANDARD_SEA_LEVEL_PRESSURE_HPA) {
  const altitudeMeters = 44330 * (1 - Math.pow(pressureHpa / seaLevelPressureHpa, 1 / 5.255));
  return altitudeMeters * METERS_TO_FEET;
}

function showDashboardError(message) {
  connectionError.textContent = message;
  connectionError.classList.remove("hidden");
}

function clearDashboardError() {
  if (latestPollerStatus?.last_error) {
    return;
  }
  connectionError.textContent = "";
  connectionError.classList.add("hidden");
}

function displayMetric(metric, rawValue, rawUnit) {
  if (metric === "temperature") {
    return { label: FRIENDLY_LABELS[metric], value: celsiusToFahrenheit(Number(rawValue)), unit: "F", digits: 1 };
  }
  if (metric === "pressure") {
    return { label: FRIENDLY_LABELS[metric], value: pressureToInHg(Number(rawValue)), unit: "inHg", digits: 2 };
  }
  if (metric === "altitude_estimate") {
    return { label: FRIENDLY_LABELS[metric], value: Number(rawValue), unit: "ft", digits: 0 };
  }
  if (metric === "battery_level") {
    return { label: FRIENDLY_LABELS[metric], value: Number(rawValue), unit: rawUnit, digits: 0 };
  }
  return { label: FRIENDLY_LABELS[metric] || metric, value: Number(rawValue), unit: rawUnit, digits: 2 };
}

function syncWindowChips() {
  Array.from(windowChipGroup.querySelectorAll(".chip-range")).forEach((chip) => {
    chip.classList.toggle("is-active", Number(chip.dataset.hours) === selectedHours);
  });
}

function syncModeChips() {
  Array.from(modeChipGroup.querySelectorAll(".chip-mode")).forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.mode === selectedMode);
  });
  trendWorkspace.dataset.mode = selectedMode;
  luminancePlotCard.style.display = selectedMode === "future" ? "none" : "block";
}

function renderCurrentConditions(items) {
  conditionsCards.innerHTML = "";
  const latestByMetric = new Map(items.map((item) => [item.metric, item]));
  const pressureItem = latestByMetric.get("pressure");
  if (pressureItem) {
    latestByMetric.set("altitude_estimate", {
      metric: "altitude_estimate",
      value: estimateAltitudeFeet(Number(pressureItem.value)),
      unit: "ft",
      captured_at: pressureItem.captured_at,
    });
  }

  PRIORITY_METRICS.filter((metric) => latestByMetric.has(metric)).forEach((metric) => {
    const item = latestByMetric.get(metric);
    const display = displayMetric(metric, item.value, item.unit);
    const card = document.createElement("article");
    card.className = "condition-card";
    card.innerHTML = `
      <div class="condition-label">${display.label}</div>
      <div class="condition-value-row">
        <strong class="condition-value">${display.value.toFixed(display.digits)}</strong>
        <span class="condition-unit">${display.unit}</span>
      </div>
      <div class="condition-time">${formatTime(item.captured_at)}</div>
    `;
    conditionsCards.appendChild(card);
  });
}

function renderTable(items) {
  tableBody.innerHTML = "";
  items
    .slice()
    .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))
    .slice(0, 10)
    .forEach((item) => {
      const display = displayMetric(item.metric, item.value, item.unit);
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatTime(item.captured_at)}</td>
        <td>${display.label}</td>
        <td>${display.value.toFixed(display.digits)}</td>
        <td>${display.unit}</td>
        <td>${item.source}</td>
      `;
      tableBody.appendChild(row);
    });
}

function updateThingyStatus(status, latestItems) {
  latestPollerStatus = status;
  const battery = latestItems.find((item) => item.metric === "battery_level");

  deviceId.textContent = status.device_id || "-";
  connectorType.textContent = status.connector || "-";
  bleAddress.textContent = status.ble_address || "Not configured";
  lastSuccess.textContent = status.last_success_at ? formatTime(status.last_success_at) : "No successful poll yet";
  lastPoll.textContent = status.last_poll_at ? formatTime(status.last_poll_at) : "No poll attempted yet";
  lastResult.textContent = status.last_measurement_count ? `${status.last_measurement_count} samples stored` : "No measurements stored yet";

  if (status.last_error) {
    connectionStatus.textContent = "Needs attention";
    showDashboardError(status.last_error);
  } else if (status.last_success_at) {
    connectionStatus.textContent = "Receiving data";
    clearDashboardError();
  } else {
    connectionStatus.textContent = "Waiting for first poll";
    clearDashboardError();
  }

  if (battery) {
    const batteryValue = Math.max(0, Math.min(100, Number(battery.value)));
    batteryLevel.textContent = batteryValue.toFixed(0);
    batteryFill.style.width = `${batteryValue}%`;
    batteryTime.textContent = formatTime(battery.captured_at);
  } else {
    batteryLevel.textContent = "--";
    batteryFill.style.width = "0%";
    batteryTime.textContent = "No battery sample yet.";
  }
}

async function loadPollerStatus() {
  latestPollerStatus = await fetchJson("/api/poller");
}

function destroyChart(chart) {
  if (chart) {
    chart.destroy();
  }
}

function baseChartOptions() {
  const mobile = isMobileLayout();
  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    normalized: true,
    animation: false,
    transitions: { active: { animation: { duration: 0 } } },
    interaction: { mode: "nearest", intersect: false },
    layout: { padding: { top: 8, right: mobile ? 8 : 10, bottom: mobile ? 4 : 8, left: mobile ? 4 : 8 } },
    elements: {
      line: { tension: 0.2, borderWidth: mobile ? 1.75 : 2 },
      point: { radius: mobile ? 0 : 1.5, hitRadius: mobile ? 10 : 8, hoverRadius: mobile ? 3 : 4 },
    },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        align: "end",
        labels: {
          color: "#cbd5e1",
          usePointStyle: true,
          boxWidth: mobile ? 8 : 10,
          boxHeight: mobile ? 8 : 10,
          padding: mobile ? 12 : 16,
          font: { size: mobile ? 11 : 12 },
        },
      },
      tooltip: {
        callbacks: {
          title(context) {
            return formatTime(context[0].parsed.x);
          },
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        ticks: {
          color: "#9aa4b2",
          maxTicksLimit: mobile ? 4 : 6,
          callback(value) {
            return formatAxisTime(value);
          },
        },
        grid: { color: "rgba(148, 163, 184, 0.12)" },
      },
    },
  };
}

function sortedSeries(items, metric, transform = (value) => Number(value)) {
  return items
    .filter((item) => item.metric === metric)
    .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
    .map((item) => ({ x: new Date(item.captured_at).getTime(), y: transform(item.value) }));
}

function sortedForecastSeries(items, metric, transform = (value) => Number(value)) {
  return items
    .filter((item) => item.metric === metric)
    .sort((a, b) => new Date(a.valid_at) - new Date(b.valid_at))
    .map((item) => ({ x: new Date(item.valid_at).getTime(), y: transform(item.value) }));
}

function drawCharts(measurements, forecastItems) {
  destroyChart(luminanceChart);
  destroyChart(temperatureChart);
  destroyChart(humidityPressureChart);
  luminanceChart = null;
  temperatureChart = null;
  humidityPressureChart = null;

  const actualLuminance = sortedSeries(measurements, "light_intensity");
  const actualTemperature = sortedSeries(measurements, "temperature", (value) => celsiusToFahrenheit(Number(value)));
  const actualHumidity = sortedSeries(measurements, "humidity");
  const actualPressure = sortedSeries(measurements, "pressure", (value) => pressureToInHg(Number(value)));

  const forecastTemperature = sortedForecastSeries(forecastItems, "temperature", (value) => celsiusToFahrenheit(Number(value)));
  const forecastHumidity = sortedForecastSeries(forecastItems, "humidity");
  const forecastPressure = sortedForecastSeries(forecastItems, "pressure", (value) => pressureToInHg(Number(value)));

  const showActual = selectedMode !== "future";
  const showForecast = selectedMode !== "past";

  if (showActual && actualLuminance.length) {
    const options = baseChartOptions();
    options.scales.y = {
      ticks: { color: "#9aa4b2", maxTicksLimit: isMobileLayout() ? 4 : 6 },
      grid: { color: "rgba(148, 163, 184, 0.12)" },
      title: { display: true, text: "Counts", color: "#9aa4b2" },
    };
    luminanceChart = new Chart(luminanceCanvas, {
      type: "line",
      data: {
        datasets: [{
          label: "Luminance",
          data: actualLuminance,
          borderColor: "#fde68a",
          backgroundColor: "rgba(253, 230, 138, 0.16)",
          fill: false,
        }],
      },
      options,
    });
  }

  const temperatureDatasets = [];
  if (showActual && actualTemperature.length) {
    temperatureDatasets.push({
      label: "Measured Temperature",
      data: actualTemperature,
      borderColor: "#f97316",
      backgroundColor: "rgba(249, 115, 22, 0.16)",
      fill: false,
    });
  }
  if (showForecast && forecastTemperature.length) {
    temperatureDatasets.push({
      label: "Forecast Temperature",
      data: forecastTemperature,
      borderColor: "#fdba74",
      backgroundColor: "rgba(253, 186, 116, 0.14)",
      borderDash: [8, 5],
      fill: false,
    });
  }
  if (temperatureDatasets.length) {
    const options = baseChartOptions();
    options.scales.y = {
      min: 0,
      max: 100,
      ticks: { color: "#9aa4b2", maxTicksLimit: isMobileLayout() ? 4 : 6 },
      grid: { color: "rgba(148, 163, 184, 0.12)" },
      title: { display: true, text: "Temperature (F)", color: "#9aa4b2" },
    };
    temperatureChart = new Chart(temperatureCanvas, {
      type: "line",
      data: { datasets: temperatureDatasets },
      options,
    });
  }

  const humidityPressureDatasets = [];
  if (showActual && actualHumidity.length) {
    humidityPressureDatasets.push({
      label: "Measured Humidity",
      data: actualHumidity,
      yAxisID: "yHumidity",
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56, 189, 248, 0.16)",
      fill: false,
    });
  }
  if (showForecast && forecastHumidity.length) {
    humidityPressureDatasets.push({
      label: "Forecast Humidity",
      data: forecastHumidity,
      yAxisID: "yHumidity",
      borderColor: "#7dd3fc",
      backgroundColor: "rgba(125, 211, 252, 0.14)",
      borderDash: [8, 5],
      fill: false,
    });
  }
  if (showActual && actualPressure.length) {
    humidityPressureDatasets.push({
      label: "Measured Pressure",
      data: actualPressure,
      yAxisID: "yPressure",
      borderColor: "#a78bfa",
      backgroundColor: "rgba(167, 139, 250, 0.16)",
      fill: false,
    });
  }
  if (showForecast && forecastPressure.length) {
    humidityPressureDatasets.push({
      label: "Forecast Pressure",
      data: forecastPressure,
      yAxisID: "yPressure",
      borderColor: "#c4b5fd",
      backgroundColor: "rgba(196, 181, 253, 0.14)",
      borderDash: [8, 5],
      fill: false,
    });
  }

  if (humidityPressureDatasets.length) {
    const options = baseChartOptions();
    options.scales.yHumidity = {
      type: "linear",
      position: "left",
      min: 0,
      max: 100,
      ticks: { color: "#9aa4b2", maxTicksLimit: isMobileLayout() ? 4 : 6 },
      grid: { color: "rgba(148, 163, 184, 0.12)" },
      title: { display: true, text: "Humidity (%)", color: "#9aa4b2" },
    };
    options.scales.yPressure = {
      type: "linear",
      position: "right",
      min: 27,
      max: 31,
      ticks: { color: "#9aa4b2", maxTicksLimit: isMobileLayout() ? 4 : 6 },
      grid: { drawOnChartArea: false },
      title: { display: true, text: "Pressure (inHg)", color: "#9aa4b2" },
    };
    humidityPressureChart = new Chart(humidityPressureCanvas, {
      type: "line",
      data: { datasets: humidityPressureDatasets },
      options,
    });
  }
}

function syncResponsiveState(forceRedraw = false) {
  const mobile = isMobileLayout();
  if (lastResponsiveMode === null) {
    samplesPanel.open = !mobile;
  }

  if (forceRedraw || lastResponsiveMode !== mobile) {
    lastResponsiveMode = mobile;
    scheduleDashboardReload(0);
  }
}

async function loadDashboard() {
  if (dashboardLoadInFlight) {
    return dashboardLoadInFlight;
  }

  dashboardLoadInFlight = (async () => {
    syncWindowChips();
    syncModeChips();

    await loadPollerStatus();

    const measurementParams = new URLSearchParams();
    measurementParams.set("since_hours", String(Math.min(selectedHours, 24 * 30)));
    measurementParams.set("limit", "5000");
    ["light_intensity", "temperature", "humidity", "pressure"].forEach((metric) => {
      measurementParams.append("metric", metric);
    });

    const requests = [
      fetchJson("/api/latest"),
      fetchJson(`/api/measurements?${measurementParams.toString()}`),
    ];

    if (selectedMode !== "past") {
      const forecastParams = new URLSearchParams();
      forecastParams.set("hours", String(selectedHours));
      forecastParams.set("mode", selectedMode === "compare" ? "compare" : "future");
      ["temperature", "humidity", "pressure"].forEach((metric) => {
        forecastParams.append("metric", metric);
      });
      requests.push(fetchJson(`/api/forecast?${forecastParams.toString()}`));
    }

    const [latestResponse, measurementsResponse, forecastResponse] = await Promise.all(requests);
    const latestItems = latestResponse.items.filter((item) => !item.metric.startsWith("air_quality_"));
    const measurementItems = measurementsResponse.items.filter((item) => !item.metric.startsWith("air_quality_"));
    const forecastItems = forecastResponse?.items ?? [];

    renderCurrentConditions(latestItems);
    updateThingyStatus(latestPollerStatus, latestItems);
    renderTable(measurementItems);
    drawCharts(measurementItems, forecastItems);

    if (selectedMode !== "past" && forecastResponse && !forecastResponse.configured) {
      showDashboardError("Set THINGY52_NWS_LATITUDE and THINGY52_NWS_LONGITUDE to enable forecast modes.");
    } else if (!latestPollerStatus?.last_error) {
      clearDashboardError();
    }
  })();

  try {
    await dashboardLoadInFlight;
  } finally {
    dashboardLoadInFlight = null;
  }
}

function scheduleDashboardReload(delay = 200) {
  if (reloadTimer) {
    window.clearTimeout(reloadTimer);
  }
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    loadDashboard().catch((error) => {
      showDashboardError(error.message);
    });
  }, delay);
}

function connectLiveUpdates() {
  if (liveEvents) {
    liveEvents.close();
  }
  liveEvents = new EventSource("/api/events");
  liveEvents.addEventListener("measurement", () => scheduleDashboardReload(100));
  liveEvents.addEventListener("poller", () => scheduleDashboardReload(100));
  liveEvents.onerror = () => {
    showDashboardError("Live updates disconnected. Reconnecting...");
  };
}

windowChipGroup.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip-range[data-hours]");
  if (!chip) {
    return;
  }
  selectedHours = Number(chip.dataset.hours);
  syncWindowChips();
  loadDashboard().catch((error) => {
    showDashboardError(error.message);
  });
});

modeChipGroup.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip-mode[data-mode]");
  if (!chip) {
    return;
  }
  selectedMode = chip.dataset.mode;
  syncModeChips();
  loadDashboard().catch((error) => {
    showDashboardError(error.message);
  });
});

mobileLayout.addEventListener("change", () => {
  syncResponsiveState(true);
});

connectLiveUpdates();
syncResponsiveState(false);
loadDashboard().catch((error) => {
  showDashboardError(error.message);
});


