// Live readings come from the sensor ingestion API on the same host.
//   /cam/             -> production database
//   /cam/?source=dev  -> development (test) database, test_mode records included
const API_ROOTS = {
  live: "/cam/api/v1",
  dev: "/cam/dev/api/v1",
};

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function dataSource(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("source") === "dev" ? "dev" : "live";
}

export function dashboardUrl(source = dataSource()) {
  const url = `${API_ROOTS[source]}/dashboard`;
  return source === "dev" ? `${url}?include_test=true` : url;
}

export async function fetchDashboard(source = dataSource(), fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(dashboardUrl(source), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.nodes)) throw new Error("Dashboard API returned an unexpected body");
  return body;
}
