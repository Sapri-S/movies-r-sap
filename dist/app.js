import { api } from "./api.js";
import { icon, hydrateIcons } from "./icons.js";

const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const palettes = {
  amber: ["#9e5438", "#251b1c"],
  teal: ["#286e72", "#101e29"],
  violet: ["#6c507e", "#20182a"],
  forest: ["#647365", "#152a28"],
  rose: ["#a75e61", "#361c2b"],
  blue: ["#456f98", "#132033"],
};
const presets = [
  {
    key: "afterlight",
    title: "Afterlight",
    genre: "Adventure · Drama",
    palette: "amber",
  },
  {
    key: "deep-water",
    title: "Deep Water",
    genre: "Mystery · Thriller",
    palette: "teal",
  },
  {
    key: "last-orbit",
    title: "The Last Orbit",
    genre: "Science fiction",
    palette: "blue",
  },
  {
    key: "wild-north",
    title: "Wild North",
    genre: "Adventure · Nature",
    palette: "forest",
  },
  {
    key: "neon-nights",
    title: "Neon Nights",
    genre: "Drama · Thriller",
    palette: "violet",
  },
  {
    key: "slow-summer",
    title: "A Slow Summer",
    genre: "Drama · Romance",
    palette: "rose",
  },
];
const categories = { movie: "Movie", tv: "TV show", home: "Home video" };
const state = {
  titles: [],
  settings: null,
  view: "home",
  filter: "all",
  search: "",
  sort: "recent",
  online: false,
  loading: true,
  detailId: null,
  playerId: null,
  uploadItems: [],
  uploading: false,
  uploadController: null,
  uploadCategory: "movie",
  preset: null,
  editPalette: "amber",
};
const modal = $("#modal"),
  playerDialog = $("#player-dialog"),
  video = $("#video-player");
let toastTimer,
  progressTimer,
  lastProgressTime = 0,
  progressSequence = Promise.resolve(),
  playerGeneration = 0;

function coverStyle(palette = "amber") {
  const colors = palettes[palette] || palettes.amber;
  return `--cover-light:${colors[0]};--cover-dark:${colors[1]}`;
}
function bytes(value = 0) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const order = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** order).toFixed(order > 1 ? 1 : 0)} ${units[order]}`;
}
function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes} min`;
}
function toast(message) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  toastTimer = setTimeout(() => element.classList.remove("visible"), 4500);
}
function findTitle(id) {
  return state.titles.find((title) => title.id === id);
}
function mergeTitle(title) {
  const index = state.titles.findIndex((item) => item.id === title.id);
  if (index === -1) state.titles.unshift(title);
  else state.titles[index] = title;
}
function posterURL(title) {
  return title.poster
    ? `/api/titles/${encodeURIComponent(title.id)}/poster?v=${encodeURIComponent(title.updatedAt)}`
    : null;
}
function coverHTML(title) {
  const poster = posterURL(title);
  return poster
    ? `<img src="${poster}" alt="" loading="lazy">`
    : `<div class="generated-cover"><span class="cover-kicker">MOVIES R SAP · YOUR COLLECTION</span><span class="cover-orbit"></span><span class="cover-name">${escape(title.title)}</span></div>`;
}
function movieCard(title) {
  const progress =
    title.duration > 0
      ? Math.min(100, (title.position / title.duration) * 100)
      : 0;
  return `<article class="movie-card"><button class="movie-cover-button" data-action="play" data-id="${escape(title.id)}" aria-label="Play ${escape(title.title)}"><div class="movie-cover" style="${coverStyle(title.palette)}">${coverHTML(title)}${!title.available ? '<span class="movie-badge unavailable">FILE UNAVAILABLE</span>' : title.completed ? '<span class="movie-badge">WATCHED</span>' : ""}<div class="cover-overlay"><span>${icon("play", 18)}</span></div>${progress > 0 && !title.completed ? `<div class="progress-track"><span style="width:${progress}%"></span></div>` : ""}</div></button><button class="icon-button watchlist-icon ${title.watchlist ? "saved" : ""}" data-action="watchlist" data-id="${escape(title.id)}" aria-label="${title.watchlist ? "Remove" : "Add"} ${escape(title.title)} ${title.watchlist ? "from" : "to"} My List" aria-pressed="${title.watchlist}">${icon(title.watchlist ? "check" : "plus", 15)}</button><div class="movie-info"><div class="info-copy"><h3>${escape(title.title)}</h3><p>${escape([title.year, categories[title.category], duration(title.duration)].filter(Boolean).join(" · "))}</p></div><button class="icon-button" data-action="detail" data-id="${escape(title.id)}" aria-label="Details for ${escape(title.title)}">${icon("more", 17)}</button></div></article>`;
}
function emptyHTML() {
  const searching = state.search || state.filter !== "all";
  const list = state.view === "watchlist";
  return `<div class="empty-state"><div class="empty-symbol">${icon(searching ? "search" : list ? "heart" : "folder", 27)}</div><div><h3>${state.loading ? "Opening your library…" : searching ? "No matching titles." : list ? "Keep your next movie close." : "Your library starts with you."}</h3><p>${state.loading ? "Just a moment." : searching ? "Try another search or add a video to this collection." : list ? "Tap the + on a movie to save it to My List." : "Add a movie, a favorite show, or a memory worth watching again."}</p></div>${!state.loading ? `<button class="button button-outline" data-action="${searching ? "clear-search" : "upload"}">${icon(searching ? "close" : "plus", 15)}${searching ? "Clear filters" : "Add videos"}</button>` : ""}</div>`;
}
function filteredTitles() {
  let titles = state.titles.filter((title) => {
    if (state.view === "watchlist" && !title.watchlist) return false;
    if (state.filter !== "all" && title.category !== state.filter) return false;
    const term = state.search.trim().toLowerCase();
    return (
      !term ||
      `${title.title} ${title.description} ${title.originalName} ${title.year ?? ""}`
        .toLowerCase()
        .includes(term)
    );
  });
  titles.sort(
    state.sort === "title"
      ? (a, b) => a.title.localeCompare(b.title)
      : state.sort === "year"
        ? (a, b) => (b.year || 0) - (a.year || 0)
        : (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  return titles;
}
function renderLibrary() {
  const titles = filteredTitles();
  $("#movie-grid").innerHTML = titles.length
    ? titles.map(movieCard).join("")
    : emptyHTML();
  const headings = {
    home: "Your collection",
    movies: "Movies",
    tv: "TV Shows",
    watchlist: "My List",
  };
  $("#collection-title").innerHTML =
    `${headings[state.view] || "Your collection"} <span class="count" id="collection-count">${titles.length}</span>`;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.filter === state.filter),
    );
  });
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === state.view);
    if (link.dataset.view === state.view)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.body.classList.toggle("subpage", state.view !== "home");
  $("#inspiration").hidden =
    state.titles.length > 0 || state.view !== "home" || Boolean(state.search);
  $("#hero-upload-label").textContent = state.titles.length
    ? "Add to your collection"
    : "Add your first movie";
  const results = $("#results-description");
  results.hidden = !state.search;
  results.textContent = `${titles.length} ${titles.length === 1 ? "title" : "titles"} for “${state.search}”`;
  renderContinue();
}
function renderContinue() {
  const titles = state.titles
    .filter(
      (title) =>
        title.position > 3 &&
        title.duration > 0 &&
        !title.completed &&
        title.available,
    )
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 4);
  $("#continue-section").hidden =
    !titles.length || state.view !== "home" || Boolean(state.search);
  $("#continue-grid").innerHTML = titles
    .map(
      (title) =>
        `<button class="continue-card" data-action="play" data-id="${escape(title.id)}" aria-label="Continue ${escape(title.title)}"><div class="continue-art" style="${coverStyle(title.palette)}">${posterURL(title) ? `<img src="${posterURL(title)}" alt="">` : ""}<span class="continue-play">${icon("play", 13)}</span><div class="progress-track"><span style="width:${Math.min(100, (title.position / title.duration) * 100)}%"></span></div></div><h3>${escape(title.title)}</h3><p>${duration(Math.max(0, title.duration - title.position))} left · ${Math.round((title.position / title.duration) * 100)}% watched</p></button>`,
    )
    .join("");
}
function renderPresets() {
  $("#poster-grid").innerHTML = presets
    .map(
      (preset) =>
        `<button class="poster-card" data-action="preset" data-preset="${preset.key}" aria-label="Preview ${preset.title} cover style"><div class="poster-cover"><img src="/assets/${preset.key}.svg" alt="${preset.title} original sample artwork" loading="lazy"><div class="cover-overlay"><span>${icon("image", 13)}Preview artwork</span></div></div><h3>${preset.title}</h3><p>${preset.genre}</p></button>`,
    )
    .join("");
}
async function refresh({ silent = false } = {}) {
  try {
    const [titles, settings] = await Promise.all([api.list(), api.settings()]);
    state.titles = titles;
    state.settings = settings;
    state.online = true;
    $("#connection-banner").hidden = true;
  } catch (error) {
    state.online = false;
    $("#connection-banner").hidden = false;
    if (!silent) toast(error.message);
  } finally {
    state.loading = false;
    renderLibrary();
  }
}
function openDialog({
  title,
  eyebrow = "YOUR PERSONAL CINEMA",
  body,
  footer = "",
  className = "",
}) {
  if (modal.open) modal.close();
  modal.className = className;
  $("#dialog-shell").innerHTML =
    `<div class="dialog-header"><div><span class="eyebrow">${escape(eyebrow)}</span><h2 id="modal-title">${escape(title)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div>${body}${footer ? `<div class="dialog-actions">${footer}</div>` : ""}`;
  modal.showModal();
}
function closeModal() {
  if (state.uploading) {
    toast("Cancel the active upload before closing, or let it finish.");
    return;
  }
  modal.close();
}
function showUpload(preset = null) {
  state.preset = preset;
  state.uploadItems = [];
  state.uploadCategory = "movie";
  openDialog({
    title: "Bring your collection home.",
    eyebrow: "ADD VIDEOS",
    body: `<p class="dialog-description">Your favorites deserve a place of their own. Videos are copied into your library folder on this PC.</p>${preset ? `<p class="file-note">Cover style: ${escape(preset.title)}. Your video keeps its own title.</p>` : ""}<div id="drop-zone" class="drop-zone"><span class="drop-icon">${icon("upload", 28)}</span><h3>Drop your videos here</h3><p>Movies, shows, home videos. Make it yours.</p><button class="button button-primary" data-action="choose-files">${icon("plus", 16)}Choose files</button></div><p class="file-note">MP4 and WebM are good starting points. Playback depends on the video and audio formats inside the file. DVD videos already converted to a compatible file can be added here.</p><label class="field">Add to<select id="upload-category"><option value="movie">Movies</option><option value="tv">TV Shows</option><option value="home">Home videos</option></select></label><div class="upload-queue" id="upload-queue" aria-live="polite"></div><p class="upload-summary" id="upload-summary" hidden></p>`,
    footer: `<button class="button button-outline" data-action="close-modal" id="upload-done">Done</button>`,
  });
  const zone = $("#drop-zone");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    queueFiles([...event.dataTransfer.files]);
  });
  $("#upload-category").addEventListener("change", (event) => {
    state.uploadCategory = event.target.value;
  });
}
function renderUploadQueue() {
  const queue = $("#upload-queue");
  if (!queue) return;
  queue.innerHTML = state.uploadItems
    .map(
      (item, index) =>
        `<div class="queue-item"><div class="queue-line">${icon(item.status === "done" ? "check" : item.status === "failed" ? "alert" : "film", 17)}<span class="queue-name">${escape(item.file.name)}</span><span class="queue-status ${item.status === "done" ? "done" : item.status === "failed" ? "failed" : ""}">${item.status === "uploading" ? `${item.progress}%` : item.status === "processing" ? "Finishing…" : item.status === "done" ? "Added" : item.status === "failed" ? "Failed" : item.status === "canceled" ? "Canceled" : bytes(item.file.size)}</span>${item.status === "uploading" ? `<button class="icon-button" data-action="cancel-upload" aria-label="Cancel ${escape(item.file.name)}">${icon("close", 13)}</button>` : item.status === "failed" || item.status === "canceled" ? `<button class="text-button" data-action="retry-upload" data-index="${index}">Retry</button>` : ""}</div>${["uploading", "processing"].includes(item.status) ? `<div class="queue-progress"><span style="width:${item.progress}%"></span></div>` : ""}${item.error ? `<p class="queue-error">${escape(item.error)}</p>` : ""}</div>`,
    )
    .join("");
  const finished = state.uploadItems.filter(
    (item) => item.status === "done",
  ).length;
  const summary = $("#upload-summary");
  summary.hidden = !state.uploadItems.length;
  summary.textContent = state.uploading
    ? "Keep this app open while your videos are added."
    : `${finished} ${finished === 1 ? "video" : "videos"} added to your collection.`;
  $("#upload-done").disabled = state.uploading;
  $("#upload-category").disabled = state.uploading;
}
function queueFiles(files) {
  const accepted = files.filter((file) =>
    /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(file.name),
  );
  if (accepted.length !== files.length)
    toast("Choose video files: MP4, WebM, M4V, MOV, MKV, or AVI.");
  for (const file of accepted)
    state.uploadItems.push({
      file,
      status: "queued",
      progress: 0,
      error: null,
    });
  renderUploadQueue();
  processQueue();
}
async function processQueue() {
  if (state.uploading) return;
  state.uploading = true;
  renderUploadQueue();
  let item;
  while ((item = state.uploadItems.find((next) => next.status === "queued"))) {
    item.status = "uploading";
    state.uploadController = new AbortController();
    renderUploadQueue();
    try {
      let title = await api.upload(item.file, {
        signal: state.uploadController.signal,
        onProgress: (progress) => {
          item.progress = progress;
          renderUploadQueue();
        },
      });
      item.uploadedId = title.id;
      mergeTitle(title);
      item.status = "processing";
      item.progress = 100;
      renderUploadQueue();
      try {
        title = await api.update(title.id, {
          category: state.uploadCategory,
          palette:
            state.preset?.palette ||
            Object.keys(palettes)[state.titles.length % 6],
        });
        mergeTitle(title);
      } catch (error) {
        item.error = `Video added. Details could not be updated: ${error.message} You can edit them from the library.`;
      }
      try {
        const cover = state.preset
          ? await makePresetCover(state.preset)
          : await makeThumbnail(item.file);
        if (cover) {
          title = await api.poster(title.id, cover);
          mergeTitle(title);
        }
      } catch {
        item.error =
          item.error ||
          "Video added. The cover could not be saved; you can add one from movie details.";
      }
      item.status = "done";
      item.progress = 100;
    } catch (error) {
      item.status = error.name === "AbortError" ? "canceled" : "failed";
      item.error = error.name === "AbortError" ? null : error.message;
    }
    renderUploadQueue();
    renderLibrary();
  }
  state.uploading = false;
  state.uploadController = null;
  renderUploadQueue();
  await refresh({ silent: true });
}
function makePresetCover(preset) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 600;
        canvas.getContext("2d").drawImage(image, 0, 0, 400, 600);
        canvas.toBlob(resolve, "image/png");
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = `/assets/${preset.key}.svg`;
  });
}
function makeThumbnail(file) {
  return new Promise((resolve) => {
    const element = document.createElement("video");
    const url = URL.createObjectURL(file);
    let finished = false;
    const timeout = setTimeout(() => finish(null), 6000);
    function finish(blob) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      resolve(blob);
    }
    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => {
      if (!Number.isFinite(element.duration) || !element.videoWidth) {
        finish(null);
        return;
      }
      element.currentTime = Math.min(15, element.duration * 0.12);
    };
    element.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = Math.round(
          (element.videoHeight * 640) / element.videoWidth,
        );
        canvas.height = Math.min(canvas.height, 1280);
        canvas
          .getContext("2d")
          .drawImage(element, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(finish, "image/jpeg", 0.8);
      } catch {
        finish(null);
      }
    };
    element.onerror = () => finish(null);
    element.src = url;
  });
}
async function showDetail(id) {
  const title = findTitle(id);
  if (!title) return;
  state.detailId = id;
  openDialog({
    title: "A closer look.",
    eyebrow: "IN YOUR COLLECTION",
    body: `<div class="detail-cover"><div class="detail-art movie-cover" style="${coverStyle(title.palette)}">${coverHTML(title)}</div><div class="detail-copy"><p class="meta-line">${escape([title.year, categories[title.category], duration(title.duration)].filter(Boolean).join(" · "))}</p><h3>${escape(title.title)}</h3><p>${escape(title.description || "One of your stories. Ready when you are.")}</p><button class="button button-primary" data-action="play" data-id="${escape(id)}">${icon("play", 16)}${title.position > 3 && !title.completed ? "Continue watching" : "Play movie"}</button></div></div>${!title.available ? '<div class="danger-box">This video file is unavailable. Check that your library folder is still in place.</div>' : ""}<div class="detail-options"><button class="button button-outline" data-action="watchlist" data-id="${escape(id)}">${icon(title.watchlist ? "check" : "plus", 15)}${title.watchlist ? "In My List" : "My List"}</button><button class="button button-outline" data-action="edit" data-id="${escape(id)}">${icon("edit", 15)}Edit details</button><button class="button button-outline" data-action="choose-poster" data-id="${escape(id)}">${icon("image", 15)}Change cover</button>${title.position > 0 || title.completed ? `<button class="button button-outline" data-action="reset-progress" data-id="${escape(id)}">${icon("back", 15)}Start over</button>` : ""}</div><div class="detail-file"><span>Original file</span><br>${escape(title.originalName)} · ${bytes(title.fileSize)}<br><br><button class="text-button danger-link" data-action="confirm-delete" data-id="${escape(id)}">${icon("trash", 13)}Remove from library</button></div>`,
  });
}
function showEdit(id) {
  const title = findTitle(id);
  if (!title) return;
  state.editPalette = title.palette || "amber";
  openDialog({
    title: "Make it yours.",
    eyebrow: "EDIT DETAILS",
    body: `<form id="edit-form"><label class="field">Title<input name="title" required maxlength="200" value="${escape(title.title)}"></label><div class="field-row"><label class="field">Collection<select name="category">${Object.entries(
      categories,
    )
      .map(
        ([value, label]) =>
          `<option value="${value}" ${title.category === value ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="field">Release year<input name="year" type="number" min="1888" max="${new Date().getFullYear() + 10}" placeholder="Optional" value="${title.year ?? ""}"></label></div><label class="field">Description<textarea name="description" maxlength="2000" placeholder="A little about this story…">${escape(title.description)}</textarea></label><label class="field">Cover color<span class="field-hint">Used when no cover image is set.</span></label><div class="cover-choices">${Object.keys(
      palettes,
    )
      .map(
        (palette) =>
          `<button type="button" class="cover-choice ${palette === state.editPalette ? "selected" : ""}" style="${coverStyle(palette)}" data-action="palette" data-palette="${palette}" aria-label="${palette} cover" aria-pressed="${palette === state.editPalette}"></button>`,
      )
      .join(
        "",
      )}</div><p class="form-message" id="edit-message" hidden></p><div class="dialog-actions"><button type="button" class="button button-outline" data-action="detail" data-id="${escape(id)}">Cancel</button><button type="submit" class="button button-primary" id="save-details">Save changes</button></div></form>`,
  });
  $("#edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("#save-details");
    button.disabled = true;
    const data = new FormData(form);
    try {
      const saved = await api.update(id, {
        title: String(data.get("title")).trim(),
        category: data.get("category"),
        year: data.get("year") ? Number(data.get("year")) : null,
        description: String(data.get("description")).trim(),
        palette: state.editPalette,
      });
      mergeTitle(saved);
      renderLibrary();
      if (form.isConnected && modal.open) showDetail(id);
      toast("Details updated.");
    } catch (error) {
      if (form.isConnected && modal.open) {
        const message = form.querySelector("#edit-message");
        message.textContent = error.message;
        message.hidden = false;
        button.disabled = false;
      } else toast(error.message);
    }
  });
}
function confirmDelete(id) {
  const title = findTitle(id);
  if (!title) return;
  openDialog({
    title: "Remove this movie?",
    eyebrow: "YOUR LIBRARY, YOUR CALL",
    body: `<p class="dialog-description">Remove <strong>${escape(title.title)}</strong> from your collection?</p><div class="danger-box">This deletes its library entry, watch progress, cover, and the video copy stored by this app. The original file you uploaded from stays untouched.</div>`,
    footer: `<button class="button button-outline" data-action="detail" data-id="${escape(id)}">Keep movie</button><button class="button button-primary" data-action="delete" data-id="${escape(id)}">${icon("trash", 15)}Remove movie</button>`,
  });
}
async function toggleWatchlist(id) {
  const title = findTitle(id);
  if (!title) return;
  try {
    const saved = await api.update(id, { watchlist: !title.watchlist });
    mergeTitle(saved);
    renderLibrary();
    if (modal.open && state.detailId === id && !$("#edit-form")) showDetail(id);
    toast(saved.watchlist ? "Added to My List." : "Removed from My List.");
  } catch (error) {
    toast(error.message);
  }
}
function showSettings() {
  const settings = state.settings;
  openDialog({
    title: "A home for your stories.",
    eyebrow: "LIBRARY SETTINGS",
    body: `<p class="dialog-description">Your collection lives on this PC. Keep the app running while you browse and watch.</p><div class="setting-row">${icon("server", 22)}<div><h3>Library connection</h3><p>${state.online ? "Connected to this PC" : "Local backend unavailable"}</p></div><span class="tag ${state.online ? "tag-green" : ""}">${state.online ? "LOCAL" : "OFFLINE"}</span></div><div class="setting-row">${icon("folder", 22)}<div><h3>Video storage</h3><p>${escape(settings?.mediaPath || settings?.libraryPath || "Start the app to see your library path.")}</p></div></div><div class="setting-row">${icon("film", 22)}<div><h3>Your collection</h3><p>${state.titles.length} ${state.titles.length === 1 ? "title" : "titles"} · ${bytes(settings?.usageBytes || 0)} in your library${settings?.freeBytes != null ? ` · ${bytes(settings.freeBytes)} disk space available` : ""}</p></div></div><div class="settings-actions"><a class="button button-outline" href="/api/export" download="movies-r-sap-library.json">${icon("download", 15)}Export library metadata</a><button class="button button-outline" data-action="roadmap">${icon("disc", 15)}DVDs & what’s next</button></div><p class="settings-footnote">Metadata export includes titles and file mappings, not video files or cover images. For a complete backup, stop the app and copy the entire data folder, including the database, media, and posters. Home-network access is a future feature.</p>`,
  });
}
function showRoadmap() {
  openDialog({
    title: "A bigger picture ahead.",
    eyebrow: "GROW WITH YOUR COLLECTION",
    body: `<p class="dialog-description">A personal cinema today. Room for the rest of your collection tomorrow.</p><div class="roadmap-list"><div class="roadmap-step current"><span>01</span><div><h3>Your files, on this PC</h3><p>Upload videos, organize your collection, save a watchlist, and pick up where you left off. Already converted DVD videos work through Add videos.</p></div></div><div class="roadmap-step"><span>02</span><div><h3>DVD importing & physical media</h3><p>Planned: catalog your discs and import supported DVDs using a drive on this PC. Disc scanning and conversion are not built into this release.</p></div></div><div class="roadmap-step"><span>03</span><div><h3>Your own home server</h3><p>Planned: existing-folder imports, network storage, and access from your other devices. Your library currently stays on this PC.</p></div></div></div>`,
    footer: `<button class="button button-primary" data-action="upload">${icon("plus", 16)}Add a video</button>`,
  });
}
function showPreset(key) {
  const preset = presets.find((item) => item.key === key);
  if (!preset) return;
  openDialog({
    title: preset.title,
    eyebrow: "ORIGINAL ARTWORK PREVIEW",
    body: `<div class="detail-cover"><div class="detail-art"><img src="/assets/${preset.key}.svg" alt="${preset.title} sample artwork"></div><div class="detail-copy"><p class="meta-line">${preset.genre}</p><h3>Set the scene.</h3><p>This is sample cover artwork, not an included movie. Add your own video to begin your collection.</p><button class="button button-primary" data-action="upload-preset" data-preset="${preset.key}">${icon("plus", 15)}Add your video</button></div></div>`,
  });
}

async function playTitle(id) {
  const title = findTitle(id);
  if (!title) return;
  if (!title.available) {
    showDetail(id);
    toast("This video file is unavailable. Check your library folder.");
    return;
  }
  if (state.uploading) {
    toast("Let your current uploads finish before opening the player.");
    return;
  }
  if (playerDialog.open) await closePlayer();
  if (modal.open) modal.close();
  state.playerId = id;
  const generation = ++playerGeneration;
  $("#player-title").textContent = title.title;
  $("#player-meta").textContent = [
    categories[title.category],
    title.year,
    title.originalName,
  ]
    .filter(Boolean)
    .join(" · ");
  $("#player-error").hidden = true;
  video.poster = posterURL(title) || "";
  video.src = `/api/titles/${encodeURIComponent(id)}/stream`;
  lastProgressTime = 0;
  video.onloadedmetadata = () => {
    if (generation !== playerGeneration) return;
    if (Number.isFinite(video.duration)) {
      title.duration = video.duration;
      if (
        title.position > 0 &&
        !title.completed &&
        title.position < video.duration - 1
      )
        video.currentTime = title.position;
      saveProgress(false);
    }
    video.play().catch(() => {});
  };
  video.onerror = () => {
    if (generation !== playerGeneration) return;
    $("#player-error").innerHTML =
      `${icon("alert", 26)}<h3>This video couldn’t play.</h3><p>The file may use a video or audio format this browser can’t decode, or its file is unavailable. Try a browser-compatible MP4 or WebM file. Automatic conversion is a future feature.</p><button class="button button-outline" id="player-error-close">Back to library</button>`;
    $("#player-error").hidden = false;
    $("#player-error-close").onclick = closePlayer;
  };
  video.onended = () => saveProgress(true);
  video.onpause = () => {
    if (state.playerId) saveProgress(false);
  };
  video.ontimeupdate = () => {
    if (Date.now() - lastProgressTime > 5000) {
      lastProgressTime = Date.now();
      saveProgress(false);
    }
  };
  playerDialog.showModal();
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (state.playerId && !video.paused) saveProgress(false);
  }, 10000);
}
function saveProgress(ended = false) {
  const id = state.playerId;
  if (
    !id ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0 ||
    !Number.isFinite(video.currentTime)
  )
    return Promise.resolve();
  const position = ended ? video.duration : video.currentTime;
  const completed = ended || position >= video.duration * 0.95;
  const updates = { position, duration: video.duration, completed };
  const title = findTitle(id);
  if (title) Object.assign(title, updates);
  progressSequence = progressSequence
    .catch(() => {})
    .then(async () => {
      try {
        const saved = await api.update(id, updates);
        mergeTitle(saved);
      } catch (error) {
        toast(`Watch progress wasn’t saved: ${error.message}`);
      }
    });
  return progressSequence;
}
function closePlayer() {
  if (!playerDialog.open) return;
  video.pause();
  void saveProgress(video.ended);
  state.playerId = null;
  playerGeneration++;
  clearInterval(progressTimer);
  video.onloadedmetadata = null;
  video.onerror = null;
  video.onpause = null;
  video.ontimeupdate = null;
  video.onended = null;
  video.removeAttribute("src");
  video.load();
  playerDialog.close();
  renderLibrary();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "upload") showUpload();
    else if (action === "upload-preset")
      showUpload(
        presets.find((preset) => preset.key === button.dataset.preset),
      );
    else if (action === "choose-files") $("#file-picker").click();
    else if (action === "close-modal") closeModal();
    else if (action === "cancel-upload") state.uploadController?.abort();
    else if (action === "retry-upload") {
      const item = state.uploadItems[Number(button.dataset.index)];
      if (item) {
        item.status = "queued";
        item.error = null;
        item.progress = 0;
        processQueue();
      }
    } else if (action === "settings") showSettings();
    else if (action === "roadmap") showRoadmap();
    else if (action === "refresh") refresh();
    else if (action === "play") await playTitle(id);
    else if (action === "detail") showDetail(id);
    else if (action === "edit") showEdit(id);
    else if (action === "watchlist") await toggleWatchlist(id);
    else if (action === "confirm-delete") confirmDelete(id);
    else if (action === "delete") {
      button.disabled = true;
      await api.remove(id);
      state.titles = state.titles.filter((title) => title.id !== id);
      if (button.isConnected && modal.open) modal.close();
      await refresh({ silent: true });
      toast("Removed from your library. Your original file is untouched.");
    } else if (action === "choose-poster") {
      state.detailId = id;
      $("#poster-picker").click();
    } else if (action === "reset-progress") {
      mergeTitle(await api.update(id, { position: 0, completed: false }));
      renderLibrary();
      showDetail(id);
      toast("Ready to watch from the beginning.");
    } else if (action === "palette") {
      state.editPalette = button.dataset.palette;
      document.querySelectorAll(".cover-choice").forEach((choice) => {
        const selected = choice.dataset.palette === state.editPalette;
        choice.classList.toggle("selected", selected);
        choice.setAttribute("aria-pressed", String(selected));
      });
    } else if (action === "preset") showPreset(button.dataset.preset);
    else if (action === "clear-search") {
      state.search = "";
      state.filter = "all";
      $("#search").value = "";
      renderLibrary();
    }
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});
document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderLibrary();
  }),
);
$("#search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderLibrary();
  if (state.search && state.view === "home")
    $("#collection").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderLibrary();
});
$("#file-picker").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  if (!$("#upload-queue")) showUpload();
  queueFiles(files);
});
$("#poster-picker").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const id = state.detailId;
  const currentDialog = $("#dialog-shell").firstElementChild;
  event.target.value = "";
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast("Choose a cover image smaller than 10 MB.");
    return;
  }
  try {
    const title = await api.poster(id, file);
    mergeTitle(title);
    renderLibrary();
    if (currentDialog.isConnected && modal.open) showDetail(title.id);
    toast("Cover updated.");
  } catch (error) {
    toast(error.message);
  }
});
modal.addEventListener("cancel", (event) => {
  if (state.uploading) {
    event.preventDefault();
    toast("Cancel the active upload before closing, or let it finish.");
  }
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeModal();
  }
});
$("#close-player").addEventListener("click", closePlayer);
playerDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePlayer();
});
window.addEventListener("beforeunload", (event) => {
  if (state.uploading) {
    event.preventDefault();
    event.returnValue = "";
  }
  if (state.playerId && Number.isFinite(video.duration)) {
    fetch(`/api/titles/${encodeURIComponent(state.playerId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        position: video.currentTime,
        duration: video.duration,
        completed: video.ended || video.currentTime >= video.duration * 0.95,
      }),
      keepalive: true,
    }).catch(() => {});
  }
});
function route() {
  const view = location.hash.slice(1);
  if (["home", "movies", "tv", "watchlist"].includes(view)) {
    state.view = view;
    state.filter = view === "movies" ? "movie" : view === "tv" ? "tv" : "all";
    state.search = "";
    $("#search").value = "";
    renderLibrary();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}
window.addEventListener("hashchange", route);
hydrateIcons();
renderPresets();
route();
refresh({ silent: true });
