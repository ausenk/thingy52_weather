const FRIENDLY_LABELS = {
  temperature: "Temperature",
  humidity: "Humidity",
  pressure: "Pressure",
  light_intensity: "Light",
  battery_level: "Battery",
};

const PRIORITY_METRICS = ["temperature", "humidity", "pressure", "light_intensity"];

const metricSelect = document.querySelector("#metric-select");
const windowSelect = document.querySelector("#window-select");
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
const conditionsUpdated = document.querySelector("#conditions-updated");
const conditionsCards = document.querySelector("#conditions-cards");
const metricChipGroup = document.querySelector("#metric-chip-group");
const windowChipGroup = document.querySelector("#window-chip-group");
const tableBody = document.querySelector("#table-body");
const chartCanvas = document.querySelector("#chart");
const chartCaption = document.querySelector("#chart-caption");

let trendChart = null;
let latestPollerStatus = null;
let liveEvents = null;
let reloadTimer = null;
let dashboardLoadInFlight = null;
let selectedMetricId = "temperature";

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

function friendlyLabel(metric) {
  return FRIENDLY_LABELS[metric] || metric;
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function formatValue(item) {
  return Number(item.value).toFixed(item.metric === "battery_level" ? 0 : 2);
}

function buildMetricOptions(metrics) {
  const filteredMetrics = metrics.filter(
    (metric) => metric !== "battery_level" && !metric.startsWith("air_quality_")
  );
  metricSelect.innerHTML = "";
  metricChipGroup.innerHTML = "";

  if (!filteredMetrics.includes(selectedMetricId)) {
    selectedMetricId = filteredMetrics[0] || "temperature";
  }

  filteredMetrics.forEach((metric) => {
    const option = document.createElement("option");
    option.value = metric;
    option.textContent = friendlyLabel(metric);
    option.selected = selectedMetricId === metric;
    metricSelect.appendChild(option);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.metric = metric;
    chip.textContent = friendlyLabel(metric);
    chip.classList.toggle("is-active", selectedMetricId === metric);
    chip.addEventListener("click", () => {
      selectMetric(metric);
    });
    metricChipGroup.appendChild(chip);
  });
}

function syncMetricControls() {
  Array.from(metricSelect.options).forEach((option) => {
    option.selected = selectedMetricId === option.value;
  });
  Array.from(metricChipGroup.querySelectorAll(".chip")).forEach((chip) => {
    chip.classList.toggle("is-active", selectedMetricId === chip.dataset.metric);
  });
}

function selectMetric(metric) {
  selectedMetricId = metric;
  syncMetricControls();
  loadDashboard().catch((error) => {
    chartCaption.textContent = error.message;
  });
}

function syncWindowChips() {
  Array.from(windowChipGroup.querySelectorAll(".chip")).forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.hours === windowSelect.value);
  });
}

function renderCurrentConditions(items) {
  conditionsCards.innerHTML = "";
  const latestByMetric = new Map(items.map((item) => [item.metric, item]));
  const visible = PRIORITY_METRICS.filter((metric) => latestByMetric.has(metric));

  visible.forEach((metric) => {
    const item = latestByMetric.get(metric);
    const card = document.createElement("article");
    card.className = "condition-card";
    card.innerHTML = `
      <div class="condition-label">${friendlyLabel(metric)}</div>
      <div class="condition-value-row">
        <strong class="condition-value">${formatValue(item)}</strong>
        <span class="condition-unit">${item.unit}</span>
      </div>
      <div class="condition-time">${formatTime(item.captured_at)}</div>
    `;
    conditionsCards.appendChild(card);
  });

  const newest = items.reduce((latest, item) => {
    if (!latest) {
      return item;
    }
    return new Date(item.captured_at) > new Date(latest.captured_at) ? item : latest;
  }, null);
  conditionsUpdated.textContent = newest ? `Updated ${formatTime(newest.captured_at)}` : "Waiting for data...";
}

function renderTable(items) {
  tableBody.innerHTML = "";
  items
    .filter((item) => !item.metric.startsWith("air_quality_"))
    .forEach((item) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatTime(item.captured_at)}</td>
        <td>${friendlyLabel(item.metric)}</td>
        <td>${formatValue(item)}</td>
        <td>${item.unit}</td>
        <td>${item.source}</td>
      `;
      tableBody.appendChild(row);
    });
}

function selectedMetrics() {
  return selectedMetricId ? [selectedMetricId] : [];
}

function updateThingyStatus(status, latestItems) {
  const battery = latestItems.find((item) => item.metric === "battery_level");

  deviceId.textContent = status.device_id || "-";
  connectorType.textContent = status.connector || "-";
  bleAddress.textContent = status.ble_address || "Not configured";
  lastSuccess.textContent = status.last_success_at ? formatTime(status.last_success_at) : "No successful poll yet";
  lastPoll.textContent = status.last_poll_at ? formatTime(status.last_poll_at) : "No poll attempted yet";
  lastResult.textContent = status.last_measurement_count
    ? `${status.last_measurement_count} samples stored`
    : "No measurements stored yet";

  if (status.last_error) {
    connectionStatus.textContent = "Needs attention";
    connectionError.textContent = status.last_error;
    connectionError.classList.remove("hidden");
  } else if (status.last_success_at) {
    connectionStatus.textContent = "Receiving data";
    connectionError.textContent = "";
    connectionError.classList.add("hidden");
  } else {
    connectionStatus.textContent = "Waiting for first poll";
    connectionError.textContent = "";
    connectionError.classList.add("hidden");
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

function destroyChart() {
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
}

function drawChart(items) {
  destroyChart();

  const chartItems = items.filter((item) => item.metric !== "battery_level");
  if (!chartItems.length) {
    chartCaption.textContent = "No matching measurements.";
    return;
  }

  const metric = chartItems[0].metric;
  const sorted = [...chartItems].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const dataset = sorted.map((item) => ({
    x: new Date(item.captured_at).getTime(),
    y: Number(item.value),
  }));

  trendChart = new Chart(chartCanvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: friendlyLabel(metric),
          data: dataset,
          borderColor: "#7dd3fc",
          backgroundColor: "rgba(125, 211, 252, 0.16)",
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 2,
          tension: 0.2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      parsing: false,
      normalized: true,
      plugins: {
        legend: {
          display: false,
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
            maxTicksLimit: 6,
            callback(value) {
              return new Date(Number(value)).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              });
            },
          },
          grid: {
            color: "rgba(148, 163, 184, 0.12)",
          },
        },
        y: {
          ticks: {
            color: "#9aa4b2",
          },
          grid: {
            color: "rgba(148, 163, 184, 0.12)",
          },
        },
      },
    },
  });

  chartCaption.textContent = `${friendlyLabel(metric)} over ${windowSelect.options[windowSelect.selectedIndex].text.toLowerCase()}`;
}

async function loadDashboard() {
  if (dashboardLoadInFlight) {
    return dashboardLoadInFlight;
  }

  dashboardLoadInFlight = (async () => {
    const metricResponse = await fetchJson("/api/metrics");
    buildMetricOptions(metricResponse.metrics);
    syncMetricControls();
    syncWindowChips();

    await loadPollerStatus();

    const latestResponse = await fetchJson("/api/latest");
    const latestItems = latestResponse.items.filter((item) => !item.metric.startsWith("air_quality_"));
    renderCurrentConditions(latestItems);
    updateThingyStatus(latestPollerStatus, latestItems);

    const params = new URLSearchParams();
    params.set("since_hours", windowSelect.value);
    selectedMetrics().forEach((metric) => params.append("metric", metric));
    const measurementsResponse = await fetchJson(`/api/measurements?${params.toString()}`);
    const measurementItems = measurementsResponse.items.filter((item) => !item.metric.startsWith("air_quality_"));
    renderTable(measurementItems);
    drawChart(measurementItems);
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
      chartCaption.textContent = error.message;
    });
  }, delay);
}

function connectLiveUpdates() {
  if (liveEvents) {
    liveEvents.close();
  }

  liveEvents = new EventSource("/api/events");
  liveEvents.addEventListener("measurement", () => {
    scheduleDashboardReload(100);
  });
  liveEvents.addEventListener("poller", () => {
    scheduleDashboardReload(100);
  });
  liveEvents.onerror = () => {
    chartCaption.textContent = "Live updates disconnected. Reconnecting...";
  };
}

windowChipGroup.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip[data-hours]");
  if (!chip) {
    return;
  }
  windowSelect.value = chip.dataset.hours;
  syncWindowChips();
  loadDashboard().catch((error) => {
    chartCaption.textContent = error.message;
  });
});

windowSelect.addEventListener("change", () => {
  syncWindowChips();
  loadDashboard().catch((error) => {
    chartCaption.textContent = error.message;
  });
});

connectLiveUpdates();
loadDashboard().catch((error) => {
  chartCaption.textContent = error.message;
});
