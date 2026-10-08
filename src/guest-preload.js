const { ipcRenderer } = require("electron");
const pendingFormAttempts = new WeakMap();

function captureCredentials(form) {
  if (!(form instanceof HTMLFormElement) || window.top !== window) return;
  const inputs = [...form.querySelectorAll("input")];
  const passwordInput = inputs.find((input) => input.type === "password" && input.value);
  const usernameInputs = inputs.filter((input) => input.type !== "password");
  const usernameInput = usernameInputs.find((input) =>
    /user|email|login|account/i.test(
      `${input.name} ${input.id} ${input.autocomplete} ${input.type}`
    )
  ) || usernameInputs.find((input) => ["text", "email"].includes(input.type));
  ipcRenderer.send("password:capture-attempt", {
    origin: location.origin,
    hasPassword: Boolean(passwordInput),
    hasUsername: Boolean(usernameInput?.value),
    inputCount: inputs.length
  });
  if (!passwordInput) return;
  if (!usernameInput?.value) return;

  ipcRenderer.send("password:save-candidate", {
    origin: location.origin,
    username: usernameInput.value.slice(0, 300),
    password: passwordInput.value.slice(0, 2000)
  });
}

document.addEventListener("submit", (event) => {
  if (!event.isTrusted) return;
  const form = event.target;
  const attempt = pendingFormAttempts.get(form);
  if (attempt) {
    attempt.submitted = true;
    if (attempt.captured) return;
    attempt.captured = true;
  }
  captureCredentials(form);
}, true);

document.addEventListener("click", (event) => {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const control = event.target.closest(
    "button, input[type='submit'], input[type='image'], [role='button']"
  );
  if (!control) return;
  const isNativeSubmit =
    control.matches("input[type='submit'], input[type='image']") ||
    (control instanceof HTMLButtonElement && control.type === "submit");
  const isNamedSubmit =
    (control instanceof HTMLButtonElement || control.matches("[role='button']")) &&
    /\b(sign in|log in|log on|submit|create account|register)\b/i.test(
      `${control.textContent || ""} ${control.getAttribute("aria-label") || ""}`
    );
  if (!isNativeSubmit && !isNamedSubmit) return;
  const form = control.form || control.closest("form");
  if (!(form instanceof HTMLFormElement)) return;

  const attempt = { submitted: false, captured: false };
  pendingFormAttempts.set(form, attempt);
  setTimeout(() => {
    if (!attempt.submitted && !attempt.captured) {
      attempt.captured = true;
      captureCredentials(form);
    }
    if (pendingFormAttempts.get(form) === attempt) {
      pendingFormAttempts.delete(form);
    }
  }, 0);
}, true);
