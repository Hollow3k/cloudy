// Cloudy - side panel logic (milestone 0.1.0: chat only).

// ---- Settings you can change ----------------------------------------------
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "qwen3:4b-instruct";
// A cold model load took ~70 s for us, so allow 3 minutes by default.
const TIMEOUT_MS = 180000;
// ----------------------------------------------------------------------------

// Element references
const form = document.getElementById("prompt-form");
const input = document.getElementById("prompt-input");
const sendButton = document.getElementById("send-button");
const stopButton = document.getElementById("stop-button");
const statusEl = document.getElementById("status");
const replyEl = document.getElementById("reply");

// State for the request currently in flight (if any).
let latestRequestId = 0; // increases with every request
let activeController = null; // AbortController of the in-flight request
let abortCause = null; // "user" or "timeout": why we aborted
let inFlight = false;

function setStatus(message, isError = false) {
  statusEl.textContent = message; // textContent: never parsed as HTML
  statusEl.classList.toggle("error", isError);
}

function setBusy(busy) {
  inFlight = busy;
  sendButton.disabled = busy;
  stopButton.disabled = !busy;
  input.readOnly = busy; // still focusable, but can't be edited mid-request
}

async function submitPrompt() {
  const prompt = input.value.trim();
  if (prompt === "") return; // empty input does nothing
  if (inFlight) return; // blocks button clicks AND Enter

  const requestId = ++latestRequestId;
  const controller = new AbortController();
  activeController = controller;
  abortCause = null;

  setBusy(true);
  replyEl.textContent = "";
  setStatus("Working... (the first request can take a minute while the model loads)");

  const timeoutId = setTimeout(() => {
    abortCause = "timeout";
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt: prompt,
        stream: false,
        think: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch (_) {
        /* ignore: the status code is the important part */
      }
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.kind = "http";
      error.status = response.status;
      error.detail = detail;
      throw error;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      if (controller.signal.aborted) throw parseError; // abort during body read
      const error = new Error("Ollama replied, but the body was not valid JSON.");
      error.kind = "malformed";
      throw error;
    }

    if (data === null || typeof data !== "object" || typeof data.response !== "string") {
      const error = new Error('The JSON had no string "response" field.');
      error.kind = "malformed";
      throw error;
    }

    // A newer request exists: this one is stale, so don't touch the UI.
    if (requestId !== latestRequestId) return;

    replyEl.textContent = data.response;
    setStatus(data.response === "" ? "Done, but the model returned an empty reply." : "Done.");
  } catch (error) {
    if (requestId !== latestRequestId) return; // stale: ignore

    if (abortCause === "timeout") {
      setStatus(
        `Timed out after ${TIMEOUT_MS / 1000} s. Raise TIMEOUT_MS in sidepanel.js if the model is just slow to load.`,
        true
      );
    } else if (abortCause === "user") {
      setStatus(
        "Cancelled. This only cancels the browser's request; Ollama may still be computing for a moment.",
        true
      );
    } else if (error.kind === "http") {
      let hint = "";
      if (error.status === 403) {
        hint = " Ollama rejected this extension's origin. Check OLLAMA_ORIGINS (see README).";
      } else if (error.status === 404) {
        hint = ` Is the model "${MODEL}" downloaded?`;
      }
      setStatus(`${error.message}.${hint} ${error.detail}`.trim(), true);
    } else if (error.kind === "malformed") {
      setStatus(`Unexpected response: ${error.message}`, true);
    } else {
      // fetch() throws TypeError when it can't reach the server at all.
      setStatus(
        "Network error: could not reach Ollama at localhost:11434. Is Ollama running? " +
          `(${error.message})`,
        true
      );
    }
  } finally {
    clearTimeout(timeoutId);
    // Only the newest request may restore the controls.
    if (requestId === latestRequestId) {
      activeController = null;
      setBusy(false);
    }
  }
}

function stopRequest() {
  if (activeController && !abortCause) {
    abortCause = "user";
    activeController.abort();
  }
}

// Event listeners (no inline handlers in the HTML)
form.addEventListener("submit", (event) => {
  event.preventDefault(); // don't reload the page
  submitPrompt();
});

input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter inserts a newline; ignore IME composition.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitPrompt();
  }
});

stopButton.addEventListener("click", stopRequest);
