
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  const authForm = $("authForm");
  const authMessage = $("authMessage");
  const authSubmit = $("authSubmit");
  const authPassword = $("authPassword");

  let authMode = "login";
  let sourceMode = "paste";
  let currentUser = null;
  let currentIsAdmin = false;
  let lastOutput = "";
  let toastTimer = null;

  function showMessage(element, message, isError = false) {
    if (!element) return;
    element.textContent = message || "";
    element.classList.toggle("error", isError);
    element.classList.toggle("success", !isError && !!message);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status}).`);
    }

    return data;
  }

  function setAuthMode(mode) {
    authMode = mode === "register" ? "register" : "login";

    document.querySelectorAll("[data-auth]").forEach((button) => {
      button.classList.toggle(
        "selected",
        button.dataset.auth === authMode
      );
    });

    if (authSubmit) {
      authSubmit.innerHTML = authMode === "register"
        ? 'Create account <span>→</span>'
        : 'Sign in <span>→</span>';
      authSubmit.disabled = false;
    }

    if (authPassword) {
      authPassword.autocomplete = authMode === "register"
        ? "new-password"
        : "current-password";

      authPassword.minLength = authMode === "register" ? 10 : 1;
    }

    if (authForm) authForm.dataset.mode = authMode;
    showMessage(authMessage, "");
  }

  document.querySelectorAll("[data-auth]").forEach((button) => {
    button.addEventListener("click", () => {
      setAuthMode(button.dataset.auth);
    });
  });

  function showApp() {
    $("authScreen")?.classList.add("hidden");
    $("appScreen")?.classList.remove("hidden");
  }

  function showAuth() {
    $("appScreen")?.classList.add("hidden");
    $("authScreen")?.classList.remove("hidden");
  }

  function showToast(message) {
    const toast = $("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.remove("hidden");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function navigate(page) {
    const validPages = ["dashboard", "obfuscation", "settings", "admin"];

    if (!validPages.includes(page)) page = "dashboard";
    if (page === "admin" && !currentIsAdmin) page = "dashboard";

    document.querySelectorAll(".page").forEach((section) => {
      section.classList.toggle("hidden", section.id !== `page-${page}`);
    });

    document.querySelectorAll("[data-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.page === page);
    });

    const titles = {
      dashboard: "Dashboard",
      obfuscation: "Obfuscation",
      settings: "Settings",
      admin: "ADMIN"
    };

    if ($("topTitle")) $("topTitle").textContent = titles[page];
    if ($("crumbPage")) $("crumbPage").textContent = page.toUpperCase();

    if (page === "dashboard") loadDashboard();
    if (page === "settings") loadSettings();
    if (page === "admin") loadAdmin();
  }

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });

  document.querySelectorAll("[data-goto]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.goto));
  });

  function setUser(username, isAdmin = false) {
    currentUser = username || null;
    currentIsAdmin = Boolean(isAdmin);

    $("adminNav")?.classList.toggle("hidden", !currentIsAdmin);
    if ($("sideRole")) {
      $("sideRole").textContent = currentIsAdmin
        ? "Administrator"
        : "Standard account";
    }

    if (!username) return;

    if ($("welcomeUsername")) $("welcomeUsername").textContent = username;
    if ($("sideUsername")) $("sideUsername").textContent = username;
    if ($("sideAvatar")) {
      $("sideAvatar").textContent = username.charAt(0).toUpperCase();
    }
    if ($("settingsUsername")) $("settingsUsername").value = username;
  }

  // Sign in and create account
  if (authForm) {
    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const username = $("authUsername")?.value.trim() || "";
      const password = authPassword?.value || "";

      if (!username || !password) {
        showMessage(authMessage, "Enter your username and password.", true);
        return;
      }

      if (authMode === "register" && password.length < 10) {
        showMessage(
          authMessage,
          "Your password must contain at least 10 characters.",
          true
        );
        return;
      }

      authSubmit.disabled = true;
      showMessage(
        authMessage,
        authMode === "register" ? "Creating your account..." : "Signing in..."
      );

      try {
        const endpoint = authMode === "register"
          ? "/api/register"
          : "/api/login";

        const data = await api(endpoint, {
          method: "POST",
          body: JSON.stringify({ username, password })
        });

        setUser(data.user.username, data.user.isAdmin);
        authPassword.value = "";

        showApp();
        navigate("dashboard");
        showToast(authMode === "register"
          ? "Account created successfully."
          : "Welcome back.");

      } catch (error) {
        showMessage(authMessage, error.message, true);
      } finally {
        authSubmit.disabled = false;
      }
    });
  }

  // Dashboard
  async function loadDashboard() {
    try {
      const data = await api("/api/dashboard");

      setUser(data.user.username, data.user.isAdmin);

      if ($("statJobs")) {
        $("statJobs").textContent = data.stats.scriptsObfuscated;
      }

      if ($("statBytes")) {
        $("statBytes").textContent = formatBytes(data.stats.bytesProcessed);
      }

      const recentJobs = $("recentJobs");
      if (!recentJobs) return;

      if (!data.recentJobs.length) {
        recentJobs.innerHTML = `
          <div class="empty-state">
            <div>⌘</div>
            <b>No scripts processed yet</b>
            <p>Your completed jobs will show up here.</p>
          </div>`;
        return;
      }

      recentJobs.replaceChildren();

      data.recentJobs.forEach((job) => {
        const row = document.createElement("div");
        row.className = "job-row";

        const details = document.createElement("div");
        const name = document.createElement("b");
        name.textContent = job.name;

        const meta = document.createElement("small");
        meta.textContent =
          `${job.description || "Luau script"} · ${new Date(job.createdAt).toLocaleString()}`;

        details.append(name, meta);

        const size = document.createElement("span");
        size.className = "job-size";
        size.textContent = formatBytes(job.outputBytes);

        row.append(details, size);
        recentJobs.append(row);
      });
    } catch (error) {
      if (error.message.includes("log in") ||
          error.message.includes("Account not found")) {
        showAuth();
        showMessage(authMessage, "Your session expired. Please sign in again.", true);
      } else {
        showToast(error.message);
      }
    }
  }

  function formatDate(value) {
    if (!value) return "Not recorded";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not recorded"
      : date.toLocaleString();
  }

  async function loadAdmin() {
    if (!currentIsAdmin) return;

    const body = $("adminUsersBody");
    if (body) {
      body.replaceChildren();
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "admin-empty";
      cell.textContent = "Loading account activity…";
      row.append(cell);
      body.append(row);
    }
    showMessage($("adminMessage"), "");

    try {
      const data = await api("/api/admin/overview");
      const stats = data.stats || {};

      if ($("adminTotalUsers")) {
        $("adminTotalUsers").textContent =
          Number(stats.totalUsers || 0).toLocaleString();
      }
      if ($("adminActiveUsers")) {
        $("adminActiveUsers").textContent =
          Number(stats.activeUsers || 0).toLocaleString();
      }
      if ($("adminTotalObfuscations")) {
        $("adminTotalObfuscations").textContent =
          Number(stats.totalObfuscations || 0).toLocaleString();
      }
      if ($("adminTotalLogins")) {
        $("adminTotalLogins").textContent =
          Number(stats.totalLogins || 0).toLocaleString();
      }

      if (!body) return;
      body.replaceChildren();

      if (!Array.isArray(data.users) || data.users.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "admin-empty";
        cell.textContent = "No accounts to show.";
        row.append(cell);
        body.append(row);
        return;
      }

      for (const user of data.users) {
        const row = document.createElement("tr");
        const account = document.createElement("td");
        account.textContent = user.username || "Unknown";

        if (user.isAdmin) {
          const badge = document.createElement("span");
          badge.className = "admin-badge";
          badge.textContent = "ADMIN";
          account.append(" ", badge);
        }

        const sessionCell = document.createElement("td");
        const status = document.createElement("span");
        status.className = user.currentlySignedIn
          ? "admin-status is-active"
          : "admin-status";
        status.textContent = user.currentlySignedIn
          ? "Signed in"
          : "Signed out";
        sessionCell.append(status);

        const loginCount = document.createElement("td");
        loginCount.textContent =
          Number(user.loginCount || 0).toLocaleString();

        const lastLogin = document.createElement("td");
        lastLogin.textContent = formatDate(user.lastLoginAt);

        const obfuscations = document.createElement("td");
        obfuscations.textContent =
          Number(user.obfuscations || 0).toLocaleString();

        row.append(account, sessionCell, loginCount, lastLogin, obfuscations);
        body.append(row);
      }
    } catch (error) {
      if (body) {
        body.replaceChildren();
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "admin-empty";
        cell.textContent = "Could not load account activity.";
        row.append(cell);
        body.append(row);
      }
      showMessage($("adminMessage"), error.message, true);
    }
  }

  $("refreshAdmin")?.addEventListener("click", loadAdmin);

  function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(
      Math.floor(Math.log(Number(bytes)) / Math.log(1024)),
      units.length - 1
    );

    return `${(Number(bytes) / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  // Paste / upload source selection
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      sourceMode = button.dataset.mode === "upload" ? "upload" : "paste";

      document.querySelectorAll("[data-mode]").forEach((tab) => {
        tab.classList.toggle("selected", tab === button);
      });

      $("pastePanel")?.classList.toggle("hidden", sourceMode !== "paste");
      $("uploadPanel")?.classList.toggle("hidden", sourceMode !== "upload");

      showMessage($("transformMessage"), "");
    });
  });

  $("sourceCode")?.addEventListener("input", () => {
    if ($("charCount")) {
      $("charCount").textContent =
        `${$("sourceCode").value.length.toLocaleString()} characters`;
    }
  });

  $("sourceFile")?.addEventListener("change", () => {
    const file = $("sourceFile").files?.[0];

    if ($("fileName")) {
      $("fileName").textContent = file
        ? `${file.name} (${formatBytes(file.size)})`
        : "";
    }

    showMessage($("transformMessage"), "");
  });

  // Luau transformation
  const transformForm = $("transformForm");
  const profileSelect = $("obfuscationProfile");
  const profileDescription = $("profileDescription");

  function updateProfileDescription() {
    if (!profileDescription) return;
    const descriptions = {
      standard:
        "Standard mode renames local bindings. Output is standalone Luau and remains reversible.",
      strong:
        "Strong mode also encodes strings and numbers, hides supported properties, and scrambles conditions. Output remains reversible.",
      vm:
        "Offline VM emits standalone Luau with encrypted custom bytecode and constants. It supports common locals, functions, tables, calls, branches, and loops; unsupported syntax is rejected. It adds runtime overhead and is still reversible."
    };
    profileDescription.textContent =
      descriptions[profileSelect?.value] || descriptions.standard;
  }

  profileSelect?.addEventListener("change", updateProfileDescription);
  updateProfileDescription();

  if (transformForm) {
    transformForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const name = $("scriptName")?.value.trim() || "";
      const description = $("scriptDescription")?.value.trim() || "";
      let source = "";

      if (sourceMode === "upload") {
        const file = $("sourceFile")?.files?.[0];

        if (!file) {
          showMessage($("transformMessage"), "Choose a Luau file first.", true);
          return;
        }

        if (file.size > 512 * 1024) {
          showMessage($("transformMessage"), "Maximum file size is 512 KB.", true);
          return;
        }

        if (!/\.(lua|luau)$/i.test(file.name)) {
          showMessage($("transformMessage"), "Choose a .lua or .luau file.", true);
          return;
        }

        try {
          source = await file.text();
        } catch {
          showMessage($("transformMessage"), "Could not read the selected file.", true);
          return;
        }
      } else {
        source = $("sourceCode")?.value || "";
      }

      if (!name || !source.trim()) {
        showMessage(
          $("transformMessage"),
          "Enter a script name and source code.",
          true
        );
        return;
      }

      const button = $("transformButton");
      if (button) {
        button.disabled = true;
        button.textContent = "Transforming...";
      }

      showMessage($("transformMessage"), "Processing your Luau script...");
      $("resultPanel")?.classList.add("hidden");

      try {
        const data = await api("/api/obfuscate", {
          method: "POST",
          body: JSON.stringify({
            name,
            description,
            source,
            profile: $("obfuscationProfile")?.value || "standard"
          })
        });

        lastOutput = data.output;
        if ($("outputCode")) $("outputCode").value = data.output;

        if ($("outputSummary")) {
          const summary = [
            `${formatBytes(data.stats.inputBytes)} input`,
            `${formatBytes(data.stats.outputBytes)} output`
          ];
          if (data.profile === "vm") {
            summary.push(
              `${data.stats.vmInstructions} VM instructions`,
              `${data.stats.vmFunctions} functions`,
              `${data.stats.vmConstants} encrypted constants`
            );
          } else {
            summary.push(`${data.stats.renamedBindings} locals renamed`);
            if (data.stats.encodedStrings > 0) {
              summary.push(`${data.stats.encodedStrings} strings encoded`);
            }
            if (data.stats.encodedNumbers > 0) {
              summary.push(`${data.stats.encodedNumbers} numbers encoded`);
            }
            if (data.stats.encodedProperties > 0) {
              summary.push(`${data.stats.encodedProperties} property names encoded`);
            }
            if (data.stats.scrambledConditions > 0) {
              summary.push(`${data.stats.scrambledConditions} conditions scrambled`);
            }
          }
          $("outputSummary").textContent = summary.join(" · ");
        }

        $("resultPanel")?.classList.remove("hidden");

        showMessage(
          $("transformMessage"),
          data.notice || "Transformation complete."
        );

        showToast("Output generated successfully.");
        await loadDashboard();

      } catch (error) {
        showMessage($("transformMessage"), error.message, true);
      } finally {
        if (button) {
          button.disabled = false;
          button.innerHTML = "<span>◇</span> Transform script";
        }
      }
    });
  }

  // Copy output
  $("copyResult")?.addEventListener("click", async () => {
    if (!lastOutput) {
      showToast("There is no output to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(lastOutput);
      showToast("Output copied.");
    } catch {
      $("outputCode")?.focus();
      $("outputCode")?.select();

      try {
        const copied = document.execCommand("copy");
        showToast(copied ? "Output copied." : "Select and copy the output manually.");
      } catch {
        showToast("Select and copy the output manually.");
      }
    }
  });

  // Download output
  $("downloadResult")?.addEventListener("click", () => {
    if (!lastOutput) {
      showToast("There is no output to download.");
      return;
    }

    const filename = ($("scriptName")?.value.trim() || "protected-script")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80);

    const blob = new Blob([lastOutput], {
      type: "text/plain;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${filename}.luau`;
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Settings
  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      setUser(data.username, data.isAdmin);
    } catch (error) {
      showMessage($("passwordMessage"), error.message, true);
    }
  }

  $("passwordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    showMessage(
      $("passwordMessage"),
      "Password changes are not yet supported by the server."
    );
  });

  // Logout
  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      showToast(error.message);
      return;
    }

    setUser("", false);
    lastOutput = "";

    if (authForm) authForm.reset();

    setAuthMode("login");
    showAuth();
    showMessage(authMessage, "You have been signed out.");
  }

  $("logoutButton")?.addEventListener("click", logout);
  $("logoutSmall")?.addEventListener("click", logout);

  // Restore an existing session after page reload.
  async function initialize() {
    try {
      const data = await api("/api/me");
      setUser(data.user.username, data.user.isAdmin);
      showApp();
      navigate("dashboard");
    } catch {
      showAuth();
      setAuthMode("login");
    }
  }

  setAuthMode("login");
  initialize();
});
