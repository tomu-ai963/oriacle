// ============================================
// Oriacle — mystic-login.js (Magic-link auth)
// Frontend = github.io / API = workers.dev (cross-site),
// so instead of an HttpOnly cookie we keep the sessionId in
// localStorage and send it via Authorization: Bearer.
// ============================================

const WORKER_URL = "https://mystic-system-worker.inverted-triangle-leef.workers.dev";

const MysticAuth = {
  SESSION_KEY: "mystic_session",
  SUBSCRIPTION_KEY: "mystic_subscription",
  EMAIL_KEY: "mystic_email",

  getSession() {
    return localStorage.getItem(this.SESSION_KEY);
  },

  isLoggedIn() {
    return !!this.getSession();
  },

  isSubscribed() {
    return localStorage.getItem(this.SUBSCRIPTION_KEY) === "active";
  },

  authHeaders(extra = {}) {
    const sid = this.getSession();
    return sid ? { ...extra, "Authorization": `Bearer ${sid}` } : { ...extra };
  },

  // Landing from /auth/verify: capture #mystic_sid=...
  captureSessionFromUrl() {
    const m = location.hash.match(/[#&]mystic_sid=([^&]+)/);
    if (!m) return false;
    const sid = decodeURIComponent(m[1]);
    localStorage.setItem(this.SESSION_KEY, sid);
    history.replaceState({}, "", location.pathname + location.search);
    return true;
  },

  // Request a magic link (not logged in yet at this point)
  async requestMagicLink(email) {
    if (!email || !email.includes("@")) {
      throw new Error("Please enter a valid email address");
    }
    const res = await fetch(`${WORKER_URL}/auth/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        redirect: location.href.split("#")[0],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to send the email");
    return true;
  },

  // Verify the session on the server and cache subscription state
  async refreshMe() {
    const sid = this.getSession();
    if (!sid) return { loggedIn: false, subscribed: false };
    let res;
    try {
      res = await fetch(`${WORKER_URL}/auth/me`, { headers: this.authHeaders() });
    } catch {
      return { loggedIn: true, subscribed: this.isSubscribed() };
    }
    if (res.status === 401) {
      this.logout();
      return { loggedIn: false, subscribed: false };
    }
    const data = await res.json().catch(() => ({}));
    const subscribed = data.subscribed === true;
    localStorage.setItem(this.SUBSCRIPTION_KEY, subscribed ? "active" : "inactive");
    if (data.email) localStorage.setItem(this.EMAIL_KEY, data.email);
    return { loggedIn: true, subscribed, email: data.email };
  },

  // Registered email cached by refreshMe (for the My Page view)
  getEmail() {
    return localStorage.getItem(this.EMAIL_KEY) || "";
  },

  async logout() {
    const sid = this.getSession();
    if (sid) {
      try {
        await fetch(`${WORKER_URL}/auth/logout`, { method: "POST", headers: this.authHeaders() });
      } catch { /* ignore */ }
    }
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.SUBSCRIPTION_KEY);
    localStorage.removeItem(this.EMAIL_KEY);
  },

  // Redirect to the Stripe Checkout page
  async startCheckout() {
    if (!this.isLoggedIn()) throw new Error("Login required");
    const res = await fetch(`${WORKER_URL}/stripe/checkout`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        successUrl: `${location.origin}${location.pathname}?checkout=success`,
        cancelUrl:  `${location.origin}${location.pathname}?checkout=cancel`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || "Failed to load the payment page");
    location.href = data.url;
  },

  // Shared helper used by every app to call the AI API
  async callApi(endpoint, body) {
    if (!this.isLoggedIn()) throw new Error("Login required");

    // /mystic/star-reading → action: "star-reading"
    const action = endpoint.replace(/^\/mystic\//, "");

    const res = await fetch(`${WORKER_URL}/api/mystic`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action, ...body }),
    });

    if (res.status === 401) {
      this.logout();
      throw new Error("Your session has expired. Please sign in again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "An API error occurred");
    return data;
  },
};

// ============================================
// Login UI (email input → send magic link)
// ============================================

function renderLoginModal() {
  if (document.getElementById("mystic-login-modal")) return;

  const modal = document.createElement("div");
  modal.id = "mystic-login-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">✦</div>
        <h2 class="mystic-modal-title">Oriacle</h2>
        <p class="mystic-modal-subtitle">Sign in with your email to begin your journey</p>
        <input
          id="mystic-email-input"
          type="email"
          placeholder="your@email.com"
          class="mystic-modal-input"
          autocomplete="email"
        />
        <button id="mystic-login-btn" class="mystic-modal-btn">
          Send a Sign-in Link
        </button>
        <p id="mystic-login-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">
          * We'll email a sign-in link to the address you enter
        </p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-login-btn").addEventListener("click", handleLoginClick);
  document.getElementById("mystic-email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLoginClick();
  });
}

async function handleLoginClick() {
  const email = document.getElementById("mystic-email-input").value.trim();
  const errorEl = document.getElementById("mystic-login-error");
  const btn = document.getElementById("mystic-login-btn");

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Sending...";

  try {
    await MysticAuth.requestMagicLink(email);
    showMagicLinkSent(email);
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Send a Sign-in Link";
  }
}

function showMagicLinkSent(email) {
  const box = document.querySelector("#mystic-login-modal .mystic-modal-box");
  if (!box) return;
  box.innerHTML = `
    <div class="mystic-modal-star">✉</div>
    <h2 class="mystic-modal-title">Check your email</h2>
    <p class="mystic-modal-subtitle">We sent a sign-in link to ${email}.</p>
    <p class="mystic-modal-note">
      Open the button in the email within 15 minutes to sign in.<br/>
      If it doesn't arrive, please check your spam folder.
    </p>
  `;
}

// ============================================
// Subscription UI (Stripe integration)
// ============================================

function renderSubscriptionModal() {
  if (document.getElementById("mystic-sub-modal")) return;

  const modal = document.createElement("div");
  modal.id = "mystic-sub-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">☽</div>
        <h2 class="mystic-modal-title">Subscription</h2>
        <p class="mystic-modal-subtitle">Full access to all 30 apps</p>
        <ul class="mystic-plan-list">
          <li>✦ Star Reading · Tarot · Numerology</li>
          <li>✦ Guardian Star · Soul Compatibility</li>
          <li>✦ Past Life Reading · Dream Interpretation</li>
          <li>✦ Moon Journal · Oracle Message</li>
          <li>✦ Palm Reading (AI Image Analysis)</li>
        </ul>
        <div class="mystic-price-badge">Coming Soon</div>
        <a id="mystic-subscribe-btn" href="#" class="mystic-modal-btn">
          Get Started ✦
        </a>
        <p id="mystic-sub-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">You'll be redirected to our secure payment page</p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-subscribe-btn").addEventListener("click", (e) => {
    e.preventDefault();
    showToast("Subscriptions are launching soon — thanks for your patience!");
  });
}

// ============================================
// Handle the return from Checkout (check URL params)
// ============================================

async function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get("checkout");
  if (!status) return false;

  // Strip the params from the URL
  history.replaceState({}, "", location.pathname);

  if (status === "success") {
    // Wait briefly for the webhook to process before re-checking
    await new Promise((r) => setTimeout(r, 2000));
    const me = await MysticAuth.refreshMe();
    if (me.subscribed) {
      onLoginSuccess();
      return true;
    }
    // Shown when the webhook hasn't arrived yet
    showToast("Confirming your payment. Please reopen this page in a moment.");
    return true;
  }

  if (status === "cancel") {
    showToast("Payment was cancelled.");
    renderSubscriptionModal();
    return true;
  }

  return false;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.style.cssText = `
    position:fixed; bottom:2rem; left:50%; transform:translateX(-50%);
    background:#2d1b4e; color:#e8d5b7; padding:.8rem 1.5rem;
    border-radius:8px; border:1px solid #7c4dff; font-size:.9rem;
    z-index:9999; box-shadow:0 4px 20px rgba(124,77,255,.3);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function onLoginSuccess() {
  if (typeof window.onMysticLogin === "function") {
    window.onMysticLogin();
  } else {
    location.reload();
  }
  // Auto-fill #birthdate in each app from the saved birthdate
  const el = document.getElementById("birthdate");
  if (el) {
    const val = sessionStorage.getItem("mystic_birthdate_temp") || localStorage.getItem("mystic_birthdate");
    if (val) el.value = val;
    // If changed within an app, keep it only for the current session
    el.addEventListener("change", () => {
      sessionStorage.setItem("mystic_birthdate_temp", el.value);
    });
  }
}

// ============================================
// Auth check on page load
// ============================================

document.addEventListener("DOMContentLoaded", async () => {
  // Landing from /auth/verify: capture #mystic_sid
  MysticAuth.captureSessionFromUrl();

  // Check whether we're returning from Checkout (success or cancel)
  if (MysticAuth.isLoggedIn()) {
    const handled = await handleCheckoutReturn();
    if (handled) return;
  }

  if (!MysticAuth.isLoggedIn()) {
    renderLoginModal();
    return;
  }

  // Verify the session on the server and fetch subscription state
  const me = await MysticAuth.refreshMe();
  if (!me.loggedIn) {
    renderLoginModal();
    return;
  }

  // index.html: show the app list without a subscription check once logged in
  if (window.MYSTIC_IS_INDEX) {
    onLoginSuccess();
    return;
  }

  // Each app: verify the subscription before showing it
  if (!me.subscribed) {
    renderSubscriptionModal();
  } else {
    onLoginSuccess();
  }
});
