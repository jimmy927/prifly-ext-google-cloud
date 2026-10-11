// The panel's page. It asks its extension for data at `api/<path>` beside
// itself; prifly answers from the module's `panel` export (panel-api.ts) as JSON.

const $ = (id) => document.getElementById(id);

const view = {
  state: null,
  projects: null, // null: not read yet
  projectsError: null,
  chosen: new Set(),
  defaultProject: "",
  saved: { projects: [], defaultProject: "" },
  signingIn: false,
  apisToken: 0,
};

const BADGES = {
  ok: ["Allowed", "ok"],
  "no-scope": ["Not allowed yet", "warn"],
  "needs-sign-in": ["Grant ended", "bad"],
  "no-account": ["No account", "warn"],
  "no-api": ["Unavailable", "bad"],
};

async function call(path, body) {
  const init = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  try {
    const response = await fetch(`api/${path}`, init);
    const answer = await response.json();
    if (!response.ok) return { error: answer.error ?? `HTTP ${response.status}` };
    return answer;
  } catch (error) {
    return { error: String(error) };
  }
}

function text(element, value) {
  element.textContent = value;
}

function show(element, shown) {
  element.hidden = !shown;
}

// Account

function renderAccount() {
  const state = view.state;
  const [label, tone] = BADGES[state.standing] ?? ["Unknown", "warn"];
  text($("account-name"), state.account ?? "No Google account connected");
  text($("account-client"), state.client ? `Signed in through ${state.client}` : "");
  const badge = $("account-badge");
  badge.className = `badge ${tone}`;
  text(badge, label);
  show(badge, true);
  text($("account-message"), state.message ?? "");
  const button = $("allow");
  text(button, state.standing === "needs-sign-in" ? "Sign in again" : "Allow Google Cloud");
  button.disabled = view.signingIn || state.standing === "ok" || state.standing === "no-api";
}

async function allow() {
  view.signingIn = true;
  show($("allow-error"), false);
  renderAccount();
  const answer = await call("allow", {});
  view.signingIn = false;
  if (answer.ok === false || answer.error) {
    text($("allow-error"), answer.message ?? answer.error);
    show($("allow-error"), true);
  }
  await refresh();
}

// Projects

function matches(project, filter) {
  const needle = filter.trim().toLowerCase();
  return needle === "" || `${project.id} ${project.name}`.toLowerCase().includes(needle);
}

function changed() {
  const now = [...view.chosen].sort().join("\n");
  const before = [...view.saved.projects].sort().join("\n");
  return now !== before || view.defaultProject !== view.saved.defaultProject;
}

function projectRow(project) {
  const item = document.createElement("li");
  const board = document.createElement("input");
  board.type = "checkbox";
  board.checked = view.chosen.has(project.id);
  board.ariaLabel = `Show ${project.id} on the board`;
  board.addEventListener("change", () => toggleBoard(project.id, board.checked));
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = project.name;
  const id = document.createElement("small");
  id.textContent =
    project.state && project.state !== "ACTIVE" ? `${project.id} (${project.state})` : project.id;
  name.append(id);
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "default";
  radio.checked = view.defaultProject === project.id;
  radio.disabled = !view.chosen.has(project.id);
  radio.ariaLabel = `Make ${project.id} the default`;
  radio.addEventListener("change", () => setDefault(project.id));
  const label = document.createElement("label");
  label.className = "default";
  label.append(radio, "default");
  const boardLabel = document.createElement("label");
  boardLabel.append(board, "show on board");
  item.append(name, boardLabel, label);
  return item;
}

function toggleBoard(id, on) {
  if (on) view.chosen.add(id);
  else view.chosen.delete(id);
  if (!on && view.defaultProject === id) view.defaultProject = "";
  if (on && view.defaultProject === "") view.defaultProject = id;
  show($("saved"), false);
  renderProjects();
  void renderApis();
}

function setDefault(id) {
  view.defaultProject = id;
  show($("saved"), false);
  renderProjects();
}

function projectsMessage() {
  if (view.projectsError) return view.projectsError;
  if (view.projects === null) return "Reading your projects...";
  if (view.projects.length === 0) return "This account can see no projects.";
  return "";
}

function renderProjects() {
  const message = projectsMessage();
  const failed = Boolean(view.projectsError);
  const status = $("projects-status");
  text(status, message);
  status.className = failed ? "error line" : "muted line";
  const list = view.projects ?? [];
  const shown = list.filter((project) => matches(project, $("filter").value));
  $("project-list").replaceChildren(...shown.map(projectRow));
  show($("project-list"), shown.length > 0);
  $("filter").disabled = list.length === 0;
  $("save").disabled = !changed();
}

async function loadProjects(fresh) {
  const answer = await call(fresh ? "projects?fresh=1" : "projects");
  view.projectsError = answer.error ?? null;
  view.projects = answer.projects ?? [];
  renderProjects();
}

async function save() {
  $("save").disabled = true;
  show($("save-error"), false);
  const answer = await call("select", {
    projects: [...view.chosen],
    defaultProject: view.defaultProject,
  });
  if (answer.error) {
    text($("save-error"), answer.error);
    show($("save-error"), true);
    renderProjects();
    return;
  }
  adopt(answer);
  renderProjects();
  show($("saved"), true);
  void renderApis();
}

function adopt(chosen) {
  view.saved = { projects: [...chosen.projects], defaultProject: chosen.defaultProject };
  view.chosen = new Set(chosen.projects);
  view.defaultProject = chosen.defaultProject;
}

// APIs

function apiLine(answer) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = answer.project;
  item.append(title, " ");
  if (answer.error) {
    item.append(
      Object.assign(document.createElement("span"), {
        className: "error",
        textContent: answer.error,
      }),
    );
    return item;
  }
  if (answer.missing.length === 0) {
    item.append("All five APIs are on");
    return item;
  }
  const missing = document.createElement("ul");
  for (const api of answer.missing) {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = api.enableUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Enable";
    row.append(`${api.title} is not enabled. `, link);
    missing.append(row);
  }
  item.append(missing);
  return item;
}

async function renderApis() {
  view.apisToken += 1;
  const token = view.apisToken;
  const ids = view.saved.projects;
  const status = $("apis-status");
  if (view.state?.standing !== "ok" || ids.length === 0) {
    text(
      status,
      view.state?.standing === "ok" ? "Choose and save projects to check their APIs." : "",
    );
    $("apis").replaceChildren();
    return;
  }
  text(status, "Checking the APIs...");
  const answers = await Promise.all(
    ids.map((id) => call(`apis?project=${encodeURIComponent(id)}`)),
  );
  if (token !== view.apisToken) return;
  text(status, "");
  $("apis").replaceChildren(
    ...answers.map((answer, index) => apiLine({ project: ids[index], ...answer })),
  );
}

// Start

async function refresh() {
  const state = await call("state");
  if (state.error) {
    view.state = {
      standing: "no-api",
      account: null,
      client: null,
      message: state.error,
      chosen: view.saved,
    };
  } else {
    view.state = state;
  }
  adopt(view.state.chosen);
  renderAccount();
  if (view.state.standing === "ok") {
    await loadProjects(true);
  } else {
    view.projects = [];
    view.projectsError = null;
    renderProjects();
    text($("projects-status"), "");
  }
  await renderApis();
}

$("allow").addEventListener("click", () => void allow());
$("save").addEventListener("click", () => void save());
$("filter").addEventListener("input", renderProjects);
renderProjects();
void refresh();
