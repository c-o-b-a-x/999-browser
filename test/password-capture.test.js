const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
  }

  closest(selector) {
    return selector.includes("form") ? this.form || null : this;
  }

  matches(selector) {
    if (selector.includes("input[type='submit']")) {
      return this.tagName === "INPUT" && this.type === "submit";
    }
    if (selector.includes("input[type='image']")) {
      return this.tagName === "INPUT" && this.type === "image";
    }
    if (selector.includes("[role='button']")) {
      return this.role === "button";
    }
    return false;
  }

  getAttribute(name) {
    return name === "aria-label" ? this.ariaLabel || "" : null;
  }
}

class FakeButton extends FakeElement {
  constructor(form, type = "submit") {
    super("button");
    this.form = form;
    this.type = type;
  }
}

class FakeForm extends FakeElement {
  constructor(inputs) {
    super("form");
    this.inputs = inputs;
    for (const input of inputs) input.form = this;
  }

  querySelectorAll(selector) {
    return selector === "input" ? this.inputs : [];
  }
}

function loadCapturePreload() {
  const listeners = new Map();
  const sent = [];
  const ipcRenderer = {
    send(channel, value) {
      sent.push({ channel, value });
    }
  };
  const context = vm.createContext({
    Element: FakeElement,
    HTMLButtonElement: FakeButton,
    HTMLFormElement: FakeForm,
    location: { origin: "https://example.com" },
    document: {
      addEventListener(name, callback) {
        listeners.set(name, callback);
      }
    },
    require(name) {
      assert.equal(name, "electron");
      return { ipcRenderer };
    },
    setTimeout
  });
  context.window = context;
  context.top = context;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "guest-preload.js"), "utf8"),
    context
  );
  return { listeners, sent };
}

function credentialForm() {
  return new FakeForm([
    Object.assign(new FakeElement("input"), {
      type: "text",
      name: "username",
      id: "login",
      autocomplete: "username",
      value: "person",
      disabled: false
    }),
    Object.assign(new FakeElement("input"), {
      type: "password",
      name: "password",
      id: "password",
      autocomplete: "current-password",
      value: "secret",
      disabled: false
    })
  ]);
}

test("captures credentials from a trusted form submission without putting values in diagnostics", () => {
  const { listeners, sent } = loadCapturePreload();
  const form = credentialForm();

  listeners.get("submit")({ isTrusted: true, target: form });

  assert.deepEqual(sent.map(({ channel }) => channel), [
    "password:capture-attempt",
    "password:save-candidate"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].value)), {
    origin: "https://example.com",
    hasPassword: true,
    hasUsername: true,
    inputCount: 2
  });
  assert.equal(sent[1].value.username, "person");
  assert.equal(sent[1].value.password, "secret");
  assert.equal(JSON.stringify(sent[0].value).includes("secret"), false);
});

test("ignores synthetic form submissions", () => {
  const { listeners, sent } = loadCapturePreload();

  listeners.get("submit")({ isTrusted: false, target: credentialForm() });

  assert.deepEqual(sent, []);
});

test("captures credentials when a trusted submit button triggers a script-based form flow", async () => {
  const { listeners, sent } = loadCapturePreload();
  const form = credentialForm();
  const button = new FakeButton(form);

  listeners.get("click")({ isTrusted: true, target: button });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.filter(({ channel }) => channel === "password:save-candidate").length, 1);
  assert.equal(sent.find(({ channel }) => channel === "password:save-candidate").value.password, "secret");
});

test("does not send duplicate credentials when a submit button also submits its form", async () => {
  const { listeners, sent } = loadCapturePreload();
  const form = credentialForm();

  listeners.get("click")({
    isTrusted: true,
    target: new FakeButton(form)
  });
  listeners.get("submit")({ isTrusted: true, target: form });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.filter(({ channel }) => channel === "password:save-candidate").length, 1);
});

test("does not treat non-submit buttons as password submission attempts", async () => {
  const { listeners, sent } = loadCapturePreload();
  const form = credentialForm();

  listeners.get("click")({
    isTrusted: true,
    target: new FakeButton(form, "button")
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sent, []);
});
