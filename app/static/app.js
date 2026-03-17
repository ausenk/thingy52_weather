const metricSelect = document.querySelector("#metric-select");
const windowSelect = document.querySelector("#window-select");
const refreshButton = document.querySelector("#refresh-button");
const applyButton = document.querySelector("#apply-button");
const autopollToggle = document.querySelector("#autopoll-toggle");
const modeValue = document.querySelector("#mode-value");
const modeCaption = document.querySelector("#mode-caption");
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
const summaryCards = document.querySelector("#summary-cards");
const tableBody = document.querySelector("#table-body");
const chartCanvas = document.querySelector("#chart");
const chartCaption = document.querySelector("#chart-caption");

let trendChart = null;
let latestPollerStatus = null;

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

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function buildMetricOptions(metrics) {
  const filteredMetrics = metrics.filter((metric) => metric !== "battery_level");
  metricSelect.innerHTML = "";
  filteredMetrics.forEach((metric) => {
    const option = document.createElement("option");
    option.value = metric;
    option.textContent = metric;
    option.selected = true;
    metricSelect.appendChild(option);
  });
}

function renderSummary(items) {
  summaryCards.innerHTML = "";
  items
    .filter((item) => item.metric !== "battery_level")
    .forEach((item) => {
      const card = document.createElement("article");
      card.className = "summary-card";
      card.innerHTML = `
        <div class="metric">${item.metric}</div>
        <div class="value">${Number(item.value).toFixed(2)}</div>
        <div>${item.unit}</div>
        <div class="time">${formatTime(item.captured_at)}</div>
      `;
      summaryCards.appendChild(card);
    });
}

function renderTable(items) {
  tableBody.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${formatTime(item.captured_at)}</td>
      <td>${item.metric}</td>
      <td>${Number(item.value).toFixed(2)}</td>
      <td>${item.unit}</td>
      <td>${item.source}</td>
    `;
    tableBody.appendChild(row);
  });
}

function selectedMetrics() {
  return Array.from(metricSelect.selectedOptions).map((option) => option.value);
}

function updateModeUi(status) {
  const enabled = Boolean(status.enabled);
  autopollToggle.checked = enabled;
  modeValue.textContent = enabled ? "Automatic" : "Manual";
  modeCaption.textContent = enabled
    ? `Polling every ${status.interval_seconds} seconds.`
    : "Background polling is off. Use Poll now to fetch data.";
}

function updateThingyStatus(status, latestItems) {
  const battery = latestItems.find((item) => item.metric === "battery_level");

  deviceId.textContent = status.device_id || "-";
  connectorType.textContent = status.connector || "-";
  bleAddress.textContent = status.ble_address || "Not configured";
  lastSuccess.textContent = status.last_success_at ? formatTime(status.last_success_at) : "No successful poll yet";
  lastPoll.textContent = status.last_poll_at ? formatTime(status.last_poll_at) : "No poll attempted yet";
  lastResult.textContent = status.last_measurement_count
    ? `${status.last_measurement_count} measurements stored`
    : "No measurements stored yet";

  if (status.last_error) {
    connectionStatus.textContent = "Connection needs attention";
    connectionError.textContent = status.last_error;
    connectionError.classList.remove("hidden");
  } else if (status.last_success_at) {
    connectionStatus.textContent = "Connected and receiving data";
    connectionError.textContent = "";
    connectionError.classList.add("hidden");
  } else {
    connectionStatus.textContent = "Waiting for first successful poll";
    connectionError.textContent = "";
    connectionError.classList.add("hidden");
  }

  if (battery) {
    const batteryValue = Math.max(0, Math.min(100, Number(battery.value)));
    batteryLevel.textContent = batteryValue.toFixed(0);
    batteryFill.style.width = `${batteryValue}%`;
    batteryTime.textContent = `Updated ${formatTime(battery.captured_at)}`;
  } else {
    batteryLevel.textContent = "--";
    batteryFill.style.width = "0%";
    batteryTime.textContent = "No battery sample yet.";
  }
}

async function loadPollerStatus() {
  latestPollerStatus = await fetchJson("/api/poller");
  updateModeUi(latestPollerStatus);
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

  const sorted = [...chartItems].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const grouped = sorted.reduce((accumulator, item) => {
    const key = item.metric;
    accumulator[key] ||= [];
    accumulator[key].push({ x: new Date(item.captured_at).getTime(), y: Number(item.value) });
    return accumulator;
  }, {});
  const colors = [
    { border: "#0d8a70", background: "rgba(13, 138, 112, 0.12)" },
    { border: "#f29e4c", background: "rgba(242, 158, 76, 0.12)" },
    { border: "#28536b", background: "rgba(40, 83, 107, 0.12)" },
    { border: "#c8553d", background: "rgba(200, 85, 61, 0.12)" },
    { border: "#7a6ff0", background: "rgba(122, 111, 240, 0.12)" },
    { border: "#7f5539", background: "rgba(127, 85, 57, 0.12)" },
  ];

  const datasets = Object.entries(grouped).map(([metric, points], index) => ({
    label: metric,
    data: points,
    borderColor: colors[index % colors.length].border,
    backgroundColor: colors[index % colors.length].background,
    pointRadius: 2,
    pointHoverRadius: 4,
    borderWidth: 2,
    tension: 0.25,
    fill: false,
  }));

  trendChart = new Chart(chartCanvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      parsing: false,
      normalized: true,
      interaction: {
        mode: "nearest",
        intersect: false,
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            color: "#2d2419",
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
            color: "#725f49",
            maxTicksLimit: 6,
            callback(value) {
              return new Date(Number(value)).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              });
            },
          },
          grid: {
            color: "rgba(45, 36, 25, 0.08)",
          },
        },
        y: {
          ticks: {
            color: "#725f49",
          },
          grid: {
            color: "rgba(45, 36, 25, 0.08)",
          },
        },
      },
    },
  });

  chartCaption.textContent = `${sorted.length} points across ${Object.keys(grouped).length} metrics`;
}

async function loadDashboard() {
  const metricResponse = await fetchJson("/api/metrics");
  if (!metricSelect.options.length) {
    buildMetricOptions(metricResponse.metrics);
  }

  await loadPollerStatus();

  const latestResponse = await fetchJson("/api/latest");
  renderSummary(latestResponse.items);
  updateThingyStatus(latestPollerStatus, latestResponse.items);

  const params = new URLSearchParams();
  params.set("since_hours", windowSelect.value);
  selectedMetrics().forEach((metric) => params.append("metric", metric));
  const measurementsResponse = await fetchJson(`/api/measurements?${params.toString()}`);
  renderTable(measurementsResponse.items);
  drawChart(measurementsResponse.items);
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    await fetchJson("/api/poll", { method: "POST" });
    await loadDashboard();
  } catch (error) {
    chartCaption.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
  }
});

autopollToggle.addEventListener("change", async () => {
  autopollToggle.disabled = true;
  try {
    latestPollerStatus = await fetchJson("/api/poller", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: autopollToggle.checked }),
    });
    updateModeUi(latestPollerStatus);
    const latestResponse = await fetchJson("/api/latest");
    updateThingyStatus(latestPollerStatus, latestResponse.items);
  } catch (error) {
    chartCaption.textContent = error.message;
    await loadPollerStatus();
  } finally {
    autopollToggle.disabled = false;
  }
});

applyButton.addEventListener("click", () => {
  loadDashboard().catch((error) => {
    chartCaption.textContent = error.message;
  });
});

loadDashboard().catch((error) => {
  chartCaption.textContent = error.message;
});
