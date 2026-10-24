export async function request(path, { method = "GET", body, ...options } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    ...options,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json", ...options.headers },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response
    .json()
    .catch(() => ({ error: "The library returned an unreadable response." }));
  if (!response.ok)
    throw new Error(
      result.message || result.error || `Request failed (${response.status}).`,
    );
  return result;
}
async function sendCatalogFile(path, file, headers = {}) {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers,
    body: file,
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({ error: "The catalog returned an unreadable response." }));
  if (!response.ok) throw new Error(result.message || result.error || "Could not import this catalog file.");
  return result;
}
export const api = {
  list: () => request("/titles"),
  settings: () => request("/settings"),
  catalog: () => request("/catalog"),
  searchCatalog: (query, year) => request("/catalog/search", {
    method: "POST", body: { query, ...(year ? { year } : {}) },
  }),
  importCatalog: (file) => sendCatalogFile("/catalog/import", file, { "Content-Type": "text/csv" }),
  catalogPoster: (file) => sendCatalogFile("/catalog/posters", file, {
    "Content-Type": file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[file.name.split(".").pop().toLowerCase()] || "application/octet-stream",
    "X-File-Name": encodeURIComponent(file.name),
  }),
  applyCatalog: (id, catalogId) => request(`/titles/${encodeURIComponent(id)}/catalog`, {
    method: "POST", body: { catalogId },
  }),
  conversion: () => request("/conversion"),
  conversionJobs: () => request("/conversion/jobs"),
  convert: (id) =>
    request(`/titles/${encodeURIComponent(id)}/conversions`, { method: "POST", body: {} }),
  cancelConversion: (id) =>
    request(`/conversion/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }),
  update: (id, body) =>
    request(`/titles/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  remove: (id) =>
    request(`/titles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  async poster(id, blob) {
    const response = await fetch(
      `/api/titles/${encodeURIComponent(id)}/poster`,
      {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.message || data.error || "Could not save this cover.",
      );
    return data;
  },
  upload(file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream",
      );
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) =>
        onProgress?.(
          e.lengthComputable
            ? Math.min(99, Math.round((e.loaded / e.total) * 100))
            : 0,
        );
      xhr.onload = () => {
        let result;
        try {
          result = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error("The library returned an unreadable response."));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else
          reject(
            new Error(
              result.message ||
                result.error ||
                `Upload failed (${xhr.status}).`,
            ),
          );
      };
      xhr.onerror = () =>
        reject(
          new Error(
            "Connection lost. Keep the local app running and try again.",
          ),
        );
      xhr.onabort = () =>
        reject(new DOMException("Upload canceled.", "AbortError"));
      if (signal?.aborted) {
        reject(new DOMException("Upload canceled.", "AbortError"));
        return;
      }
      const abort = () => xhr.abort();
      signal?.addEventListener("abort", abort, { once: true });
      xhr.onloadend = () => signal?.removeEventListener("abort", abort);
      xhr.send(file);
    });
  },
};
