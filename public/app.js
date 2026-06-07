// ApexBudget Student Expense Tracker - Main Logic

// 1. Core Config & Data Structures
const CATEGORIES = {
  food: { label: 'Food & Dining', icon: '🍕', color: '#ff7096' },
  academics: { label: 'Textbooks & Academics', icon: '📚', color: '#a2d2ff' },
  rent: { label: 'Rent & Utilities', icon: '🏠', color: '#e9c46a' },
  transport: { label: 'Transport & Commute', icon: '🚌', color: '#f4a261' },
  entertainment: { label: 'Entertainment & Social', icon: '🎬', color: '#9d4edd' },
  income: { label: 'Side Hustle & Income', icon: '💼', color: '#00f5d4' },
  personal: { label: 'Personal & Shopping', icon: '🛍|', color: '#ff85a1' },
  misc: { label: 'Miscellaneous', icon: '📦', color: '#a5a1b8' }
};

// Fix the character inside the personal icon to be pure emoji or standard icons
CATEGORIES.personal.icon = '🛍️';

let currentUser = null;
let categoryChartInstance = null;
let trendChartInstance = null;
let pendingOTPData = null;
let otpTimerInterval = null;

const EXCHANGE_RATES = {
  USD: 1.0,      // US Dollar
  EUR: 0.92,     // Euro
  GBP: 0.78,     // British Pound
  INR: 83.5,     // Indian Rupee
  JPY: 156.0,    // Japanese Yen
  CAD: 1.37      // Canadian Dollar
};

const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:8000' : '';

async function fetchLiveRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates) {
        Object.keys(EXCHANGE_RATES).forEach(key => {
          if (data.rates[key]) EXCHANGE_RATES[key] = data.rates[key];
        });
        console.log('ApexBudget // Live Exchange Rates loaded:', EXCHANGE_RATES);
      }
    }
  } catch (e) {
    console.warn("ApexBudget // Fetching live rates failed. Using offline fallback rates: ", e);
  }
}

const CURRENCIES = {
  USD: { symbol: '$', format: '"$"#,##0.00', dec: 2 },
  EUR: { symbol: '€', format: '"€"#,##0.00', dec: 2 },
  GBP: { symbol: '£', format: '"£"#,##0.00', dec: 2 },
  INR: { symbol: '₹', format: '"₹"#,##0.00', dec: 2 },
  JPY: { symbol: '¥', format: '"¥"#,##0', dec: 0 },
  CAD: { symbol: 'C$', format: '"C$"#,##0.00', dec: 2 }
};

function escapeHTML(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await window.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatCurrency(amount) {
  const currencyCode = (currentUser && currentUser.currency) ? currentUser.currency : 'USD';
  const cur = CURRENCIES[currencyCode];
  return `${cur.symbol}${Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: cur.dec,
    maximumFractionDigits: cur.dec
  })}`;
}

function formatBalance(amount) {
  const currencyCode = (currentUser && currentUser.currency) ? currentUser.currency : 'USD';
  const cur = CURRENCIES[currencyCode];
  const sign = amount < 0 ? '-' : '';
  return `${sign}${cur.symbol}${Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: cur.dec,
    maximumFractionDigits: cur.dec
  })}`;
}

// Initial mock transactions for the Demo Account (removed)

// 2. Authentic// 2. Authentication System (Real REST API Client)
const Auth = {
  getToken() {
    return localStorage.getItem('apexbudget_token');
  },

  async signup(name, email, password, country) {
    try {
      const res = await fetch(API_BASE + '/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, country })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, message: data.message || 'Signup failed.' };
      }
      return { success: true };
    } catch (e) {
      return { success: false, message: 'Could not connect to the authentication server.' };
    }
  },
  
  async login(email, password) {
    try {
      const res = await fetch(API_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, message: data.message || 'Invalid email or password.' };
      }
      
      this.saveSession(data.token, data.user);
      return { success: true };
    } catch (e) {
      return { success: false, message: 'Could not connect to the authentication server.' };
    }
  },
  
  async loginCustomOAuth(email, name, provider = 'google') {
    try {
      const res = await fetch(API_BASE + '/api/auth/oauth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, provider })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, message: data.message || 'OAuth login failed.' };
      }
      
      this.saveSession(data.token, data.user);
      return { success: true };
    } catch (e) {
      return { success: false, message: 'OAuth authentication failed.' };
    }
  },
  
  saveSession(token, user) {
    localStorage.setItem('apexbudget_token', token);
    
    // Convert budget limit from base USD (stored on database) to user local currency
    user.budget = user.budget * EXCHANGE_RATES[user.currency || 'USD'];
    
    localStorage.setItem('apexbudget_current_session', JSON.stringify(user));
    localStorage.removeItem('apexbudget_explicit_logout');
    currentUser = user;
    currentUser.transactions = [];
  },
  
  loadSession() {
    const session = localStorage.getItem('apexbudget_current_session');
    const token = localStorage.getItem('apexbudget_token');
    if (session && token) {
      currentUser = JSON.parse(session);
      currentUser.transactions = [];
      return true;
    }
    return false;
  },
  
  logout() {
    currentUser = null;
    localStorage.removeItem('apexbudget_current_session');
    localStorage.removeItem('apexbudget_token');
    localStorage.setItem('apexbudget_explicit_logout', 'true');
  },
  
  async updateUserData(budget = null, currency = null) {
    if (!currentUser) return;
    const token = this.getToken();
    try {
      const res = await fetch(API_BASE + '/api/profile', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ budget, currency })
      });
      if (res.ok) {
        if (currency !== null) currentUser.currency = currency;
        if (budget !== null) {
          currentUser.budget = budget * EXCHANGE_RATES[currentUser.currency || 'USD'];
        }
        localStorage.setItem('apexbudget_current_session', JSON.stringify(currentUser));
      }
    } catch (e) {
      console.error("ApexBudget // Syncing profile settings failed: ", e);
    }
  }
};

// 3. UI Controller & Nav Manager
const UI = {
  init() {
    this.setupEventListeners();
    this.setupOTPDigitInputs();
    this.checkAuthentication();
    this.updateDateDisplay();
    this.initTheme();
    fetchLiveRates(); // Fetch live rates in background on load
  },
  
  setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const pageId = item.getAttribute('data-page');
        this.switchPage(pageId);
      });
    });
    
    // Auth screens toggle
    document.getElementById('auth-switch-link').addEventListener('click', () => {
      const linkText = document.getElementById('auth-switch-link').innerText;
      if (linkText === 'Sign Up') {
        this.switchAuthPanel('signup');
      } else {
        this.switchAuthPanel('login');
      }
    });

    // Forgot password trigger
    document.getElementById('btn-forgot-password').addEventListener('click', () => {
      this.switchAuthPanel('forgot');
    });
    
    // Login Submit
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      
      // Request login OTP
      try {
        const res = await fetch(API_BASE + '/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, type: 'login' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          pendingOTPData = { email, password, type: 'login' };
          
          if (data.otp_fallback) {
            console.log("ApexBudget // Local OTP Fallback Code:", data.otp_fallback);
            alert(`[Local Testing] Verification code: ${data.otp_fallback}`);
          }
          
          this.openOTPModal('login', email);
        } else {
          this.showAuthError(data.message || 'Login failed.');
        }
      } catch (err) {
        this.showAuthError('Could not connect to the authentication server.');
      }
    });

    // Signup Submit
    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('signup-name').value.trim();
      const email = document.getElementById('signup-email').value.trim();
      const password = document.getElementById('signup-password').value;
      const country = document.getElementById('signup-country').value;
      
      // Request signup OTP
      try {
        const res = await fetch(API_BASE + '/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, type: 'signup' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          pendingOTPData = { name, email, password, country, type: 'signup' };
          
          if (data.otp_fallback) {
            console.log("ApexBudget // Local OTP Fallback Code:", data.otp_fallback);
            alert(`[Local Testing] Verification code: ${data.otp_fallback}`);
          }
          
          this.openOTPModal('signup', email);
        } else {
          this.showAuthError(data.message || 'Signup failed.');
        }
      } catch (err) {
        this.showAuthError('Could not connect to the authentication server.');
      }
    });

    // Forgot Password Submit
    document.getElementById('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-email').value.trim();
      
      // Request reset OTP
      try {
        const res = await fetch(API_BASE + '/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, type: 'reset' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          pendingOTPData = { email, type: 'reset' };
          
          if (data.otp_fallback) {
            console.log("ApexBudget // Local OTP Fallback Code:", data.otp_fallback);
            alert(`[Local Testing] Verification code: ${data.otp_fallback}`);
          }
          
          this.openOTPModal('reset', email);
        } else {
          this.showAuthError(data.message || 'Reset request failed.');
        }
      } catch (err) {
        this.showAuthError('Could not connect to the authentication server.');
      }
    });
    
    // Google Login (Real SSO / OAuth flow popup)
    const btnGoogle = document.getElementById('btn-google-login');
    if (btnGoogle) {
      btnGoogle.addEventListener('click', () => {
        const w = 450;
        const h = 550;
        const left = (screen.width / 2) - (w / 2);
        const top = (screen.height / 2) - (h / 2);
        window.open(API_BASE + '/api/auth/google/login', 'oauth_popup', `width=${w},height=${h},top=${top},left=${left}`);
      });
    }

    // GitHub Login (Real SSO / OAuth flow popup)
    const btnGitHub = document.getElementById('btn-github-login');
    if (btnGitHub) {
      btnGitHub.addEventListener('click', () => {
        const w = 450;
        const h = 580;
        const left = (screen.width / 2) - (w / 2);
        const top = (screen.height / 2) - (h / 2);
        window.open(API_BASE + '/api/auth/github/login', 'oauth_popup', `width=${w},height=${h},top=${top},left=${left}`);
      });
    }

    // Window Message listener to catch successful auth details from popup
    window.addEventListener('message', async (event) => {
      if (event.origin !== window.location.origin) return;
      
      if (event.data && event.data.type === 'oauth-success') {
        const provider = event.data.provider;
        let email = '';
        let name = '';
        
        if (provider === 'google') {
          if (event.data.profile === 'aria') {
            email = 'aria.chen@google.student';
            name = 'Aria Chen';
          } else if (event.data.profile === 'custom') {
            email = event.data.email;
            name = event.data.name;
          }
        } else if (provider === 'github') {
          email = 'devon.lane@github.student';
          name = 'Devon Lane';
        }
        
        const res = await Auth.loginCustomOAuth(email, name, provider);
        if (res.success) {
          this.onUserLoggedIn();
        } else {
          alert("Social authentication failed.");
        }
      }
    });
    
    // OTP Cancel
    document.getElementById('btn-cancel-otp').addEventListener('click', () => {
      this.closeOTPModal();
    });

    // OTP Resend
    document.getElementById('btn-resend-otp').addEventListener('click', async () => {
      if (!pendingOTPData) return;
      
      const { email, password, type } = pendingOTPData;
      try {
        const res = await fetch(API_BASE + '/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, type })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (data.otp_fallback) {
            console.log("ApexBudget // Local OTP Fallback Code (Resend):", data.otp_fallback);
            alert(`[Local Testing] Resent verification code: ${data.otp_fallback}`);
          }
          this.startOTPTimer();
        } else {
          alert(data.message || 'Resending OTP failed.');
        }
      } catch (err) {
        alert('Network error: Could not resend verification code.');
      }
    });

    // OTP Submit Form
    document.getElementById('otp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingOTPData) return;
      
      // Collect code
      const digits = Array.from(document.querySelectorAll('.otp-digit')).map(input => input.value).join('');
      if (digits.length !== 6) {
        alert("Please enter all 6 digits of the code.");
        return;
      }
      
      const payload = {
        email: pendingOTPData.email,
        code: digits,
        type: pendingOTPData.type
      };
      
      if (pendingOTPData.type === 'signup') {
        payload.name = pendingOTPData.name;
        payload.password = pendingOTPData.password;
        payload.country = pendingOTPData.country;
      } else if (pendingOTPData.type === 'reset') {
        const newPassword = document.getElementById('otp-new-password').value;
        if (!newPassword || newPassword.length < 6) {
          alert("Please enter a new password of at least 6 characters.");
          return;
        }
        payload.password = newPassword;
      }
      
      try {
        const res = await fetch(API_BASE + '/api/auth/otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
          const flowType = pendingOTPData.type;
          this.closeOTPModal();
          
          if (flowType === 'reset') {
            this.switchAuthPanel('login');
            alert("Password reset successfully. Please sign in with your new password.");
          } else {
            // Store session and login
            Auth.saveSession(data.token, data.user);
            this.onUserLoggedIn();
          }
        } else {
          alert(data.message || 'Verification failed. Please check the code.');
        }
      } catch (err) {
        console.error("ApexBudget // Verification exception: ", err);
        alert(`Verification failed: ${err.name || 'Error'}: ${err.message || err}`);
      }
    });

    // Logout Button
    document.getElementById('btn-logout').addEventListener('click', () => {
      Auth.logout();
      this.switchScreen('auth');
    });

    // Delete Account Button
    const btnDeleteAccount = document.getElementById('btn-delete-account');
    if (btnDeleteAccount) {
      btnDeleteAccount.addEventListener('click', async () => {
        if (confirm('Are you sure you want to permanently delete your account? This will erase all your transaction records and profile settings. This action is irreversible.')) {
          const token = Auth.getToken();
          try {
            const res = await fetch(API_BASE + '/api/profile', {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
              Auth.logout();
              this.switchScreen('auth');
              alert('Your account has been successfully deleted.');
            }
          } catch (e) {
            alert('Network error: Could not complete account deletion.');
          }
        }
      });
    }
    
    // Modals - Transaction Add/Edit
    document.getElementById('btn-add-tx').addEventListener('click', () => this.openTransactionModal());
    document.getElementById('btn-close-tx-modal').addEventListener('click', () => this.closeTransactionModal());
    document.getElementById('btn-cancel-tx-modal').addEventListener('click', () => this.closeTransactionModal());
    
    // Modals - Budget
    document.getElementById('btn-edit-budget').addEventListener('click', () => this.openBudgetModal());
    document.getElementById('btn-close-budget-modal').addEventListener('click', () => this.closeBudgetModal());
    document.getElementById('btn-cancel-budget-modal').addEventListener('click', () => this.closeBudgetModal());
    
    // Modals - Settings
    document.getElementById('btn-open-settings').addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-close-settings-modal').addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-cancel-settings-modal').addEventListener('click', () => this.closeSettingsModal());
    
    // Onboarding Tutorial Wizard handlers
    const btnNext = document.getElementById('btn-next-tutorial');
    const btnSkip = document.getElementById('btn-skip-tutorial');
    
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (this.currentTutorialStep < 5) {
          this.currentTutorialStep++;
          this.showTutorialStep(this.currentTutorialStep);
        } else {
          this.saveTutorialSeen();
        }
      });
    }
    
    if (btnSkip) {
      btnSkip.addEventListener('click', () => {
        this.saveTutorialSeen();
      });
    }
    
    // Transaction Type selector inside modal (Income / Expense toggle)
    document.getElementById('btn-type-expense').addEventListener('click', () => this.setTransactionModalType('expense'));
    document.getElementById('btn-type-income').addEventListener('click', () => this.setTransactionModalType('income'));
    
    // Transaction Submit Form
    document.getElementById('tx-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveTransaction();
    });
    
    // Budget Submit Form
    document.getElementById('budget-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveBudget();
    });
    
    // Theme Switcher Click
    document.getElementById('theme-toggle-btn').addEventListener('click', () => this.toggleTheme());
    
    // Ledger filtering and search
    document.getElementById('tx-search').addEventListener('input', () => this.renderLedgerPage());
    document.getElementById('tx-filter-category').addEventListener('change', () => this.renderLedgerPage());
    document.getElementById('tx-filter-type').addEventListener('change', () => this.renderLedgerPage());
    
    // Excel Export
    document.getElementById('btn-export-excel').addEventListener('click', () => this.exportToExcel());
    
    // Custom Currency Selector trigger toggle
    const dropdownTrigger = document.getElementById('currency-dropdown-trigger');
    const dropdownContainer = document.getElementById('currency-dropdown-container');
    
    dropdownTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownContainer.classList.toggle('active');
      // Close other dropdowns if open
      const countryContainer = document.getElementById('signup-country-dropdown-container');
      if (countryContainer) countryContainer.classList.remove('active');
      const txCategoryContainer = document.getElementById('tx-category-dropdown-container');
      if (txCategoryContainer) txCategoryContainer.classList.remove('active');
    });
    
    // Custom Registration Country Selector dropdown
    const countryTrigger = document.getElementById('signup-country-trigger');
    const countryContainer = document.getElementById('signup-country-dropdown-container');
    const countryActiveLabel = document.getElementById('signup-country-active-label');
    const countryHiddenInput = document.getElementById('signup-country');
    
    if (countryTrigger) {
      countryTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        countryContainer.classList.toggle('active');
        // Close currency selector if open
        dropdownContainer.classList.remove('active');
        const txCategoryContainer = document.getElementById('tx-category-dropdown-container');
        if (txCategoryContainer) txCategoryContainer.classList.remove('active');
      });
      
      // Select option clicks for country
      document.querySelectorAll('#signup-country-dropdown-options .custom-dropdown-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.getAttribute('data-value');
          const label = opt.innerText;
          
          countryHiddenInput.value = val;
          countryActiveLabel.innerText = label;
          countryActiveLabel.style.color = 'var(--text-primary)';
          countryContainer.classList.remove('active');
          
          // Mark selected option visually
          document.querySelectorAll('#signup-country-dropdown-options .custom-dropdown-option').forEach(o => {
            o.classList.remove('selected');
          });
          opt.classList.add('selected');
        });
      });
    }

    // Custom Transaction Category Selector trigger toggle
    const txCategoryTrigger = document.getElementById('tx-category-trigger');
    const txCategoryContainer = document.getElementById('tx-category-dropdown-container');
    
    if (txCategoryTrigger) {
      txCategoryTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        txCategoryContainer.classList.toggle('active');
        // Close other dropdowns if open
        dropdownContainer.classList.remove('active');
        if (countryContainer) countryContainer.classList.remove('active');
      });
    }
    
    // Close all custom dropdowns on clicking outside
    document.addEventListener('click', () => {
      dropdownContainer.classList.remove('active');
      if (countryContainer) countryContainer.classList.remove('active');
      if (txCategoryContainer) txCategoryContainer.classList.remove('active');
    });
    
    // Custom Dropdown Option selection clicks for currency
    document.querySelectorAll('#currency-dropdown-options .custom-dropdown-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = option.getAttribute('data-value');
        dropdownContainer.classList.remove('active');
        this.changeCurrency(value);
      });
    });
    
    // Dashboard View All link
    document.getElementById('btn-dashboard-view-all').addEventListener('click', () => {
      this.switchPage('transactions');
    });
  },
  
  setupOTPDigitInputs() {
    const inputs = document.querySelectorAll('.otp-digit');
    inputs.forEach((input, index) => {
      // Advance to next input on digit entry
      input.addEventListener('input', (e) => {
        if (input.value.length === 1) {
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        }
      });
      
      // Go back on backspace
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && input.value.length === 0) {
          if (index > 0) {
            inputs[index - 1].focus();
          }
        }
      });
    });
  },

  switchAuthPanel(mode) {
    document.getElementById('login-form').style.display = mode === 'login' ? 'block' : 'none';
    document.getElementById('signup-form').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('forgot-form').style.display = mode === 'forgot' ? 'block' : 'none';
    document.getElementById('auth-error-box').style.display = 'none';
    
    if (mode === 'login') {
      document.getElementById('auth-title').innerText = 'ApexBudget';
      document.getElementById('auth-subtitle').innerText = 'Sign in to manage your student finances';
      document.getElementById('auth-switch-text').innerText = "Don't have an account? ";
      document.getElementById('auth-switch-link').innerText = 'Sign Up';
    } else if (mode === 'signup') {
      document.getElementById('auth-title').innerText = 'Create Account';
      document.getElementById('auth-subtitle').innerText = 'Join ApexBudget to start tracking';
      document.getElementById('auth-switch-text').innerText = 'Already have an account? ';
      document.getElementById('auth-switch-link').innerText = 'Sign In';
    } else if (mode === 'forgot') {
      document.getElementById('auth-title').innerText = 'Reset Password';
      document.getElementById('auth-subtitle').innerText = 'Enter your email to request a reset code';
      document.getElementById('auth-switch-text').innerText = 'Remembered your password? ';
      document.getElementById('auth-switch-link').innerText = 'Sign In';
    }
  },

  openOTPModal(type, email) {
    const modal = document.getElementById('otp-modal');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
    
    // Clear old digit inputs
    document.querySelectorAll('.otp-digit').forEach(input => input.value = '');
    document.querySelector('.otp-digit').focus();
    
    // Configure header
    if (type === 'reset') {
      document.getElementById('otp-title').innerText = "Reset Password Verification";
      document.getElementById('otp-reset-password-group').style.display = 'block';
      document.getElementById('otp-new-password').required = true;
      document.getElementById('otp-new-password').value = '';
    } else {
      document.getElementById('otp-title').innerText = "Email Verification";
      document.getElementById('otp-reset-password-group').style.display = 'none';
      document.getElementById('otp-new-password').required = false;
    }
    
    document.getElementById('otp-subtitle').innerText = `We sent a 6-digit verification code to ${email}`;
    
    this.startOTPTimer();
  },

  closeOTPModal() {
    const modal = document.getElementById('otp-modal');
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);
    
    pendingOTPData = null;
    if (otpTimerInterval) {
      clearInterval(otpTimerInterval);
      otpTimerInterval = null;
    }
  },

  startOTPTimer() {
    if (otpTimerInterval) clearInterval(otpTimerInterval);
    
    const cooldownText = document.getElementById('otp-cooldown-text');
    const resendBtn = document.getElementById('btn-resend-otp');
    
    cooldownText.style.display = 'inline';
    resendBtn.style.display = 'none';
    
    let secondsLeft = 60;
    cooldownText.innerText = `Resend code in ${secondsLeft}s`;
    
    otpTimerInterval = setInterval(() => {
      secondsLeft--;
      cooldownText.innerText = `Resend code in ${secondsLeft}s`;
      
      if (secondsLeft <= 0) {
        clearInterval(otpTimerInterval);
        otpTimerInterval = null;
        cooldownText.style.display = 'none';
        resendBtn.style.display = 'inline-block';
      }
    }, 1000);
  },

  checkAuthentication() {
    if (Auth.loadSession()) {
      this.onUserLoggedIn();
    } else {
      this.switchScreen('auth');
    }
  },
  
  async fetchTransactions() {
    if (!currentUser) return;
    const token = Auth.getToken();
    try {
      const res = await fetch(API_BASE + '/api/transactions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const currencyCode = currentUser.currency || 'USD';
        currentUser.transactions = data.transactions.map(tx => {
          tx.amount = tx.amount * EXCHANGE_RATES[currencyCode];
          return tx;
        });
      }
    } catch (e) {
      console.error("ApexBudget // Error fetching transactions: ", e);
    }
  },

  async onUserLoggedIn() {
    this.switchScreen('app');
    
    // Fetch transactions from the real SQLite database
    await this.fetchTransactions();
    
    // Setup profile widgets
    document.getElementById('profile-name').innerText = currentUser.name;
    const nameParts = currentUser.name.split(' ');
    const initials = nameParts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('avatar-letters').innerText = initials || 'US';
    
    // Select correct currency in dropdown
    this.updateCurrencyDropdownUI();
    this.updateInputLabels();
    
    // Default page
    this.switchPage('dashboard');
    
    // Trigger onboarding tutorial if user hasn't completed it
    if (!currentUser.tutorial_seen) {
      this.openTutorialModal();
    }
  },
  
  updateCurrencyDropdownUI() {
    if (!currentUser) return;
    const curCode = currentUser.currency || 'USD';
    const labelMap = {
      USD: 'USD ($)',
      EUR: 'EUR (€)',
      GBP: 'GBP (£)',
      INR: 'INR (₹)',
      JPY: 'JPY (¥)',
      CAD: 'CAD (C$)'
    };
    
    document.getElementById('active-currency-label').innerText = labelMap[curCode] || 'USD ($)';
    
    document.querySelectorAll('.custom-dropdown-option').forEach(opt => {
      if (opt.getAttribute('data-value') === curCode) {
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    });
  },
  
  async changeCurrency(newCurrency) {
    if (!currentUser) return;
    const oldCurrency = currentUser.currency || 'USD';
    
    if (oldCurrency !== newCurrency) {
      const convert = (amount, from, to) => {
        const usdAmount = amount / EXCHANGE_RATES[from];
        return usdAmount * EXCHANGE_RATES[to];
      };
      
      // Convert all transaction values in memory
      currentUser.transactions = currentUser.transactions.map(tx => {
        tx.amount = convert(tx.amount, oldCurrency, newCurrency);
        return tx;
      });
      
      // Convert monthly budget limit value
      currentUser.budget = convert(currentUser.budget, oldCurrency, newCurrency);
      
      currentUser.currency = newCurrency;
      await Auth.updateUserData(currentUser.budget / EXCHANGE_RATES[newCurrency], newCurrency);
      this.updateCurrencyDropdownUI();
      this.updateInputLabels();
      
      // Refresh active page to apply currency formatting
      const activePage = document.querySelector('.app-page.active').id;
      this.switchPage(activePage.replace('page-', ''));
    }
  },
  
  updateInputLabels() {
    if (!currentUser) return;
    const curCode = currentUser.currency || 'USD';
    const symbol = CURRENCIES[curCode].symbol;
    
    // Update Add/Edit modal input labels
    document.querySelector('label[for="tx-amount"]').innerText = `Amount (${symbol})`;
    
    // Update Budget modal input label
    document.querySelector('label[for="budget-input"]').innerText = `Set Monthly Target Limit (${symbol})`;
  },
  
  switchScreen(screen) {
    if (screen === 'auth') {
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('app-screen').style.display = 'none';
      // Clear forms
      document.getElementById('login-form').reset();
      document.getElementById('signup-form').reset();
      document.getElementById('auth-error-box').style.display = 'none';
      
      // Reset custom country dropdown state to default (US)
      const hiddenCountryInput = document.getElementById('signup-country');
      if (hiddenCountryInput) hiddenCountryInput.value = 'US';
      const countryLabel = document.getElementById('signup-country-active-label');
      if (countryLabel) {
        countryLabel.innerText = 'United States (USD)';
        countryLabel.style.color = 'var(--text-primary)';
      }
      document.querySelectorAll('#signup-country-dropdown-options .custom-dropdown-option').forEach(opt => {
        if (opt.getAttribute('data-value') === 'US') {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      });
    } else {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app-screen').style.display = 'flex';
    }
  },
  
  switchPage(pageId) {
    // Nav highlights
    document.querySelectorAll('.nav-menu .nav-item').forEach(item => {
      if (item.getAttribute('data-page') === pageId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    
    // Page section toggle
    document.querySelectorAll('.app-page').forEach(page => {
      if (page.id === `page-${pageId}`) {
        page.classList.add('active');
      } else {
        page.classList.remove('active');
      }
    });
    
    // Update main title
    const titleMap = {
      dashboard: 'Dashboard',
      transactions: 'Financial Ledger',
      analytics: 'Analytics & Insights'
    };
    document.getElementById('dynamic-title').innerText = titleMap[pageId] || 'Dashboard';
    
    // Load page data
    if (pageId === 'dashboard') {
      this.renderDashboardPage();
    } else if (pageId === 'transactions') {
      this.renderLedgerPage();
    } else if (pageId === 'analytics') {
      this.renderAnalyticsPage();
    }
  },
  
  showAuthError(msg) {
    const box = document.getElementById('auth-error-box');
    document.getElementById('auth-error-msg').innerText = msg;
    box.style.display = 'block';
    
    // Retrigger animation
    box.style.animation = 'none';
    box.offsetHeight; /* trigger reflow */
    box.style.animation = null; 
  },
  
  updateDateDisplay() {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Date();
    document.getElementById('header-date').innerText = today.toLocaleDateString('en-US', options);
  },
  
  // Theme management
  initTheme() {
    const savedTheme = localStorage.getItem('apexbudget_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeUI(savedTheme);
  },
  
  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('apexbudget_theme', newTheme);
    this.updateThemeUI(newTheme);
    
    // Redraw charts since text/grid colors might need to update
    const activePage = document.querySelector('.app-page.active').id;
    if (activePage === 'page-dashboard') {
      this.renderDashboardPage();
    } else if (activePage === 'page-analytics') {
      this.renderAnalyticsPage();
    }
  },
  
  updateThemeUI(theme) {
    const moon = document.getElementById('theme-dark-icon');
    const sun = document.getElementById('theme-light-icon');
    const indicator = document.getElementById('theme-indicator-icon');
    
    if (theme === 'light') {
      sun.classList.add('active-theme');
      moon.classList.remove('active-theme');
      indicator.className = 'fas fa-sun';
      indicator.style.color = 'var(--warning)';
    } else {
      moon.classList.add('active-theme');
      sun.classList.remove('active-theme');
      indicator.className = 'fas fa-moon';
      indicator.style.color = 'var(--primary)';
    }
  },
  
  // Transaction Modal handlers
  openTransactionModal(txId = null) {
    const modal = document.getElementById('tx-modal');
    const form = document.getElementById('tx-form');
    form.reset();
    
    // Set default date to today
    document.getElementById('tx-date').value = new Date().toISOString().split('T')[0];
    
    if (txId) {
      document.getElementById('tx-modal-title').innerText = 'Edit Transaction';
      const tx = currentUser.transactions.find(t => t.id === txId);
      if (tx) {
        document.getElementById('tx-id').value = tx.id;
        document.getElementById('tx-description').value = tx.desc;
        document.getElementById('tx-amount').value = tx.amount;
        document.getElementById('tx-date').value = tx.date;
        this.setTransactionModalType(tx.type, tx.category);
      }
    } else {
      document.getElementById('tx-modal-title').innerText = 'New Transaction';
      document.getElementById('tx-id').value = '';
      this.setTransactionModalType('expense');
    }
    
    modal.classList.add('active');
  },
  
  closeTransactionModal() {
    document.getElementById('tx-modal').classList.remove('active');
  },
  
  setTransactionModalType(type, selectedVal = null) {
    const expBtn = document.getElementById('btn-type-expense');
    const incBtn = document.getElementById('btn-type-income');
    
    if (type === 'expense') {
      expBtn.classList.add('active');
      incBtn.classList.remove('active');
    } else {
      incBtn.classList.add('active');
      expBtn.classList.remove('active');
    }
    this.populateCategorySelector(type, selectedVal);
  },
  
  populateCategorySelector(type, selectedVal = null) {
    const optionsContainer = document.getElementById('tx-category-dropdown-options');
    const activeLabel = document.getElementById('tx-category-active-label');
    const hiddenInput = document.getElementById('tx-category');
    
    optionsContainer.innerHTML = '';
    
    const items = [];
    
    if (type === 'income') {
      items.push({
        value: 'income',
        label: 'Side Hustle & Income',
        icon: '💼'
      });
    } else {
      // All other categories except income
      Object.keys(CATEGORIES).forEach(key => {
        if (key !== 'income') {
          items.push({
            value: key,
            label: CATEGORIES[key].label,
            icon: CATEGORIES[key].icon
          });
        }
      });
    }
    
    // Determine the default selected value
    let defaultVal = selectedVal;
    if (!defaultVal || !items.some(item => item.value === defaultVal)) {
      defaultVal = items[0].value;
    }
    
    // Build custom dropdown options
    items.forEach(item => {
      const opt = document.createElement('div');
      opt.className = 'custom-dropdown-option';
      if (item.value === defaultVal) {
        opt.classList.add('selected');
        // Update input and label
        hiddenInput.value = item.value;
        activeLabel.innerHTML = `${item.icon} <span style="margin-left: 8px;">${item.label}</span>`;
      }
      opt.setAttribute('data-value', item.value);
      opt.innerHTML = `${item.icon} <span style="margin-left: 8px;">${item.label}</span>`;
      
      // Click handler
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        
        hiddenInput.value = item.value;
        activeLabel.innerHTML = `${item.icon} <span style="margin-left: 8px;">${item.label}</span>`;
        
        // Remove active class from container
        document.getElementById('tx-category-dropdown-container').classList.remove('active');
        
        // Mark visual selected state
        optionsContainer.querySelectorAll('.custom-dropdown-option').forEach(o => {
          o.classList.remove('selected');
        });
        opt.classList.add('selected');
      });
      
      optionsContainer.appendChild(opt);
    });
  },
  
  async saveTransaction() {
    const txId = document.getElementById('tx-id').value;
    const desc = document.getElementById('tx-description').value.trim();
    const amount = parseFloat(document.getElementById('tx-amount').value);
    const date = document.getElementById('tx-date').value;
    const category = document.getElementById('tx-category').value;
    const type = document.getElementById('btn-type-expense').classList.contains('active') ? 'expense' : 'income';
    
    if (!desc || isNaN(amount) || amount <= 0 || !date || !category) {
      alert('Please fill out all fields with valid data.');
      return;
    }
    
    const currencyCode = currentUser.currency || 'USD';
    const usdAmount = amount / EXCHANGE_RATES[currencyCode];
    const token = Auth.getToken();
    
    try {
      let res;
      if (txId) {
        // Edit mode
        res = await fetch(API_BASE + `/api/transactions/${txId}`, {
          method: 'PUT',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ desc, amount: usdAmount, category, type, date })
        });
      } else {
        // Add mode
        res = await fetch(API_BASE + '/api/transactions', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ desc, amount: usdAmount, category, type, date })
        });
      }
      
      if (res.ok) {
        await this.fetchTransactions();
        this.closeTransactionModal();
        const activePage = document.querySelector('.app-page.active').id;
        this.switchPage(activePage.replace('page-', ''));
      } else {
        const data = await res.json();
        alert(data.message || 'Saving transaction failed.');
      }
    } catch (e) {
      alert('Network error: Could not sync transaction with server.');
    }
  },
  
  async deleteTransaction(txId) {
    if (confirm('Are you sure you want to delete this transaction?')) {
      const token = Auth.getToken();
      try {
        const res = await fetch(API_BASE + `/api/transactions/${txId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          await this.fetchTransactions();
          const activePage = document.querySelector('.app-page.active').id;
          this.switchPage(activePage.replace('page-', ''));
        }
      } catch (e) {
        alert('Network error: Could not delete transaction from server.');
      }
    }
  },
  
  // Budget Modal handlers
  openBudgetModal() {
    const modal = document.getElementById('budget-modal');
    document.getElementById('budget-input').value = Math.round(currentUser.budget);
    modal.classList.add('active');
  },
  
  closeBudgetModal() {
    document.getElementById('budget-modal').classList.remove('active');
  },

  openSettingsModal() {
    if (!currentUser) return;
    document.getElementById('settings-name').value = currentUser.name;
    document.getElementById('settings-email').value = currentUser.email;
    const curCode = currentUser.currency || 'USD';
    const countryMap = {
      'US': 'United States', 'IN': 'India', 'GB': 'United Kingdom',
      'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'CA': 'Canada', 'OTH': 'Other'
    };
    const regionName = countryMap[currentUser.country] || 'Unknown Region';
    document.getElementById('settings-currency-region').value = `${regionName} (${curCode})`;
    
    document.getElementById('settings-modal').classList.add('active');
  },

  closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('active');
  },
  
  openTutorialModal() {
    this.currentTutorialStep = 1;
    this.showTutorialStep(1);
    document.getElementById('tutorial-modal').classList.add('active');
  },
  
  showTutorialStep(step) {
    // Hide all slides
    document.querySelectorAll('#tutorial-slides .tutorial-slide').forEach(slide => {
      slide.style.display = 'none';
      slide.classList.remove('active');
    });
    
    // Show active slide
    const activeSlide = document.querySelector(`#tutorial-slides .tutorial-slide[data-step="${step}"]`);
    if (activeSlide) {
      activeSlide.style.display = 'block';
      activeSlide.classList.add('active');
    }
    
    // Update step text indicator
    document.getElementById('tutorial-step-indicator').innerText = `Step ${step} of 5`;
    
    // Update dots indicator
    document.querySelectorAll('#tutorial-dots .dot').forEach((dot, idx) => {
      if (idx === step - 1) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });
    
    // Update next button label
    const btnNext = document.getElementById('btn-next-tutorial');
    if (step === 5) {
      btnNext.innerHTML = 'Get Started <i class="fas fa-check"></i>';
    } else {
      btnNext.innerHTML = 'Next <i class="fas fa-arrow-right" style="font-size: 0.75rem;"></i>';
    }
  },
  
  async saveTutorialSeen() {
    document.getElementById('tutorial-modal').classList.remove('active');
    if (!currentUser) return;
    
    currentUser.tutorial_seen = 1;
    localStorage.setItem('apexbudget_current_session', JSON.stringify(currentUser));
    
    const token = Auth.getToken();
    try {
      await fetch(API_BASE + '/api/profile', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tutorial_seen: 1 })
      });
    } catch (e) {
      console.warn("ApexBudget // Syncing tutorial seen status failed: ", e);
    }
  },
  
  async saveBudget() {
    const newBudget = parseFloat(document.getElementById('budget-input').value);
    if (isNaN(newBudget) || newBudget < 10) {
      alert('Please enter a valid monthly budget limit (minimum $10).');
      return;
    }
    
    const currencyCode = currentUser.currency || 'USD';
    const usdBudget = newBudget / EXCHANGE_RATES[currencyCode];
    await Auth.updateUserData(usdBudget, null);
    
    this.closeBudgetModal();
    const activePage = document.querySelector('.app-page.active').id;
    this.switchPage(activePage.replace('page-', ''));
  },
  
  // Calculate general values
  getMonthlyStats() {
    const today = new Date();
    // Use current date or max date from transaction array to find the current active month
    // In our 2026 scenario, let's use 2026-06 as the active month
    const curYearMonth = '2026-06';
    
    let totalIncome = 0;
    let totalSpent = 0;
    
    currentUser.transactions.forEach(tx => {
      if (tx.date.startsWith(curYearMonth)) {
        if (tx.type === 'income') {
          totalIncome += tx.amount;
        } else {
          totalSpent += tx.amount;
        }
      }
    });
    
    // Net balance across ALL transactions
    let netBalance = 0;
    currentUser.transactions.forEach(tx => {
      if (tx.type === 'income') {
        netBalance += tx.amount;
      } else {
        netBalance -= tx.amount;
      }
    });
    
    const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalSpent) / totalIncome) * 100) : 0;
    
    return {
      netBalance,
      totalIncome,
      totalSpent,
      savingsRate: Math.max(0, savingsRate),
      monthLabel: 'June 2026'
    };
  },
  
  // 4. Page 1: Dashboard Rendering
  renderDashboardPage() {
    const stats = this.getMonthlyStats();
    
    // Card values
    document.getElementById('val-balance').innerText = formatBalance(stats.netBalance);
    document.getElementById('val-income').innerText = formatCurrency(stats.totalIncome);
    document.getElementById('val-spent').innerText = formatCurrency(stats.totalSpent);
    document.getElementById('val-savings').innerText = `${stats.savingsRate}%`;
    
    document.getElementById('lbl-income-desc').innerText = `Income in ${stats.monthLabel}`;
    document.getElementById('lbl-spent-desc').innerText = `Expenses in ${stats.monthLabel}`;
    document.getElementById('lbl-savings-desc').innerText = `Saved in ${stats.monthLabel}`;
    
    // Budget Progress Tracker Radial
    const budget = (currentUser && currentUser.budget > 0) ? currentUser.budget : 600;
    const spentPercent = Math.min(100, Math.round((stats.totalSpent / budget) * 100));
    const radial = document.getElementById('budget-progress-radial');
    const progressLabel = document.getElementById('budget-spent-pct');
    const statusLabel = document.getElementById('budget-status-text');
    
    progressLabel.innerText = `${spentPercent}%`;
    statusLabel.innerText = `Spent ${formatCurrency(stats.totalSpent)} of ${formatCurrency(budget)}`;
    
    // Set circle background color based on usage
    let themeColor = 'var(--primary)';
    if (spentPercent >= 100) {
      themeColor = 'var(--danger)';
    } else if (spentPercent >= 80) {
      themeColor = 'var(--warning)';
    } else {
      themeColor = 'var(--accent-cyan)';
    }
    
    radial.style.background = `conic-gradient(${themeColor} ${spentPercent}%, rgba(255, 255, 255, 0.05) ${spentPercent}%)`;
    
    // Render recent transactions list (max 5)
    this.renderDashboardTransactions();
    
    // Build Category chart
    this.buildDashboardCategoryChart();
    
    // Generate student advice/tips
    this.generateStudentTips(stats);
  },
  
  renderDashboardTransactions() {
    const container = document.getElementById('dashboard-tx-list');
    container.innerHTML = '';
    
    const recentTxs = currentUser.transactions.slice(0, 5);
    
    if (recentTxs.length === 0) {
      container.innerHTML = '<p class="stat-desc" style="text-align: center; padding: 20px;">No transactions yet.</p>';
      return;
    }
    
    recentTxs.forEach(tx => {
      const cat = CATEGORIES[tx.category] || CATEGORIES.misc;
      const prefix = tx.type === 'income' ? '+' : '-';
      const amountFormatted = `${prefix}${formatCurrency(tx.amount)}`;
      const item = document.createElement('div');
      item.className = 'transaction-item';
      
      item.innerHTML = `
        <div class="tx-icon-desc">
          <div class="tx-cat-badge" style="box-shadow: 0 4px 10px ${tx.type === 'income' ? 'rgba(0,245,212,0.1)' : 'rgba(157,78,221,0.1)'}">${cat.icon}</div>
          <div class="tx-info">
            <span class="tx-title">${escapeHTML(tx.desc)}</span>
            <span class="tx-meta">${cat.label} • ${tx.date}</span>
          </div>
        </div>
        <div class="tx-amount-actions">
          <span class="tx-amount ${tx.type}">${amountFormatted}</span>
          <div class="tx-actions">
            <button class="tx-btn tx-btn-edit" onclick="UI.openTransactionModal('${tx.id}')" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="tx-btn tx-btn-delete" onclick="UI.deleteTransaction('${tx.id}')" title="Delete"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>
      `;
      container.appendChild(item);
    });
  },
  
  buildDashboardCategoryChart() {
    const ctx = document.getElementById('categoryChart').getContext('2d');
    
    // Filter June 2026 expenses
    const curYearMonth = '2026-06';
    const categoryTotals = {};
    
    // Initialize
    Object.keys(CATEGORIES).forEach(c => {
      if (c !== 'income') categoryTotals[c] = 0;
    });
    
    let totalExpense = 0;
    currentUser.transactions.forEach(tx => {
      if (tx.date.startsWith(curYearMonth) && tx.type === 'expense') {
        categoryTotals[tx.category] = (categoryTotals[tx.category] || 0) + tx.amount;
        totalExpense += tx.amount;
      }
    });
    
    const labels = [];
    const data = [];
    const colors = [];
    
    Object.keys(categoryTotals).forEach(c => {
      if (categoryTotals[c] > 0) {
        labels.push(CATEGORIES[c].label);
        data.push(categoryTotals[c]);
        colors.push(CATEGORIES[c].color);
      }
    });
    
    if (categoryChartInstance) {
      categoryChartInstance.destroy();
    }
    
    // If no expenses, show helper
    if (totalExpense === 0) {
      ctx.clearRect(0,0,300,300);
      document.getElementById('categoryChart').style.display = 'none';
      const container = document.getElementById('categoryChart').parentElement;
      let noDataEl = container.querySelector('.no-chart-data');
      if (!noDataEl) {
        noDataEl = document.createElement('div');
        noDataEl.className = 'no-chart-data stat-desc';
        noDataEl.style.cssText = 'height: 100%; display: flex; align-items: center; justify-content: center; text-align: center;';
        noDataEl.innerHTML = 'No expense data for this month. Add an expense to see the chart!';
        container.appendChild(noDataEl);
      } else {
        noDataEl.style.display = 'flex';
      }
      return;
    } else {
      document.getElementById('categoryChart').style.display = 'block';
      const container = document.getElementById('categoryChart').parentElement;
      const noDataEl = container.querySelector('.no-chart-data');
      if (noDataEl) noDataEl.style.display = 'none';
    }
    
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const textThemeColor = isDark ? '#f3f0ff' : '#1e1b29';
    
    categoryChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors,
          borderWidth: 1,
          borderColor: isDark ? 'rgba(0,0,0,0.4)' : '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: textThemeColor,
              font: {
                family: 'Inter',
                size: 11
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const percentage = Math.round((value / totalExpense) * 100);
                return ` ${formatCurrency(value)} (${percentage}%)`;
              }
            }
          }
        },
        cutout: '65%'
      }
    });
  },
  
  generateStudentTips(stats) {
    const list = document.getElementById('dashboard-tips-list');
    list.innerHTML = '';
    
    const tips = [];
    
    // Tip 1: Budget Alert
    const budget = (currentUser && currentUser.budget > 0) ? currentUser.budget : 600;
    const spentPercent = (stats.totalSpent / budget) * 100;
    if (spentPercent >= 100) {
      tips.push({
        title: 'Budget Limit Exceeded!',
        text: `You have spent ${formatCurrency(stats.totalSpent)}, which is over your monthly budget of ${formatCurrency(budget)}. Consider cutting back on Entertainment or Personal shopping.`,
        icon: '⚠️',
        color: 'var(--danger)'
      });
    } else if (spentPercent >= 80) {
      tips.push({
        title: 'Budget Warning',
        text: `You have used ${Math.round(spentPercent)}% of your monthly budget. Watch out for non-essential transactions.`,
        icon: '🔔',
        color: 'var(--warning)'
      });
    }
    
    // Tip 2: Category specific analysis
    const foodSpend = currentUser.transactions
      .filter(tx => tx.date.startsWith('2026-06') && tx.category === 'food')
      .reduce((sum, tx) => sum + tx.amount, 0);
      
    if (stats.totalSpent > 0 && (foodSpend / stats.totalSpent) > 0.35) {
      tips.push({
        title: 'Dining Out Heavy',
        text: 'Dining & Food constitutes more than 35% of your total spend. Try purchasing groceries in bulk or cooking at home to save $40+ weekly.',
        icon: '🍳',
        color: 'var(--primary)'
      });
    }
    
    // Tip 3: General Academic Tip
    const academicsSpend = currentUser.transactions
      .filter(tx => tx.date.startsWith('2026-06') && tx.category === 'academics')
      .reduce((sum, tx) => sum + tx.amount, 0);
      
    if (academicsSpend > 50) {
      tips.push({
        title: 'Save on Textbooks',
        text: 'Textbooks are costly! Search for digital PDFs, rent on Chegg, or browse university forums for secondhand copies before buying new.',
        icon: '📖',
        color: 'var(--accent-cyan)'
      });
    }
    
    // Add default student general advice if list is short
    if (tips.length < 3) {
      tips.push({
        title: 'Student Software Discounts',
        text: 'Don\'t pay retail! Check out GitHub Student Developer Pack, Notion Premium, and Adobe CC for heavily discounted/free memberships with your .edu mail.',
        icon: '💻',
        color: 'var(--accent-cyan)'
      });
      
      tips.push({
        title: 'Transit Discounts',
        text: 'Review campus options. Most colleges offer free university shuttles or subsidized local city bus passes.',
        icon: '🚌',
        color: 'var(--primary)'
      });
    }
    
    tips.slice(0, 3).forEach(tip => {
      const item = document.createElement('div');
      item.className = 'tip-item';
      item.style.borderLeftColor = tip.color;
      item.innerHTML = `
        <div class="tip-icon">${tip.icon}</div>
        <div class="tip-content">
          <h4>${tip.title}</h4>
          <p>${tip.text}</p>
        </div>
      `;
      list.appendChild(item);
    });
  },
  
  // 5. Page 2: Ledger page rendering
  renderLedgerPage() {
    const container = document.getElementById('ledger-tx-list');
    container.innerHTML = '';
    
    const searchVal = document.getElementById('tx-search').value.toLowerCase();
    const filterCat = document.getElementById('tx-filter-category').value;
    const filterType = document.getElementById('tx-filter-type').value;
    
    // Filters applied
    const filteredTxs = currentUser.transactions.filter(tx => {
      // Search matches description or category label
      const cat = CATEGORIES[tx.category] || CATEGORIES.misc;
      const descMatches = tx.desc.toLowerCase().includes(searchVal);
      const catMatches = cat.label.toLowerCase().includes(searchVal);
      const matchesSearch = descMatches || catMatches;
      
      // Category matches
      const matchesCat = filterCat === 'all' || tx.category === filterCat;
      
      // Type matches
      const matchesType = filterType === 'all' || tx.type === filterType;
      
      return matchesSearch && matchesCat && matchesType;
    });
    
    // Update counter
    document.getElementById('tx-count-label').innerText = `${filteredTxs.length} transaction${filteredTxs.length === 1 ? '' : 's'} found`;
    
    if (filteredTxs.length === 0) {
      container.innerHTML = '<p class="stat-desc" style="text-align: center; padding: 40px;">No matching transactions found.</p>';
      return;
    }
    
    filteredTxs.forEach(tx => {
      const cat = CATEGORIES[tx.category] || CATEGORIES.misc;
      const prefix = tx.type === 'income' ? '+' : '-';
      const amountFormatted = `${prefix}${formatCurrency(tx.amount)}`;
      const item = document.createElement('div');
      item.className = 'transaction-item';
      
      item.innerHTML = `
        <div class="tx-icon-desc">
          <div class="tx-cat-badge" style="box-shadow: 0 4px 10px ${tx.type === 'income' ? 'rgba(0,245,212,0.1)' : 'rgba(157,78,221,0.1)'}">${cat.icon}</div>
          <div class="tx-info">
            <span class="tx-title">${escapeHTML(tx.desc)}</span>
            <span class="tx-meta">${cat.label} • ${tx.date}</span>
          </div>
        </div>
        <div class="tx-amount-actions">
          <span class="tx-amount ${tx.type}">${amountFormatted}</span>
          <div class="tx-actions">
            <button class="tx-btn tx-btn-edit" onclick="UI.openTransactionModal('${tx.id}')" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="tx-btn tx-btn-delete" onclick="UI.deleteTransaction('${tx.id}')" title="Delete"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>
      `;
      container.appendChild(item);
    });
  },
  
  // 6. Page 3: Analytics Page Rendering
  renderAnalyticsPage() {
    this.buildAnalyticsTrendChart();
    this.renderAnalyticsCategoryBars();
    this.renderFinancialDiagnosis();
  },
  
  buildAnalyticsTrendChart() {
    const ctx = document.getElementById('trendChart').getContext('2d');
    
    // Generate data for past months: April, May, June 2026
    const months = ['2026-04', '2026-05', '2026-06'];
    const monthLabels = ['April', 'May', 'June'];
    const incomeData = [0, 0, 0];
    const expenseData = [0, 0, 0];
    
    currentUser.transactions.forEach(tx => {
      const idx = months.indexOf(tx.date.substring(0, 7));
      if (idx !== -1) {
        if (tx.type === 'income') {
          incomeData[idx] += tx.amount;
        } else {
          expenseData[idx] += tx.amount;
        }
      }
    });
    
    if (trendChartInstance) {
      trendChartInstance.destroy();
    }
    
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const textThemeColor = isDark ? '#f3f0ff' : '#1e1b29';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0,0,0,0.05)';
    
    trendChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: monthLabels,
        datasets: [
          {
            label: 'Monthly Income',
            data: incomeData,
            backgroundColor: 'rgba(0, 245, 212, 0.75)',
            borderColor: 'var(--accent-cyan)',
            borderWidth: 1,
            borderRadius: 6
          },
          {
            label: 'Monthly Expenses',
            data: expenseData,
            backgroundColor: 'rgba(157, 78, 221, 0.75)',
            borderColor: 'var(--primary)',
            borderWidth: 1,
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: textThemeColor,
              font: { family: 'Inter', weight: '600' }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textThemeColor }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: textThemeColor }
          }
        }
      }
    });
  },
  
  renderAnalyticsCategoryBars() {
    const container = document.getElementById('analytics-categories-progress');
    container.innerHTML = '';
    
    const curYearMonth = '2026-06';
    const totals = {};
    let grandTotal = 0;
    
    // Initialize
    Object.keys(CATEGORIES).forEach(c => {
      if (c !== 'income') totals[c] = 0;
    });
    
    currentUser.transactions.forEach(tx => {
      if (tx.date.startsWith(curYearMonth) && tx.type === 'expense') {
        totals[tx.category] = (totals[tx.category] || 0) + tx.amount;
        grandTotal += tx.amount;
      }
    });
    
    if (grandTotal === 0) {
      container.innerHTML = '<p class="stat-desc" style="text-align: center; padding: 20px;">No expenses logged for this month.</p>';
      return;
    }
    
    // Sort categories by amount spent descending
    const sortedCats = Object.keys(totals)
      .map(key => ({ key, amount: totals[key], pct: grandTotal > 0 ? (totals[key] / grandTotal) * 100 : 0 }))
      .sort((a, b) => b.amount - a.amount);
      
    sortedCats.forEach(item => {
      if (item.amount > 0) {
        const cat = CATEGORIES[item.key];
        const el = document.createElement('div');
        el.className = 'cat-stat-item';
        el.innerHTML = `
          <div class="cat-stat-header">
            <span>${cat.icon} ${cat.label}</span>
            <span style="color: var(--text-primary); font-weight: 700;">${formatCurrency(item.amount)} (${Math.round(item.pct)}%)</span>
          </div>
          <div class="cat-stat-bar-bg">
            <div class="cat-stat-bar-fill" style="background: ${cat.color}; width: 0%;"></div>
          </div>
        `;
        container.appendChild(el);
        
        // Trigger fill animation slightly after rendering
        setTimeout(() => {
          const fillBar = el.querySelector('.cat-stat-bar-fill');
          if (fillBar) fillBar.style.width = `${item.pct}%`;
        }, 100);
      }
    });
  },
  
  renderFinancialDiagnosis() {
    const list = document.getElementById('analytics-diagnosis-list');
    list.innerHTML = '';
    
    const stats = this.getMonthlyStats();
    const diagnostics = [];
    
    if (stats.totalIncome === 0 && stats.totalSpent === 0) {
      diagnostics.push({
        title: 'Fresh Financial Canvas',
        text: 'We haven\'t detected transactions for this period. Add your income allowances and typical expenses to unlock full semantic diagnostic analysis.',
        icon: '🎨',
        color: 'var(--text-muted)'
      });
    } else {
      // Savings rate feedback
      if (stats.savingsRate >= 30) {
        diagnostics.push({
          title: 'Stellar Savings Performance',
          text: `Wow! Your savings rate is ${stats.savingsRate}%, which is outstanding for a college student. You are building solid cushion funds. Keep it up!`,
          icon: '🌟',
          color: 'var(--success)'
        });
      } else if (stats.savingsRate > 0) {
        diagnostics.push({
          title: 'Steady Financial Path',
          text: `Your savings rate is ${stats.savingsRate}%. You are staying green, but optimizing dining out or transit expenses can unlock higher savings.`,
          icon: '👍',
          color: 'var(--accent-cyan)'
        });
      } else {
        diagnostics.push({
          title: 'Deficit Alert: High Cash Burn',
          text: 'Your expenditures this month exceed your income. Keep an eye on non-essential spending. Consider finding campus micro-gigs or peer tutoring roles to boost side allowance.',
          icon: '📉',
          color: 'var(--danger)'
        });
      }
      
      // Rent ratio
      const rentSpend = currentUser.transactions
        .filter(tx => tx.date.startsWith('2026-06') && tx.category === 'rent')
        .reduce((sum, tx) => sum + tx.amount, 0);
        
      if (stats.totalIncome > 0 && (rentSpend / stats.totalIncome) > 0.40) {
        diagnostics.push({
          title: 'High Rent Allocation',
          text: 'Rent eats up more than 40% of your current monthly income. Look into sharing utility packages or subletting space over the summer semester.',
          icon: '🏠',
          color: 'var(--warning)'
        });
      }
    }
    
    diagnostics.forEach(diag => {
      const item = document.createElement('div');
      item.className = 'tip-item';
      item.style.borderLeftColor = diag.color;
      item.innerHTML = `
        <div class="tip-icon">${diag.icon}</div>
        <div class="tip-content">
          <h4>${diag.title}</h4>
          <p>${diag.text}</p>
        </div>
      `;
      list.appendChild(item);
    });
  },
  
  // 7. SheetJS Integration - Export Transactions to Excel
  async exportToExcel() {
    if (!currentUser || currentUser.transactions.length === 0) {
      alert('No transactions to export.');
      return;
    }
    
    // Sort transactions chronologically
    const sorted = [...currentUser.transactions].sort((a,b) => new Date(a.date) - new Date(b.date));
    const curCode = currentUser.currency || 'USD';
    
    // Create ExcelJS workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ledger');
    
    // Grid lines visible
    worksheet.views = [{ showGridLines: true }];
    
    // Setup Column Widths
    const max_desc_width = Math.max(15, sorted.reduce((w, r) => Math.max(w, r.desc.length), 15));
    worksheet.columns = [
      { width: 6 },   // A: #
      { width: 13 },  // B: Date
      { width: max_desc_width + 4 }, // C: Description
      { width: 22 },  // D: Category
      { width: 11 },  // E: Type
      { width: 16 },  // F: Base USD ($)
      { width: 19 },  // G: Converted Amount
      { width: 10 },  // H: Currency
      { width: 15 },  // I: Rates Code
      { width: 15 }   // J: Rates Value
    ];
    
    // Define styles
    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FFE0DCE6' } },
      bottom: { style: 'thin', color: { argb: 'FFE0DCE6' } },
      left: { style: 'thin', color: { argb: 'FFE0DCE6' } },
      right: { style: 'thin', color: { argb: 'FFE0DCE6' } }
    };
    
    const doubleBottomBorder = {
      top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      bottom: { style: 'double', color: { argb: 'FF2D2A33' } }
    };
    
    // Helper to style cells in a range
    const styleCell = (cell, { font, fill, alignment, border, numFmt }) => {
      if (font) cell.font = font;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      if (alignment) cell.alignment = alignment;
      if (border) cell.border = border;
      if (numFmt) cell.numFmt = numFmt;
    };
    
    // Row 1: Title
    const row1 = worksheet.getRow(1);
    row1.getCell(1).value = "ApexBudget - Student Financial Ledger";
    row1.getCell(9).value = "Exchange Rates Table";
    worksheet.mergeCells('A1:H1');
    
    const titleFont = { name: 'Segoe UI', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
    const titleFill = 'FF4F1A88';
    const centerAlign = { horizontal: 'center', vertical: 'middle' };
    
    for (let c = 1; c <= 8; c++) {
      styleCell(row1.getCell(c), { font: titleFont, fill: titleFill, alignment: centerAlign });
    }
    styleCell(row1.getCell(9), {
      font: { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: titleFill,
      alignment: centerAlign
    });
    
    // Row 2: Subtitle
    const row2 = worksheet.getRow(2);
    row2.getCell(1).value = `Generated for ${currentUser.name} on ${new Date().toLocaleDateString()} // Active Profile: ${currentUser.email}`;
    row2.getCell(9).value = "Currency Code";
    row2.getCell(10).value = "Rate (vs USD)";
    worksheet.mergeCells('A2:H2');
    
    const subtitleFont = { name: 'Segoe UI', size: 9.5, italic: true, color: { argb: 'FF4F1A88' } };
    const subtitleFill = 'FFF3EBF9';
    
    for (let c = 1; c <= 8; c++) {
      styleCell(row2.getCell(c), { font: subtitleFont, fill: subtitleFill, alignment: centerAlign });
    }
    
    const rateHeaderStyle = {
      font: { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF4F1A88' } },
      fill: 'FFF3EBF9',
      alignment: centerAlign,
      border: thinBorder
    };
    styleCell(row2.getCell(9), rateHeaderStyle);
    styleCell(row2.getCell(10), rateHeaderStyle);
    
    // Row 3: Selector Controls & USD Rate
    const row3 = worksheet.getRow(3);
    row3.getCell(1).value = "Change Display Currency:";
    row3.getCell(2).value = curCode;
    row3.getCell(3).value = "(Select USD, EUR, GBP, INR, JPY, or CAD from dropdown in B3 to convert)";
    row3.getCell(9).value = "USD";
    row3.getCell(10).value = EXCHANGE_RATES.USD;
    worksheet.mergeCells('C3:H3');
    
    styleCell(row3.getCell(1), {
      font: { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF2D2A33' } },
      alignment: { horizontal: 'right', vertical: 'middle' }
    });
    styleCell(row3.getCell(2), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF7A3CB5' } },
      fill: 'FFF3EBF9',
      alignment: centerAlign,
      border: thinBorder
    });
    styleCell(row3.getCell(3), {
      font: { name: 'Segoe UI', size: 8.5, italic: true, color: { argb: 'FF666666' } },
      alignment: { horizontal: 'left', vertical: 'middle' }
    });
    
    // Dropdown list validation for B3
    row3.getCell(2).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"USD,EUR,GBP,INR,JPY,CAD"'],
      showErrorMessage: true,
      errorTitle: 'Invalid Currency',
      error: 'Please select from the list: USD, EUR, GBP, INR, JPY, or CAD'
    };
    
    const rateValStyle = {
      font: { name: 'Segoe UI', size: 9, color: { argb: 'FF2D2A33' } },
      alignment: centerAlign,
      border: thinBorder
    };
    styleCell(row3.getCell(9), rateValStyle);
    styleCell(row3.getCell(10), { ...rateValStyle, numFmt: '0.00' });
    
    // Rows 4-8: Rates for other currencies
    const rateCurrencies = ['EUR', 'GBP', 'INR', 'JPY', 'CAD'];
    rateCurrencies.forEach((cCode, i) => {
      const rIdx = 4 + i;
      const row = worksheet.getRow(rIdx);
      row.getCell(9).value = cCode;
      row.getCell(10).value = EXCHANGE_RATES[cCode];
      styleCell(row.getCell(9), rateValStyle);
      styleCell(row.getCell(10), { ...rateValStyle, numFmt: '0.00' });
    });
    
    // Row 9: Blank row
    // Row 10: Table Headers
    const row10 = worksheet.getRow(10);
    const headers = ["#", "Date", "Description", "Category", "Type", "Base USD ($)", "Converted Amount", "Currency"];
    headers.forEach((h, c) => {
      const cell = row10.getCell(c + 1);
      cell.value = h;
      styleCell(cell, {
        font: { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } },
        fill: 'FF7A3CB5',
        alignment: centerAlign,
        border: thinBorder
      });
    });
    
    // Rows 11+: Data Rows
    const dataStartRow = 11;
    sorted.forEach((tx, idx) => {
      const R = dataStartRow + idx;
      const row = worksheet.getRow(R);
      const cat = CATEGORIES[tx.category] || CATEGORIES.misc;
      const usdBaseAmount = tx.amount / EXCHANGE_RATES[currentUser.currency || 'USD'];
      
      row.getCell(1).value = idx + 1;
      row.getCell(2).value = tx.date;
      row.getCell(3).value = tx.desc;
      row.getCell(4).value = cat.label;
      row.getCell(5).value = tx.type.charAt(0).toUpperCase() + tx.type.slice(1);
      row.getCell(6).value = usdBaseAmount;
      row.getCell(7).value = { formula: `F${R} * VLOOKUP($B$3, $I$3:$J$8, 2, FALSE)` };
      row.getCell(8).value = { formula: `$B$3` };
      
      const bgHex = (R % 2 === 0) ? 'FFF7F5FA' : 'FFFFFFFF';
      const isInc = tx.type === 'income';
      
      for (let c = 1; c <= 8; c++) {
        const cell = row.getCell(c);
        const alignment = (c === 1 || c === 2 || c === 4 || c === 5 || c === 8) 
          ? centerAlign 
          : (c === 3 ? { horizontal: 'left', vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' });
        
        styleCell(cell, {
          font: { 
            name: 'Segoe UI', 
            size: 9.5, 
            color: { argb: 'FF2D2A33' },
            bold: c === 5,
            ...(c === 5 && { color: { argb: isInc ? 'FF008F5A' : 'FFD9383A' } })
          },
          fill: bgHex,
          alignment,
          border: thinBorder,
          numFmt: c === 6 ? '$#,##0.00' : (c === 7 ? '#,##0.00' : null)
        });
      }
    });
    
    const dataEndRow = dataStartRow + sorted.length - 1;
    const E = dataEndRow;
    
    // Summary Rows
    // E+1 is blank row
    // E+2: Total Income
    const rTotalInc = worksheet.getRow(E + 2);
    rTotalInc.getCell(5).value = "Total Income";
    rTotalInc.getCell(7).value = { formula: `SUMIF(E11:E${E}, "Income", G11:G${E})` };
    
    styleCell(rTotalInc.getCell(5), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      alignment: { horizontal: 'right', vertical: 'middle' },
      border: { top: { style: 'thin', color: { argb: 'FFCCCCCC' } } }
    });
    styleCell(rTotalInc.getCell(7), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      alignment: { horizontal: 'right', vertical: 'middle' },
      border: { top: { style: 'thin', color: { argb: 'FFCCCCCC' } } },
      numFmt: '#,##0.00'
    });
    
    // E+3: Total Expenses
    const rTotalExp = worksheet.getRow(E + 3);
    rTotalExp.getCell(5).value = "Total Expenses";
    rTotalExp.getCell(7).value = { formula: `SUMIF(E11:E${E}, "Expense", G11:G${E})` };
    
    styleCell(rTotalExp.getCell(5), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      alignment: { horizontal: 'right', vertical: 'middle' }
    });
    styleCell(rTotalExp.getCell(7), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      alignment: { horizontal: 'right', vertical: 'middle' },
      numFmt: '#,##0.00'
    });
    
    // E+4: Net Balance
    const rNetBal = worksheet.getRow(E + 4);
    rNetBal.getCell(5).value = "Net Balance";
    rNetBal.getCell(7).value = { formula: `G${E+2}-G${E+3}` };
    
    const summaryFill = 'FFF3EBF9';
    
    styleCell(rNetBal.getCell(5), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      fill: summaryFill,
      alignment: { horizontal: 'right', vertical: 'middle' },
      border: doubleBottomBorder
    });
    styleCell(rNetBal.getCell(7), {
      font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2D2A33' } },
      fill: summaryFill,
      alignment: { horizontal: 'right', vertical: 'middle' },
      border: doubleBottomBorder,
      numFmt: '#,##0.00'
    });
    
    // Export and download
    const filename = `ApexBudget_${currentUser.name.replace(/\s+/g, '_')}_Ledger.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  }
};

// Start the Application
window.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
