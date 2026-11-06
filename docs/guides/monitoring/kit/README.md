# Load test monitoring kit

A Docker Compose stack for watching load tests live:

- **k6 → Prometheus** (remote write, native histograms) → Grafana
- **JMeter → InfluxDB 1.8** (built-in Backend Listener) → Grafana
- **node-exporter** on the system under test → Prometheus → Grafana

Full walkthrough: https://pawansinha.com.au/guides/monitoring/grafana-stack/

## Files

```
docker-compose.yml                          the stack
prometheus/prometheus.yml                   scrape config (node-exporter), k6 pushes via remote write
grafana/provisioning/datasources/*.yml      Prometheus + InfluxDB datasources (fixed uids)
grafana/provisioning/dashboards/*.yml       loads every JSON file in grafana/dashboards/
grafana/dashboards/k6-prometheus.json       k6 + node-exporter dashboard
grafana/dashboards/jmeter-influxdb.json     JMeter dashboard
k6/smoke.js                                 sample k6 test
jmeter/sample-test.jmx                      sample JMeter plan with the Backend Listener set up
jmeter/user.properties                      Backend Listener settings the dashboard expects
```

## Start

```sh
docker compose up -d
# Grafana:    http://localhost:3000  (admin / admin, you are asked to change it)
# Prometheus: http://localhost:9090
# InfluxDB:   http://localhost:8086  (database "jmeter")
```

## k6

From your machine (k6 installed locally):

```sh
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
k6 run -o experimental-prometheus-rw --tag testid=$(date +%Y%m%d-%H%M) k6/smoke.js
```

Or inside the stack:

```sh
TARGET_URL=https://your-test-env.example.com docker compose --profile k6 run --rm k6
```

Why native histograms: with the default setting k6 sends each trend as gauges such as
`k6_http_req_duration_p99`, and those values are computed over the whole test so far, not per
interval. A spike in minute 9 of a 30-minute test barely moves them. Native histograms
(`k6_http_req_duration_seconds`) let Grafana compute real windowed percentiles with
`histogram_quantile()`. The pinned Prometheus (v3.15) accepts native histograms over remote write
with no extra flag. Older versions (all of 2.x and early 3.x) need `--enable-feature=native-histograms`.

Tag every run with `--tag testid=...` and pick it in the dashboard's Test ID dropdown to compare runs.

## JMeter

```sh
jmeter -n -t jmeter/sample-test.jmx -q jmeter/user.properties -Jhost=your-test-env.example.com
```

To add monitoring to your own plan, add a Backend Listener with implementation
`org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient` and set:

| Parameter     | Value                                  |
|---------------|----------------------------------------|
| influxdbUrl   | http://localhost:8086/write?db=jmeter  |
| application   | a name for the system under test       |
| measurement   | jmeter                                 |
| percentiles   | 50;95;99                               |

Use `jmeter/user.properties` (`backend_metrics_window_mode=timed`). Without it, percentiles come
from a sliding window of the last 100 samples rather than each 5-second interval. Even in timed
mode the `statut=all` percentiles stay on the 100-sample window, so the dashboard plots p95 from
the `statut=ok` rows.

## node-exporter (system under test)

node-exporter belongs on the server you are testing, not on your laptop. On a Linux test server:

```sh
docker compose --profile linux-host up -d node-exporter
```

or install the binary from https://github.com/prometheus/node_exporter/releases. Then edit
`prometheus/prometheus.yml` so the `node` job points at each server (`app-1:9100`, `db-1:9100`)
and reload: `docker compose restart prometheus`.

On Docker Desktop (Mac or Windows) the linux-host profile only shows Docker's own Linux VM, which
is fine for trying the dashboard but tells you nothing about your system under test.

## Stop

```sh
docker compose down      # keep the data
docker compose down -v   # delete Prometheus, InfluxDB and Grafana data too
```

## Notes

- Image tags are pinned (Prometheus v3.15.1, Grafana 13.2.5, node-exporter v1.12.1,
  InfluxDB 1.8, k6 1.8.2). Bump them deliberately.
- The default Grafana password is for a local machine only. Change it before exposing port 3000.
- Do not run the load generator and this stack on the system under test. They compete for CPU.
