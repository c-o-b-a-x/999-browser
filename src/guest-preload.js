const { ipcRenderer } = require("electron");

function captureCredentials(form) {
  if (!(form instanceof HTMLFormElement) || window.top !== window) return;
  const passwordInput = form.querySelector('input[type="password"]');
  if (!passwordInput?.value) return;
  const inputs = [...form.querySelectorAll("input:not([type='password'])")];
  const usernameInput = inputs.find((input) =>
    /user|email|login|account/i.test(
      `${input.name} ${input.id} ${input.autocomplete} ${input.type}`
    )
  ) || inputs.find((input) => ["text", "email"].includes(input.type));
  if (!usernameInput?.value) return;

  ipcRenderer.send("password:save-candidate", {
    origin: location.origin,
    username: usernameInput.value.slice(0, 300),
    password: passwordInput.value.slice(0, 2000)
  });
}

document.addEventListener("submit", (event) => {
  captureCredentials(event.target);
}, true);
