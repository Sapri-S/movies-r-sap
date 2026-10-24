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
  playerFit: "contain",
  uploadItems: [],
  uploading: false,
  uploadController: null,
  uploadCategory: "movie",
  preset: null,
  editPalette: "amber",
  conversion: null,
  conversionJobs: [],
  conversionError: null,
  conversionLoading: true,
  conversionPolling: false,
  conversionMutation: 0,
  conversionCheckedOutputs: new Set(),
  catalogStatus: null,
  catalogBusy: false,
  catalogMessage: "",
  catalogFailure: false,
  catalogProgress: 0,
  catalogStatusGeneration: 0,
};
const modal = $("#modal"),
  playerDialog = $("#player-dialog"),
  video = $("#video-player");
let toastTimer,
  progressTimer,
  lastProgressTime = 0,
  progressSequence = Promise.resolve(),
  playerGeneration = 0,
  libraryGeneration = 0,
  conversionTimer;

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
  const generation = ++libraryGeneration;
  try {
    const [titles, settings] = await Promise.all([api.list(), api.settings()]);
    if (generation !== libraryGeneration) return;
    state.titles = titles;
    state.settings = settings;
    state.online = true;
    $("#connection-banner").hidden = true;
  } catch (error) {
    if (generation !== libraryGeneration) return;
    state.online = false;
    $("#connection-banner").hidden = false;
    if (!silent) toast(error.message);
  } finally {
    if (generation === libraryGeneration) {
      state.loading = false;
      renderLibrary();
    }
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
function activeConversion(job) {
  return ["queued", "running"].includes(job.status);
}
function conversionError(error) {
  return typeof error === "string" ? error : error?.message || "Conversion could not finish. Try again.";
}
function conversionProgress(job) {
  return Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
}
function conversionTitle(job) {
  return findTitle(job.sourceTitleId)?.title || job.sourceTitle || "Video";
}
function conversionStatus(job) {
  if (job.cancelRequested && activeConversion(job)) return "Canceling…";
  return {
    queued: "Waiting",
    running: `Converting · ${conversionProgress(job)}%`,
    completed: "MP4 copy ready",
    failed: "Conversion failed",
    canceled: "Canceled",
    interrupted: "Interrupted when the app closed",
  }[job.status] || "Checking status…";
}
function conversionJobHTML(job) {
  const active = activeConversion(job);
  const output = findTitle(job.outputTitleId);
  return `<article class="conversion-job ${active ? "is-active" : ""}"><div class="conversion-job-header"><span class="conversion-job-icon">${icon(job.status === "completed" ? "check" : ["failed", "interrupted"].includes(job.status) ? "alert" : "film", 20)}</span><div><h3>${escape(conversionTitle(job))}</h3><p>${escape(conversionStatus(job))}</p></div><div class="conversion-job-actions">${active ? `<button class="text-button" data-action="cancel-conversion" data-id="${escape(job.id)}" ${job.cancelRequested ? "disabled" : ""}>Cancel</button>` : job.status === "completed" && output ? `<button class="button button-small button-primary" data-action="play" data-id="${escape(output.id)}">${icon("play", 13)}Play MP4</button>` : ["failed", "canceled", "interrupted"].includes(job.status) && findTitle(job.sourceTitleId)?.available ? `<button class="text-button" data-action="convert" data-id="${escape(job.sourceTitleId)}">Try again</button>` : ""}</div></div>${active ? `<div class="conversion-progress" role="progressbar" aria-label="Conversion progress for ${escape(conversionTitle(job))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${conversionProgress(job)}"><span style="width:${conversionProgress(job)}%"></span></div>` : ""}${job.error ? `<p class="conversion-error">${escape(conversionError(job.error))}</p>` : ""}${job.status === "interrupted" ? '<p class="conversion-footnote">The unfinished copy was not added. Start again to create it.</p>' : ""}${job.status === "completed" && !output ? '<p class="conversion-footnote">This conversion finished. Its MP4 copy is no longer in the library.</p>' : ""}</article>`;
}
function conversionDetailsHTML(title) {
  const job = state.conversionJobs.find((item) => item.sourceTitleId === title.id && activeConversion(item));
  const completed = state.conversionJobs.find((item) => item.sourceTitleId === title.id && item.status === "completed" && findTitle(item.outputTitleId));
  const isMKV = /\.mkv$/i.test(title.originalName || "");
  return `<div class="conversion-detail"><div><h3>${isMKV ? "MKV, made ready for movie night." : "Need a more compatible copy?"}</h3><p>${isMKV ? "MKV playback depends on its video and audio formats. " : ""}Create a separate MP4 copy on this PC. Your original stays in the library.</p></div>${job ? `<button class="button button-outline" data-action="conversions">${icon("film", 15)}${escape(conversionStatus(job))}</button>` : `<button class="button button-outline" data-action="convert" data-id="${escape(title.id)}" ${!title.available ? "disabled" : ""}>${icon("film", 15)}Convert to MP4</button>`}${completed && !job ? `<button class="text-button" data-action="play" data-id="${escape(completed.outputTitleId)}">${icon("play", 13)}Play existing MP4 copy</button>` : ""}</div>`;
}
function conversionAvailability(title) {
  const active = state.conversionJobs.find(activeConversion);
  if (!title.available) return "The original video is unavailable. Check your library folder first.";
  if (active) return `${conversionTitle(active)} is already converting. Wait for it to finish or cancel it first.`;
  if (state.conversionError) return state.conversionError;
  if (!state.conversion?.available) return state.conversion?.reason || (state.conversionLoading ? "Checking whether conversion is available…" : "The converter is unavailable on this PC.");
  return "";
}
function renderConversions() {
  const active = state.conversionJobs.filter(activeConversion);
  const banner = $("#conversion-banner");
  banner.hidden = !state.conversionJobs.length;
  if (!banner.hidden) {
    const latest = active[0] || state.conversionJobs[0];
    $("#conversion-banner-label").textContent = `${conversionTitle(latest)} · ${conversionStatus(latest)}`;
    banner.classList.toggle("is-active", active.length > 0);
  }
  const list = $("#conversion-job-list");
  if (list) {
    const focus = document.activeElement;
    const action = list.contains(focus) ? focus.dataset.action : null;
    const id = action ? focus.dataset.id : null;
    list.innerHTML = state.conversionJobs.length
      ? state.conversionJobs.map(conversionJobHTML).join("")
      : `<div class="conversion-empty">${icon("film", 26)}<h3>${state.conversionLoading ? "Checking conversions…" : "Your next compatible copy starts here."}</h3><p>Open a video’s details and choose Convert to MP4. Conversions run on this PC, one at a time.</p></div>`;
    if (action) {
      const replacement = [...list.querySelectorAll("[data-action]")].find((button) => button.dataset.action === action && button.dataset.id === id);
      replacement?.focus({ preventScroll: true });
    }
    const message = $("#conversion-status-message");
    message.hidden = !state.conversionError && (state.conversionLoading || state.conversion?.available);
    message.textContent = state.conversionError || state.conversion?.reason || "The converter is unavailable on this PC.";
  }
  const details = $("#detail-conversion");
  const title = findTitle(details?.dataset.id);
  if (details && title && !details.contains(document.activeElement)) details.innerHTML = conversionDetailsHTML(title);
  const confirmation = $("#convert-confirmation");
  const source = findTitle(confirmation?.dataset.id);
  if (confirmation && source) {
    const message = conversionAvailability(source);
    $("#convert-availability").hidden = !message;
    $("#convert-availability").textContent = message;
    $("[data-action='start-conversion']").disabled = Boolean(message) || confirmation.dataset.starting === "true";
  }
}
async function refreshConversions() {
  if (state.conversionPolling) return;
  state.conversionPolling = true;
  clearTimeout(conversionTimer);
  const mutation = state.conversionMutation;
  try {
    const [capability, response] = await Promise.all([api.conversion(), api.conversionJobs()]);
    const jobs = Array.isArray(response) ? response : response.jobs;
    state.conversion = capability;
    state.conversionError = null;
    if (mutation === state.conversionMutation) {
      const completed = jobs.filter((job) => job.status === "completed" && state.conversionJobs.some((previous) => previous.id === job.id && previous.status !== "completed"));
      const missing = jobs.filter((job) => job.status === "completed" && job.outputTitleId && !findTitle(job.outputTitleId) && !state.conversionCheckedOutputs.has(job.id));
      state.conversionJobs = jobs;
      if (completed.length || missing.length) {
        await refresh({ silent: true });
        if (state.online) {
          for (const job of [...completed, ...missing]) state.conversionCheckedOutputs.add(job.id);
          if (completed.some((job) => findTitle(job.outputTitleId))) toast("Your MP4 copy is ready. The original is still in your library.");
        }
      }
    }
  } catch (error) {
    state.conversionError = `Could not check conversions: ${error.message}`;
  } finally {
    state.conversionLoading = false;
    state.conversionPolling = false;
    renderConversions();
    conversionTimer = setTimeout(refreshConversions, state.conversionJobs.some(activeConversion) ? 1500 : 15000);
  }
}
function showConversions() {
  openDialog({
    title: "Ready for your player.",
    eyebrow: "MP4 CONVERSIONS",
    body: '<p class="dialog-description">Create compatible copies without changing your original videos. Keep the desktop app or browser server running until conversion finishes. Closing this dialog is fine.</p><p class="conversion-notice" id="conversion-status-message" hidden></p><div id="conversion-job-list" class="conversion-job-list"></div>',
    footer: '<button class="button button-outline" data-action="refresh-conversions">Refresh status</button><button class="button button-primary" data-action="close-modal">Done</button>',
  });
  renderConversions();
  void refreshConversions();
}
function showConvert(id) {
  const title = findTitle(id);
  if (!title) return;
  const availability = conversionAvailability(title);
  openDialog({
    title: "Make an MP4 copy.",
    eyebrow: "CONVERT ON THIS PC",
    body: `<div id="convert-confirmation" data-id="${escape(id)}"><p class="dialog-description">Convert <strong>${escape(title.title)}</strong> to a new MP4 in your library. Your original video and its saved progress stay untouched.</p><div class="conversion-profile"><span class="tag">MP4</span><div><h3>H.264 video · AAC stereo audio</h3><p>Includes the first video and first audio track, mixed to stereo. Subtitles, extra audio tracks, and other attachments stay in the original file.</p></div></div><p class="conversion-footnote">Conversion uses your PC’s processor and additional disk space. A full movie can take a while. Keep the app running; closing it interrupts the job. Nothing is converted automatically.</p><p class="conversion-notice" id="convert-availability" ${availability ? "" : "hidden"}>${escape(availability)}</p></div>`,
    footer: `<button class="button button-outline" data-action="conversions">View conversions</button><button class="button button-primary" data-action="start-conversion" data-id="${escape(id)}" ${availability ? "disabled" : ""}>${icon("film", 15)}Create MP4 copy</button>`,
  });
}
async function startConversion(id) {
  const job = await api.convert(id);
  state.conversionMutation++;
  state.conversionJobs = [job, ...state.conversionJobs.filter((previous) => previous.id !== job.id)];
  renderConversions();
  if (modal.open && $("#convert-confirmation")?.dataset.id === id) showConversions();
  toast("Conversion started. You can keep browsing your library.");
  void refreshConversions();
}
function showUpload(preset = null) {
  state.preset = preset;
  state.uploadItems = [];
  state.uploadCategory = "movie";
  openDialog({
    title: "Bring your collection home.",
    eyebrow: "ADD VIDEOS",
    body: `<p class="dialog-description">Your favorites deserve a place of their own. Videos are copied into your library folder on this PC.</p>${preset ? `<p class="file-note">Cover style: ${escape(preset.title)}. Your video keeps its own title.</p>` : ""}<div id="drop-zone" class="drop-zone"><span class="drop-icon">${icon("upload", 28)}</span><h3>Drop your videos here</h3><p>Movies, shows, home videos. Make it yours.</p><button class="button button-primary" data-action="choose-files">${icon("plus", 16)}Choose files</button></div><p class="file-note">MP4, WebM, MKV, M4V, MOV, and AVI accepted. Playback depends on the video and audio formats inside. If an MKV or another video won’t play, open its details and choose Convert to MP4. Conversion starts only when you choose it.</p><label class="field">Add to<select id="upload-category"><option value="movie">Movies</option><option value="tv">TV Shows</option><option value="home">Home videos</option></select></label><div class="upload-queue" id="upload-queue" aria-live="polite"></div><p class="upload-summary" id="upload-summary" hidden></p>`,
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
    body: `<div class="detail-cover"><div class="detail-art movie-cover" style="${coverStyle(title.palette)}">${coverHTML(title)}</div><div class="detail-copy"><p class="meta-line">${escape([title.year, categories[title.category], duration(title.duration)].filter(Boolean).join(" · "))}</p><h3>${escape(title.title)}</h3><p>${escape(title.description || "One of your stories. Ready when you are.")}</p><button class="button button-primary" data-action="play" data-id="${escape(id)}">${icon("play", 16)}${title.position > 3 && !title.completed ? "Continue watching" : "Play movie"}</button></div></div>${!title.available ? '<div class="danger-box">This video file is unavailable. Check that your library folder is still in place.</div>' : ""}<div class="detail-options"><button class="button button-outline" data-action="watchlist" data-id="${escape(id)}">${icon(title.watchlist ? "check" : "plus", 15)}${title.watchlist ? "In My List" : "My List"}</button><button class="button button-outline" data-action="edit" data-id="${escape(id)}">${icon("edit", 15)}Edit details</button><button class="button button-outline" data-action="catalog-match" data-id="${escape(id)}">${icon("search", 15)}Match from catalog</button><button class="button button-outline" data-action="choose-poster" data-id="${escape(id)}">${icon("image", 15)}Change cover</button>${title.position > 0 || title.completed ? `<button class="button button-outline" data-action="reset-progress" data-id="${escape(id)}">${icon("back", 15)}Start over</button>` : ""}</div><div id="detail-conversion" data-id="${escape(id)}">${conversionDetailsHTML(title)}</div><div class="detail-file"><span>Original file</span><br>${escape(title.originalName)} · ${bytes(title.fileSize)}<br><br><button class="text-button danger-link" data-action="confirm-delete" data-id="${escape(id)}">${icon("trash", 13)}Remove from library</button></div>`,
  });
}
function showEdit(id, draft = null) {
  const savedTitle = findTitle(id);
  if (!savedTitle) return;
  const title = draft ? { ...savedTitle, ...draft } : savedTitle;
  state.editPalette = title.palette || "amber";
  openDialog({
    title: "Make it yours.",
    eyebrow: "EDIT DETAILS",
    body: `<form id="edit-form"><label class="field">Title<input name="title" required maxlength="200" value="${escape(title.title)}"></label><div class="edit-catalog-prompt"><span>Find the name, year, and artwork in your offline catalog.</span><button type="button" class="text-button" data-action="catalog-from-edit" data-id="${escape(id)}">Match from catalog</button></div><div class="field-row"><label class="field">Collection<select name="category">${Object.entries(
      categories,
    )
      .map(
        ([value, label]) =>
          `<option value="${value}" ${title.category === value ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="field">Release year<input name="year" type="number" min="1888" max="${new Date().getFullYear() + 10}" placeholder="Optional" value="${title.year ?? ""}"></label></div><label class="field">Description<textarea name="description" maxlength="10000" placeholder="A little about this story…">${escape(title.description)}</textarea></label><label class="field">Cover color<span class="field-hint">Used when no cover image is set.</span></label><div class="cover-choices">${Object.keys(
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
function renderCatalogManager() {
  const manager = $("#catalog-manager");
  if (!manager) return;
  const status = state.catalogStatus;
  manager.querySelector("#catalog-title-count").textContent = status ? Number(status.totalTitles || 0).toLocaleString() : "…";
  manager.querySelector("#catalog-poster-count").textContent = status ? Number(status.posterCount || 0).toLocaleString() : "…";
  manager.querySelector("#catalog-missing-count").textContent = status ? Number(status.missingPosters || 0).toLocaleString() : "…";
  manager.querySelectorAll("[data-catalog-import]").forEach((button) => { button.disabled = state.catalogBusy; });
  const message = manager.querySelector("#catalog-import-message");
  message.textContent = state.catalogMessage;
  message.hidden = !state.catalogMessage;
  message.classList.toggle("catalog-message-error", state.catalogFailure);
  const progress = manager.querySelector("#catalog-import-progress");
  progress.hidden = !state.catalogBusy;
  progress.value = state.catalogProgress;
  progress.setAttribute("aria-label", state.catalogMessage || "Catalog import progress");
}
async function loadCatalogStatus() {
  const generation = ++state.catalogStatusGeneration;
  try {
    const status = await api.catalog();
    if (generation !== state.catalogStatusGeneration) return;
    state.catalogStatus = status;
    renderCatalogManager();
  } catch (error) {
    if (generation !== state.catalogStatusGeneration) return;
    throw error;
  }
}
function showCatalog() {
  openDialog({
    title: "Put a name to the picture.",
    eyebrow: "OFFLINE MOVIE CATALOG",
    className: "catalog-dialog",
    body: `<div id="catalog-manager"><p class="dialog-description">Import your CSV and matching local poster images. Names-only CSVs work too. Everything stays on this PC.</p><div class="catalog-stats"><div><strong id="catalog-title-count">…</strong><span>Movie names</span></div><div><strong id="catalog-poster-count">…</strong><span>Local posters</span></div><div><strong id="catalog-missing-count">…</strong><span>Referenced posters missing</span></div></div><section class="catalog-import-step"><span class="catalog-step-number">01</span><div><h3>Add your movie CSV</h3><p>Use a <code>title</code> column. Add <code>id</code>, <code>year</code>, <code>description</code>, <code>genre</code>, and <code>poster_filename</code> if you have them. Up to 50,000 rows and 20 MB per file.</p><div class="settings-actions"><button class="button button-primary" data-action="catalog-choose-csv" data-catalog-import>${icon("upload", 15)}Import CSV</button><a class="button button-outline" href="/assets/catalog-template.csv" download="catalog-template.csv">${icon("download", 15)}CSV template</a></div></div></section><section class="catalog-import-step"><span class="catalog-step-number">02</span><div><h3>Add matching poster images</h3><p>Choose JPG, PNG, or WebP files, up to 10 MB each. Match each image’s filename to <code>poster_filename</code> in the CSV, such as <code>movie-1999.jpg</code>. Letter case does not matter.</p><button class="button button-outline" data-action="catalog-choose-posters" data-catalog-import>${icon("image", 15)}Choose poster images</button></div></section><p class="catalog-import-message" id="catalog-import-message" role="status" hidden></p><progress class="catalog-progress" id="catalog-import-progress" max="100" value="0" hidden></progress><p class="settings-footnote">Importing updates the catalog. Your uploaded movies change only after you open a movie, choose Match from catalog, and apply a match. URLs in a CSV are not downloaded. Names such as A1 T00 cannot identify a movie on their own; type the real movie name to find it.</p></div>`,
    footer: '<button class="button button-outline" data-action="settings">Back to settings</button>',
  });
  renderCatalogManager();
  void loadCatalogStatus().catch((error) => {
    if (!$("#catalog-manager")) return;
    state.catalogMessage = error.message;
    state.catalogFailure = true;
    renderCatalogManager();
  });
}
async function importCatalogCSV(file) {
  if (!file || state.catalogBusy) return;
  if (file.size > 20 * 1024 * 1024) {
    toast("Choose a CSV smaller than 20 MB.");
    return;
  }
  state.catalogBusy = true;
  state.catalogFailure = false;
  state.catalogProgress = 10;
  state.catalogMessage = `Importing ${file.name}… Keep the app open.`;
  renderCatalogManager();
  try {
    const result = await api.importCatalog(file);
    state.catalogMessage = `${Number(result.imported || 0).toLocaleString()} catalog rows imported: ${Number(result.inserted || 0).toLocaleString()} added, ${Number(result.updated || 0).toLocaleString()} updated. Your uploaded movies are unchanged.`;
    state.catalogProgress = 100;
    toast("Offline movie catalog imported.");
  } catch (error) {
    state.catalogFailure = true;
    state.catalogMessage = error.message;
    toast(error.message);
  } finally {
    state.catalogBusy = false;
    renderCatalogManager();
    await loadCatalogStatus().catch(() => {});
  }
}
async function importCatalogPosters(files) {
  if (!files.length || state.catalogBusy) return;
  state.catalogBusy = true;
  state.catalogFailure = false;
  state.catalogProgress = 0;
  let imported = 0, skipped = 0;
  const failures = [];
  const seen = new Set();
  for (const [index, file] of files.entries()) {
    state.catalogMessage = `Adding poster ${index + 1} of ${files.length}: ${file.name}. Keep the app open.`;
    renderCatalogManager();
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Image exceeds 10 MB.");
      const name = file.name.toLowerCase();
      if (seen.has(name)) throw new Error("Duplicate filename in this selection.");
      seen.add(name);
      await api.catalogPoster(file);
      imported++;
    } catch (error) {
      skipped++;
      if (failures.length < 3) failures.push(`${file.name}: ${error.message}`);
    }
    state.catalogProgress = Math.round(((index + 1) / files.length) * 100);
    renderCatalogManager();
  }
  state.catalogBusy = false;
  state.catalogFailure = skipped > 0;
  state.catalogMessage = `${imported} ${imported === 1 ? "poster" : "posters"} added · ${skipped} skipped.${failures.length ? ` ${failures.join(" ")}` : ""}`;
  renderCatalogManager();
  await loadCatalogStatus().catch(() => {});
  toast(`${imported} catalog ${imported === 1 ? "poster" : "posters"} added${skipped ? `; ${skipped} skipped` : ""}.`);
}
function catalogPosterURL(item) {
  return item.poster ? `/api/catalog/items/${encodeURIComponent(item.id)}/poster` : null;
}
function showCatalogMatch(id, { draft = null, query, year } = {}) {
  const title = findTitle(id);
  if (!title) return;
  const initialQuery = query ?? title.title;
  const initialYear = year ?? title.year ?? "";
  openDialog({
    title: "Find your movie.",
    eyebrow: "MATCH FROM OFFLINE CATALOG",
    className: "catalog-dialog",
    body: `<div id="catalog-match"><p class="dialog-description">Search by the real movie name, then check the release year before choosing a match. Filenames such as A1 T00 do not identify the movie.</p><form id="catalog-search-form"><div class="catalog-search-fields"><label class="field">Movie name<input id="catalog-query" type="search" maxlength="200" required value="${escape(initialQuery)}" placeholder="Type the movie name" autocomplete="off"></label><label class="field">Year<input id="catalog-year" type="number" min="1888" max="${new Date().getFullYear() + 10}" value="${escape(initialYear)}" placeholder="Any"></label><button type="submit" class="button button-outline">${icon("search", 15)}Search</button></div></form><p class="catalog-results-status" id="catalog-results-status" role="status"></p><div id="catalog-results" class="catalog-results"></div><div id="catalog-match-preview" class="catalog-match-preview" hidden></div><p class="form-message" id="catalog-match-error" role="status" hidden></p><div class="catalog-match-footer"><button type="button" class="text-button" data-action="catalog">${icon("folder", 14)}Manage catalog</button><button type="button" class="button button-outline" id="catalog-match-back">Back</button></div></div>`,
  });
  const match = $("#catalog-match");
  const queryInput = match.querySelector("#catalog-query");
  const yearInput = match.querySelector("#catalog-year");
  const results = match.querySelector("#catalog-results");
  const status = match.querySelector("#catalog-results-status");
  const preview = match.querySelector("#catalog-match-preview");
  const message = match.querySelector("#catalog-match-error");
  let searchSequence = 0, searchTimer, items = [], selected = null, applying = false;
  const isCurrent = () => match.isConnected && modal.open;
  function renderSelection() {
    results.querySelectorAll("[data-catalog-index]").forEach((button) => {
      const active = items[Number(button.dataset.catalogIndex)] === selected;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    preview.hidden = !selected;
    if (!selected) { preview.innerHTML = ""; return; }
    const poster = catalogPosterURL(selected);
    preview.innerHTML = `<div class="catalog-preview-heading"><span class="eyebrow">YOUR SELECTED MATCH</span><span class="tag">${escape(selected.year || "Year unknown")}</span></div><div class="catalog-preview-content">${poster ? `<img src="${poster}" alt="Poster for ${escape(selected.title)}">` : `<div class="catalog-preview-placeholder">${icon("film", 28)}</div>`}<div><h3>${escape(selected.title)}</h3>${selected.genre ? `<p class="catalog-genre">${escape(selected.genre)}</p>` : ""}<p>${escape(selected.description || "No description in this catalog entry.")}</p></div></div><p class="catalog-apply-note">Apply this movie’s name and available details. ${poster ? "Its local poster will replace your current cover." : "Your current cover stays because this entry has no local poster."} Your video file and watch progress stay the same.</p><button type="button" class="button button-primary" id="apply-catalog-match">${icon("check", 15)}Apply this match</button>`;
  }
  async function search() {
    clearTimeout(searchTimer);
    if (!isCurrent() || applying) return;
    const sequence = ++searchSequence;
    const value = queryInput.value.trim();
    const releaseYear = yearInput.value ? Number(yearInput.value) : undefined;
    selected = null;
    renderSelection();
    message.hidden = true;
    if (!value) {
      results.innerHTML = "";
      status.textContent = "Enter a movie name to search your catalog.";
      return;
    }
    if (releaseYear && (!Number.isInteger(releaseYear) || releaseYear < 1888 || releaseYear > new Date().getFullYear() + 10)) {
      results.innerHTML = "";
      status.textContent = "Enter a valid release year or leave it blank.";
      return;
    }
    status.textContent = "Searching your offline catalog…";
    results.innerHTML = "";
    try {
      const found = await api.searchCatalog(value, releaseYear);
      if (!isCurrent() || sequence !== searchSequence) return;
      items = Array.isArray(found) ? found : [];
      status.textContent = items.length ? `${items.length} ${items.length === 1 ? "match" : "matches"}${items.length >= 30 ? " shown — refine the name or year for more specific results" : ". Choose a movie to preview it."}` : "No matches. Try another spelling or year, or import a CSV through Manage catalog.";
      results.innerHTML = items.map((item, index) => {
        const poster = catalogPosterURL(item);
        return `<button type="button" class="catalog-result" data-catalog-index="${index}" aria-pressed="false">${poster ? `<img src="${poster}" alt="" loading="lazy">` : `<span class="catalog-result-placeholder">${icon("film", 20)}</span>`}<span class="catalog-result-copy"><strong>${escape(item.title)}</strong><span>${escape([item.year || "Year unknown", item.genre].filter(Boolean).join(" · "))}</span><small>${poster ? "Local poster ready" : "No local poster"}</small></span>${icon("arrow", 16)}</button>`;
      }).join("");
    } catch (error) {
      if (!isCurrent() || sequence !== searchSequence) return;
      status.textContent = error.message;
    }
  }
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchSequence++;
    selected = null;
    items = [];
    results.innerHTML = "";
    renderSelection();
    status.textContent = "Searching your offline catalog…";
    searchTimer = setTimeout(search, 300);
  }
  match.querySelector("#catalog-search-form").addEventListener("submit", (event) => { event.preventDefault(); void search(); });
  queryInput.addEventListener("input", scheduleSearch);
  yearInput.addEventListener("input", scheduleSearch);
  results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-catalog-index]");
    if (!button || applying) return;
    selected = items[Number(button.dataset.catalogIndex)];
    renderSelection();
  });
  preview.addEventListener("click", async (event) => {
    if (!event.target.closest("#apply-catalog-match") || !selected || applying) return;
    applying = true;
    queryInput.disabled = true;
    yearInput.disabled = true;
    preview.querySelector("#apply-catalog-match").disabled = true;
    message.hidden = true;
    try {
      const saved = await api.applyCatalog(id, selected.id);
      mergeTitle(saved);
      renderLibrary();
      if (isCurrent()) showDetail(id);
      toast("Movie details matched from your offline catalog.");
    } catch (error) {
      if (isCurrent()) {
        message.textContent = error.message;
        message.hidden = false;
        preview.querySelector("#apply-catalog-match").disabled = false;
      } else toast(error.message);
    } finally {
      applying = false;
      if (isCurrent()) { queryInput.disabled = false; yearInput.disabled = false; }
    }
  });
  match.querySelector("#catalog-match-back").addEventListener("click", () => draft ? showEdit(id, draft) : showDetail(id));
  void search();
  queryInput.focus();
  queryInput.select();
}
function showSettings() {
  const settings = state.settings;
  openDialog({
    title: "A home for your stories.",
    eyebrow: "LIBRARY SETTINGS",
    body: `<p class="dialog-description">Your collection lives on this PC. Keep the app running while you browse and watch.</p><div class="setting-row">${icon("server", 22)}<div><h3>Library connection</h3><p>${state.online ? "Connected to this PC" : "Local backend unavailable"}</p></div><span class="tag ${state.online ? "tag-green" : ""}">${state.online ? "LOCAL" : "OFFLINE"}</span></div><div class="setting-row">${icon("folder", 22)}<div><h3>Video storage</h3><p>${escape(settings?.mediaPath || settings?.libraryPath || "Start the app to see your library path.")}</p></div></div><div class="setting-row">${icon("film", 22)}<div><h3>Your collection</h3><p>${state.titles.length} ${state.titles.length === 1 ? "title" : "titles"} · ${bytes(settings?.usageBytes || 0)} in your library${settings?.freeBytes != null ? ` · ${bytes(settings.freeBytes)} disk space available` : ""}</p></div></div><div class="setting-row">${icon("image", 22)}<div><h3>Offline movie catalog</h3><p>Match names, years, and local poster images from your CSV.</p></div><button class="text-button" data-action="catalog">Manage</button></div><div class="settings-actions"><button class="button button-outline" data-action="catalog">${icon("search", 15)}Offline catalog</button><a class="button button-outline" href="/api/export" download="movies-r-sap-library.json">${icon("download", 15)}Export library metadata</a><button class="button button-outline" data-action="roadmap">${icon("disc", 15)}DVDs & what’s next</button></div><p class="settings-footnote">Metadata export includes titles and file mappings, not video files or cover images. For a complete backup, stop the app and copy the entire data folder, including the database, media, and posters. Home-network access is a future feature.</p>`,
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
      `${icon("alert", 26)}<h3>This video couldn’t play.</h3><p>This player may not support the video or audio formats inside this file. Create an MP4 copy with H.264 video and AAC audio, or check that the original file is readable.</p><div class="player-error-actions"><button class="button button-primary" data-action="convert-from-player" data-id="${escape(id)}">${icon("film", 15)}Convert to MP4</button><button class="button button-outline" id="player-error-close">Back to library</button></div>`;
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
function setPlayerFit(mode) {
  if (mode !== "contain" && mode !== "cover") return;
  state.playerFit = mode;
  video.style.objectFit = mode;
  $("#video-wrap").dataset.fit = mode;
  document.querySelectorAll("[data-player-fit]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.playerFit === mode));
  });
  $("#player-view-hint").textContent = mode === "cover"
    ? "Fill crops picture edges · Z to change · F for full screen"
    : "Fit keeps the whole picture · Z to change · F for full screen";
}
async function togglePlayerFullscreen() {
  if (!playerDialog.open) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("#video-wrap").requestFullscreen();
  } catch {
    toast("Full screen couldn't open. Try the video's full-screen control.");
  }
}
function syncPlayerFullscreen() {
  const fullscreen = Boolean(document.fullscreenElement);
  document.querySelectorAll("[data-player-fullscreen]").forEach((button) => {
    button.textContent = fullscreen ? "Exit full screen" : "Full screen";
    button.title = fullscreen ? "Exit full screen (F)" : "Full screen (F)";
  });
}
function handlePlayerShortcut(event) {
  if (!playerDialog.open || event.defaultPrevented || event.repeat ||
      event.ctrlKey || event.altKey || event.metaKey ||
      event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  const key = event.key.toLowerCase();
  if (key === "z") {
    event.preventDefault();
    setPlayerFit(state.playerFit === "cover" ? "contain" : "cover");
  } else if (key === "f") {
    event.preventDefault();
    void togglePlayerFullscreen();
  }
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
    else if (action === "catalog") showCatalog();
    else if (action === "catalog-choose-csv") {
      if (!state.catalogBusy) $("#catalog-picker").click();
    } else if (action === "catalog-choose-posters") {
      if (!state.catalogBusy) $("#catalog-posters-picker").click();
    } else if (action === "catalog-match") showCatalogMatch(id);
    else if (action === "catalog-from-edit") {
      const form = $("#edit-form");
      if (!form) return;
      const data = new FormData(form);
      const draft = {
        title: String(data.get("title")),
        category: data.get("category"),
        year: data.get("year") ? Number(data.get("year")) : null,
        description: String(data.get("description")),
        palette: state.editPalette,
      };
      showCatalogMatch(id, { draft, query: draft.title, year: draft.year || "" });
    }
    else if (action === "conversions") showConversions();
    else if (action === "refresh-conversions") {
      button.disabled = true;
      await refreshConversions();
      if (button.isConnected) button.disabled = false;
    } else if (action === "convert") showConvert(id);
    else if (action === "convert-from-player") {
      closePlayer();
      showConvert(id);
    } else if (action === "start-conversion") {
      button.disabled = true;
      const confirmation = $("#convert-confirmation");
      confirmation.dataset.starting = "true";
      try {
        await startConversion(id);
      } finally {
        if (confirmation.isConnected) confirmation.dataset.starting = "false";
      }
    } else if (action === "cancel-conversion") {
      button.disabled = true;
      const job = await api.cancelConversion(id);
      state.conversionMutation++;
      state.conversionJobs = state.conversionJobs.map((item) => item.id === job.id ? job : item);
      renderConversions();
      void refreshConversions();
    } else if (action === "roadmap") showRoadmap();
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
$("#catalog-picker").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  void importCatalogCSV(file);
});
$("#catalog-posters-picker").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  void importCatalogPosters(files);
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
document.querySelectorAll("[data-player-fit]").forEach((button) => {
  button.addEventListener("click", () => setPlayerFit(button.dataset.playerFit));
});
document.querySelectorAll("[data-player-fullscreen]").forEach((button) => {
  button.addEventListener("click", togglePlayerFullscreen);
});
document.addEventListener("keydown", handlePlayerShortcut);
document.addEventListener("fullscreenchange", syncPlayerFullscreen);
playerDialog.addEventListener("close", () => {
  if (document.fullscreenElement && playerDialog.contains(document.fullscreenElement)) {
    void document.exitFullscreen().catch(() => {});
  }
});
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
void refreshConversions();
