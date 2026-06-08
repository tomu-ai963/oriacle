// ============================================
// Oriacle — mystic-login.js (Stripe integration)
// ============================================

const WORKER_URL = "https://mystic-system-worker.inverted-triangle-leef.workers.dev";

const MysticAuth = {
  USER_ID_KEY: "mystic_user_id",
  SUBSCRIPTION_KEY: "mystic_subscription",

  getUserId() {
    return localStorage.getItem(this.USER_ID_KEY);
  },

  async login(email) {
    if (!email || !email.includes("@")) {
      throw new Error("Please enter a valid email address");
    }
    const userId = btoa(email.toLowerCase().trim());
    localStorage.setItem(this.USER_ID_KEY, userId);

    const subscribed = await this.checkSubscription(userId);
    localStorage.setItem(this.SUBSCRIPTION_KEY, subscribed ? "active" : "inactive");
    return { userId, subscribed };
  },

  logout() {
    localStorage.removeItem(this.USER_ID_KEY);
    localStorage.removeItem(this.SUBSCRIPTION_KEY);
  },

  async checkSubscription(userId) {
    try {
      const res = await fetch(`${WORKER_URL}/subscription/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      return data.subscribed === true;
    } catch {
      return false;
    }
  },

  isLoggedIn() {
    return !!this.getUserId();
  },

  isSubscribed() {
    return localStorage.getItem(this.SUBSCRIPTION_KEY) === "active";
  },

  // Redirect to the Stripe Checkout page
  async startCheckout() {
    const userId = this.getUserId();
    if (!userId) throw new Error("Login required");

    const res = await fetch(`${WORKER_URL}/stripe/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        successUrl: `${location.origin}/mystic/?checkout=success`,
        cancelUrl:  `${location.origin}/mystic/?checkout=cancel`,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || "Failed to load the payment page");
    location.href = data.url;
  },

  // Shared helper used by every app to call the AI API
  async callApi(endpoint, body) {
    const userId = this.getUserId();
    if (!userId) throw new Error("Login required");

    // /mystic/star-reading → action: "star-reading"
    const action = endpoint.replace(/^\/mystic\//, "");

    const res = await fetch(`${WORKER_URL}/api/mystic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userId,
      },
      body: JSON.stringify({ action, ...body }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "An API error occurred");
    return data;
  },
};

// ============================================
// Login UI
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
        <p class="mystic-modal-subtitle">Enter with your email to begin your journey</p>
        <input
          id="mystic-email-input"
          type="email"
          placeholder="your@email.com"
          class="mystic-modal-input"
          autocomplete="email"
        />
        <button id="mystic-login-btn" class="mystic-modal-btn">
          Open the Door to the Stars
        </button>
        <p id="mystic-login-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">
          * Your email address is used as your user ID
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
  btn.textContent = "Checking...";

  try {
    const { subscribed } = await MysticAuth.login(email);
    document.getElementById("mystic-login-modal").remove();

    if (!subscribed) {
      renderSubscriptionModal();
    } else {
      onLoginSuccess();
    }
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Open the Door to the Stars";
  }
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
  const cleanUrl = location.pathname;
  history.replaceState({}, "", cleanUrl);

  if (status === "success") {
    // Wait briefly for the webhook to process before re-checking
    await new Promise((r) => setTimeout(r, 2000));
    const userId = MysticAuth.getUserId();
    if (userId) {
      const subscribed = await MysticAuth.checkSubscription(userId);
      if (subscribed) {
        localStorage.setItem("mystic_subscription", "active");
        onLoginSuccess();
        return true;
      }
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
  // Check whether we're returning from Checkout (success or cancel)
  if (MysticAuth.isLoggedIn()) {
    const handled = await handleCheckoutReturn();
    if (handled) return;
  }

  if (!MysticAuth.isLoggedIn()) {
    renderLoginModal();
    return;
  }

  // index.html: show the app list without a subscription check once logged in
  if (window.MYSTIC_IS_INDEX) {
    onLoginSuccess();
    return;
  }

  // Each app: verify the subscription before showing it
  const userId = MysticAuth.getUserId();
  const subscribed = await MysticAuth.checkSubscription(userId);
  localStorage.setItem("mystic_subscription", subscribed ? "active" : "inactive");

  if (!subscribed) {
    renderSubscriptionModal();
  } else {
    onLoginSuccess();
  }
});
