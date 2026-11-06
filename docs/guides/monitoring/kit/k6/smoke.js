// Small sample test for checking the stack works. Point TARGET_URL at your own system.
//   K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
//   k6 run -o experimental-prometheus-rw --tag testid=$(date +%Y%m%d-%H%M) k6/smoke.js
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.TARGET_URL || 'https://quickpizza.grafana.com';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      stages: [
        { target: 5, duration: '30s' },
        { target: 5, duration: '1m' },
        { target: 0, duration: '15s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const res = http.get(`${BASE}/`, { tags: { name: 'home' } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}
