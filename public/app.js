
/* Login / Create account tab switching */
document.querySelectorAll("[data-auth]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.auth;
    const isRegister = mode === "register";

    document.querySelectorAll("[data-auth]").forEach((tab) => {
      tab.classList.toggle("selected", tab === button);
    });

    const submit = document.getElementById("authSubmit");
    const password = document.getElementById("authPassword");
    const message = document.getElementById("authMessage");

    if (submit) {
      submit.innerHTML = isRegister
        ? "Create account <span>→</span>"
        : "Sign in <span>→</span>";
    }

    if (password) {
      password.autocomplete = isRegister
        ? "new-password"
        : "current-password";
    }

    if (message) {
      message.textContent = "";
      message.classList.remove("error", "success");
    }

    const form = document.getElementById("authForm");
    if (form) {
      form.dataset.mode = mode;
    }
  });
});

async function requestObfuscation(name, description, source, profile) {
    const response = await fetch("/api/obfuscate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
            name,
            description,
            source,
            profile
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Transformation failed.");
    }

    if (typeof data.output !== "string") {
        throw new Error("The server returned no output.");
    }

    return data;
}
