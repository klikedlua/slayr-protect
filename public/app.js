
const $ = selector => document.querySelector(selector);

let authMode = "login";
let inputMode = "paste";
let latestOutput = "";

async function api(url, options = {}) {
  const isForm = options.body instanceof FormData;

  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function setMessage(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle("success", success);
}

function notify(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");

  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    element.classList.add("hidden");
  }, 2600);
}

function showAuth() {
  $("#authScreen").classList.remove("hidden");
  $("#appScreen").classList.add("hidden");
}

function showApp() {
  $("#authScreen").classList.add("hidden");
  $("#appScreen").classList.remove("hidden");
}

function fmtBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB"];
  let index = 0;
  let value = bytes;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function prettyDate(value) {
  const date = new Date(value + "Z");

  if (isNaN(date)) return "—";

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderDashboard(data) {
  $("#sideUsername").textContent = data.user.username;
  $("#sideAvatar").textContent =
    data.user.username.charAt(0).toUpperCase();

  $("#welcomeUsername").textContent = data.user.username;
  $("#settingsUsername").value = data.user.username;

  $("#statJobs").textContent = data.stats.total;
  $("#statBytes").textContent = fmtBytes(data.stats.sourceBytes);

  const list = $("#recentJobs");
  list.replaceChildren();

  if (!data.recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const symbol = document.createElement("div");
    symbol.textContent = "⌘";

    const title = document.createElement("b");
    title.textContent = "No scripts processed yet";

    const paragraph = document.createElement("p");
    paragraph.textContent =
      "Your completed jobs will show up here.";

    empty.append(symbol, title, paragraph);
    list.append(empty);
    return;
  }

  data.recent.forEach(job => {
    const row = document.createElement("div");
    row.className = "job-row";

    const icon = document.createElement("div");
    icon.className = "job-symbol";
    icon.textContent = "⌘";

    const info = document.createElement("div");
    info.className = "job-info";

    const title = document.createElement("b");
    title.textContent = job.name;

    const description = document.createElement("small");
    description.textContent =
      (job.description || "Luau script") +
      " · " +
      prettyDate(job.created_at);

    const size = document.createElement("div");
    size.className = "job-bytes";
    size.textContent = fmtBytes(job.source_bytes);

    info.append(title, description);
    row.append(icon, info, size);
    list.append(row);
  });
}

async function refreshDashboard() {
  try {
    const data = await api("/api/me");
    renderDashboard(data);
    showApp();
  } catch {
    showAuth();
  }
}

// Login and registration

document.querySelectorAll("[data-auth]").forEach(button => {
  button.addEventListener("click", () => {
    authMode = button.dataset.auth;

    document.querySelectorAll("[data-auth]").forEach(item => {
      item.classList.toggle("selected", item === button);
    });

    $("#authSubmit").innerHTML =
      authMode === "login"
        ? 'Sign in <span>→</span>'
        : 'Create account <span>→</span>';

    $("#authPassword").autocomplete =
      authMode === "login" ? "current-password" : "new-password";

    setMessage($("#authMessage"), "");
  });
});

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();

  const button = $("#authSubmit");
  button.disabled = true;
  setMessage($("#authMessage"), "");

  try {
    const data = await api(`/api/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({
        username: $("#authUsername").value,
        password: $("#authPassword").value
      })
    });

    $("#authPassword").value = "";
    renderDashboard(data.dashboard);
    showApp();
    navigate("dashboard");
  } catch (error) {
    setMessage($("#authMessage"), error.message);
  } finally {
    button.disabled = false;
  }
});

// Page navigation

function navigate(page) {
  document.querySelectorAll(".page").forEach(section => {
    section.classList.add("hidden");
  });

  const target = $(`#page-${page}`);
  if (target) target.classList.remove("hidden");

  document.querySelectorAll(".nav-link").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  $("#crumbPage").textContent = page.toUpperCase();

  $("#topTitle").textContent =
    page === "obfuscation"
      ? "Obfuscation"
      : page.charAt(0).toUpperCase() + page.slice(1);
}

document.querySelectorAll(".nav-link").forEach(button => {
  button.addEventListener("click", () => {
    navigate(button.dataset.page);
  });
});

document.querySelectorAll("[data-goto]").forEach(button => {
  button.addEventListener("click", () => {
    navigate(button.dataset.goto);
  });
});

// Logout

async function logout() {
  try {
    await api("/api/auth/logout", {
      method: "POST",
      body: "{}"
    });
  } catch {
    // Return to sign-in even if the session has already expired.
  }

  showAuth();
  navigate("dashboard");
}

$("#logoutSmall").addEventListener("click", logout);
$("#logoutButton").addEventListener("click", logout);

// Paste and upload modes

document.querySelectorAll("[data-mode]").forEach(button => {
  button.addEventListener("click", () => {
    inputMode = button.dataset.mode;

    document.querySelectorAll("[data-mode]").forEach(item => {
      item.classList.toggle("selected", item === button);
    });

    $("#pastePanel").classList.toggle(
      "hidden",
      inputMode !== "paste"
    );

    $("#uploadPanel").classList.toggle(
      "hidden",
      inputMode !== "upload"
    );
  });
});

$("#sourceCode").addEventListener("input", () => {
  $("#charCount").textContent =
    $("#sourceCode").value.length.toLocaleString() +
    " characters";
});

$("#sourceFile").addEventListener("change", () => {
  const file = $("#sourceFile").files[0];

  $("#fileName").textContent = file
    ? file.name
    : "";
});

// Luau transformation

$("#transformForm").addEventListener("submit", async event => {
  event.preventDefault();

  const button = $("#transformButton");
  button.disabled = true;

  $("#resultPanel").classList.add("hidden");
  setMessage($("#transformMessage"), "Processing script…");

  try {
    let data;

    if (inputMode === "upload") {
      const file = $("#sourceFile").files[0];

      if (!file) {
        throw new Error("Choose a .lua or .luau file first.");
      }

      const form = new FormData();
      form.append("name", $("#scriptName").value);
      form.append("description", $("#scriptDescription").value);
      form.append("file", file);

      data = await api("/api/obfuscate-file", {
        method: "POST",
        body: form
      });
    } else {
      data = await api("/api/obfuscate", {
        method: "POST",
        body: JSON.stringify({
          name: $("#scriptName").value,
          description: $("#scriptDescription").value,
          code: $("#sourceCode").value
        })
      });
    }

    latestOutput = data.output;
    $("#outputCode").value = latestOutput;

    $("#outputSummary").textContent =
      `${latestOutput.length.toLocaleString()} output characters · ` +
      fmtBytes(new Blob([latestOutput]).size);

    $("#resultPanel").classList.remove("hidden");
    setMessage($("#transformMessage"), data.notice, true);

    await refreshDashboard();
    navigate("obfuscation");
  } catch (error) {
    setMessage($("#transformMessage"), error.message);
  } finally {
    button.disabled = false;
  }
});

// Copy and download output

$("#copyResult").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latestOutput);
    notify("Output copied to clipboard.");
  } catch {
    $("#outputCode").focus();
    $("#outputCode").select();

    try {
      const copied = document.execCommand("copy");
      notify(
        copied
          ? "Output copied to clipboard."
          : "Select the output and copy it manually."
      );
    } catch {
      notify("Select the output and copy it manually.");
    }
  }
});

$("#downloadResult").addEventListener("click", () => {
  const blob = new Blob([latestOutput], {
    type: "text/plain;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  const name = ($("#scriptName").value || "slayr-output")
    .replace(/[^a-z0-9_-]/gi, "_");

  link.href = url;
  link.download = `${name}.luau`;

  document.body.append(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
});

// Change password

$("#passwordForm").addEventListener("submit", async event => {
  event.preventDefault();

  const message = $("#passwordMessage");
  const button = event.submitter;

  if (button) button.disabled = true;
  setMessage(message, "");

  try {
    await api("/api/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: $("#currentPassword").value,
        newPassword: $("#newPassword").value
      })
    });

    setMessage(message, "Password updated.", true);
    $("#passwordForm").reset();
  } catch (error) {
    setMessage(message, error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

// Start the application

refreshDashboard();
