import http.server
import socketserver
import json
import pymysql
import os
import hashlib
import secrets
import uuid
import time
from datetime import datetime, timedelta
import urllib.request
import urllib.parse
import ssl

PORT = int(os.environ.get('PORT', 8000))

# 1. Load Environment Configuration
def load_env():
    env_vars = {
        'DB_HOST': 'localhost',
        'DB_PORT': '3306',
        'DB_USER': 'root',
        'DB_PASSWORD': '',
        'DB_NAME': 'apexbudget_db',
        'DB_SSL': 'false',
        'GOOGLE_CLIENT_ID': '',
        'GOOGLE_CLIENT_SECRET': '',
        'GITHUB_CLIENT_ID': '',
        'GITHUB_CLIENT_SECRET': '',
        'RESEND_API_KEY': '',
        'SMTP_HOST': 'smtp.gmail.com',
        'SMTP_PORT': '465',
        'SMTP_USER': '',
        'SMTP_PASSWORD': '',
        'SMTP_EMAIL': ''
    }
    # Load .env relative to server.py
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, val = line.split('=', 1)
                    env_vars[key.strip()] = val.strip()
    # Override with system environment variables if present
    for key in env_vars:
        if key in os.environ:
            env_vars[key] = os.environ[key]
    # Check for DB_SSL in os.environ directly in case it wasn't in the default keys
    if 'DB_SSL' in os.environ:
        env_vars['DB_SSL'] = os.environ['DB_SSL']
    return env_vars

ENV = load_env()
DB_HOST = ENV['DB_HOST']
DB_PORT = int(ENV['DB_PORT'])
DB_USER = ENV['DB_USER']
DB_PASSWORD = ENV['DB_PASSWORD']
DB_NAME = ENV['DB_NAME']
DB_SSL = ENV['DB_SSL'].lower() in ('true', '1', 'yes')

GOOGLE_CLIENT_ID = ENV['GOOGLE_CLIENT_ID']
GOOGLE_CLIENT_SECRET = ENV['GOOGLE_CLIENT_SECRET']
GITHUB_CLIENT_ID = ENV['GITHUB_CLIENT_ID']
GITHUB_CLIENT_SECRET = ENV['GITHUB_CLIENT_SECRET']

RESEND_API_KEY = ENV['RESEND_API_KEY']
SMTP_HOST = ENV['SMTP_HOST']
SMTP_PORT = ENV['SMTP_PORT']
SMTP_USER = ENV['SMTP_USER']
SMTP_PASSWORD = ENV['SMTP_PASSWORD']
SMTP_EMAIL = ENV['SMTP_EMAIL']

# 2. Database Connection Helpers
def get_db_connection():
    ssl_context = None
    if DB_SSL:
        import ssl
        ssl_context = ssl.create_default_context()
        
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
        ssl=ssl_context
    )

def init_db():
    # Retry loop to connect to MySQL database on startup
    max_retries = 10
    retry_delay = 3
    connected = False
    
    for attempt in range(1, max_retries + 1):
        print(f"ApexBudget // Connecting to MySQL at {DB_HOST}:{DB_PORT} (Attempt {attempt}/{max_retries})...")
        try:
            ssl_context = None
            if DB_SSL:
                import ssl
                ssl_context = ssl.create_default_context()
                
            # Connect without specifying database name first to create it if needed
            conn = pymysql.connect(
                host=DB_HOST,
                port=DB_PORT,
                user=DB_USER,
                password=DB_PASSWORD,
                autocommit=True,
                ssl=ssl_context
            )
            cursor = conn.cursor()
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {DB_NAME}")
            cursor.close()
            conn.close()
            connected = True
            break
        except Exception as e:
            print(f"Warning: Connection attempt {attempt} failed: {e}")
            if attempt < max_retries:
                print(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                print("Error: Max connection attempts reached. MySQL is not available.")
                raise e

    # Connect to database and create schemas
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Create users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            email VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            budget DOUBLE DEFAULT 600.0,
            currency VARCHAR(10) DEFAULT 'USD',
            country VARCHAR(10) DEFAULT 'US',
            tutorial_seen TINYINT DEFAULT 0
        )
    ''')
    
    # Auto-migration: Ensure tutorial_seen column exists for existing databases
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN tutorial_seen TINYINT DEFAULT 0")
    except Exception:
        pass
    
    # Create sessions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            token VARCHAR(255) PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            expires_at VARCHAR(255) NOT NULL,
            FOREIGN KEY (email) REFERENCES users (email) ON DELETE CASCADE
        )
    ''')
    
    # Create transactions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS transactions (
            id VARCHAR(255) PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            `desc` VARCHAR(255) NOT NULL,
            amount DOUBLE NOT NULL,
            category VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            date VARCHAR(50) NOT NULL,
            FOREIGN KEY (user_email) REFERENCES users (email) ON DELETE CASCADE
        )
    ''')
    
    # Create otp_codes table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS otp_codes (
            email VARCHAR(255) NOT NULL,
            code_hash VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            expires_at VARCHAR(255) NOT NULL,
            PRIMARY KEY (email, type)
        )
    ''')
    
    cursor.close()
    conn.close()
    print("ApexBudget // MySQL Database and schemas initialized successfully.")

# 3. Cryptography Helpers (Password Hashing)
def hash_password(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)
    # 100,000 iterations of PBKDF2 (SHA-256)
    pwdhash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return f"{salt}:{pwdhash.hex()}"

def verify_password(stored_password, provided_password):
    try:
        salt, stored_hash = stored_password.split(':')
        pwdhash = hashlib.pbkdf2_hmac('sha256', provided_password.encode('utf-8'), salt.encode('utf-8'), 100000)
        return pwdhash.hex() == stored_hash
    except Exception:
        return False

def email_send_otp(email, code, type_str):
    subject_map = {
        'signup': 'Verify your email - ApexBudget',
        'login': 'Your One-Time Password (OTP) - ApexBudget',
        'reset': 'Reset your password - ApexBudget'
    }
    action_map = {
        'signup': 'create your account',
        'login': 'log in to your account',
        'reset': 'reset your password'
    }
    
    subject = subject_map.get(type_str, 'Verification Code - ApexBudget')
    action = action_map.get(type_str, 'verify your session')
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e8ed; border-radius: 8px;">
        <h2 style="color: #4f46e5; margin-bottom: 24px; text-align: center;">ApexBudget Verification</h2>
        <p>Hello,</p>
        <p>You requested a One-Time Password (OTP) to {action}. Use the following 6-digit code to complete the verification:</p>
        <div style="background-color: #f3f4f6; padding: 16px; font-size: 32px; font-weight: bold; text-align: center; letter-spacing: 6px; color: #111827; border-radius: 6px; margin: 24px 0;">
            {code}
        </div>
        <p style="color: #6b7280; font-size: 14px;">This code is valid for <strong>5 minutes</strong>. If you did not make this request, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">ApexBudget // Modern Student Expense Tracker</p>
    </div>
    """
    
    # 1. Try Resend API
    if RESEND_API_KEY:
        url = "https://api.resend.com/emails"
        headers = {
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "ApexBudget-App/1.0"
        }
        from_email = SMTP_EMAIL if SMTP_EMAIL else "onboarding@resend.dev"
        payload = json.dumps({
            "from": from_email,
            "to": email,
            "subject": subject,
            "html": html_content
        }).encode('utf-8')
        
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
            with urllib.request.urlopen(req) as response:
                res = json.loads(response.read().decode('utf-8'))
                print(f"ApexBudget // Sent OTP via Resend. Result: {res}")
                return True
        except Exception as e:
            print(f"Warning: Failed to send OTP via Resend: {e}")
            
    # 2. Try SMTP
    if SMTP_USER and SMTP_PASSWORD:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = SMTP_EMAIL if SMTP_EMAIL else SMTP_USER
        msg['To'] = email
        
        part = MIMEText(html_content, 'html')
        msg.attach(part)
        
        try:
            port = int(SMTP_PORT) if SMTP_PORT else 465
            if port == 465:
                with smtplib.SMTP_SSL(SMTP_HOST, port) as server:
                    server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(msg['From'], [email], msg.as_string())
            else:
                with smtplib.SMTP(SMTP_HOST, port) as server:
                    server.starttls()
                    server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(msg['From'], [email], msg.as_string())
            print(f"ApexBudget // Sent OTP via SMTP ({SMTP_HOST}) to {email}")
            return True
        except Exception as e:
            print(f"Warning: Failed to send OTP via SMTP: {e}")
            
    # 3. Console fallback
    print(f"\n==========================================", flush=True)
    print(f"  APEXBUDGET OTP FALLBACK LOG", flush=True)
    print(f"  To: {email}", flush=True)
    print(f"  Type: {type_str}", flush=True)
    print(f"  OTP Code: {code}", flush=True)
    print(f"==========================================\n", flush=True)
    return False

# 4. HTTP Server Handler
class AppRequestHandler(http.server.BaseHTTPRequestHandler):
    
    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def get_auth_user(self):
        auth_header = self.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return None
        
        token = auth_header.split(' ')[1]
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check active session token
        cursor.execute("SELECT email, expires_at FROM sessions WHERE token = %s", (token,))
        session = cursor.fetchone()
        
        if not session:
            cursor.close()
            conn.close()
            return None
        
        # Check expiry
        now = datetime.utcnow().isoformat()
        if session['expires_at'] < now:
            # Delete expired session
            cursor.execute("DELETE FROM sessions WHERE token = %s", (token,))
            cursor.close()
            conn.close()
            return None
            
        # Get user details
        cursor.execute("SELECT email, name, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (session['email'],))
        user = cursor.fetchone()
        cursor.close()
        conn.close()
        
        return user

    def respond_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def respond_error(self, status, message):
        self.respond_json(status, {"success": False, "message": message})

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        query = urllib.parse.parse_qs(parsed_url.query)
        
        # 1. API route: get transactions
        if path == '/api/transactions':
            user = self.get_auth_user()
            if not user:
                return self.respond_error(401, "Unauthorized: Invalid or expired session.")
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            cursor.execute("SELECT id, `desc`, amount, category, type, date FROM transactions WHERE user_email = %s ORDER BY date DESC", (user['email'],))
            rows = cursor.fetchall()
            cursor.close()
            conn.close()
            
            tx_list = list(rows) if rows else []
            return self.respond_json(200, {"success": True, "transactions": tx_list})

        elif path == '/api/auth/users':
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT email, name FROM users")
            rows = cursor.fetchall()
            cursor.close()
            conn.close()
            
            user_list = list(rows) if rows else []
            return self.respond_json(200, {"success": True, "users": user_list})

        # --- Real Google & GitHub OAuth Endpoints ---
        elif path == '/api/auth/google/login':
            # Check if Client ID is configured
            if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
                host = self.headers.get('Host', '')
                proto = 'https' if 'onrender' in host else 'http'
                redirect_uri = f"{proto}://{host}/api/auth/google/callback"
                
                auth_url = (
                    "https://accounts.google.com/o/oauth2/v2/auth?"
                    f"response_type=code&client_id={urllib.parse.quote(GOOGLE_CLIENT_ID)}&"
                    f"redirect_uri={urllib.parse.quote(redirect_uri)}&"
                    "scope=openid%20profile%20email"
                )
                self.send_response(302)
                self.send_header('Location', auth_url)
                self.end_headers()
                return
            else:
                # Fallback to simulated OAuth popup page
                self.send_response(302)
                self.send_header('Location', '/oauth-mock.html?provider=google')
                self.end_headers()
                return

        elif path == '/api/auth/google/callback':
            code = query.get('code', [None])[0]
            if not code:
                return self.respond_error(400, "Auth Code is missing")
                
            host = self.headers.get('Host', '')
            proto = 'https' if 'onrender' in host else 'http'
            redirect_uri = f"{proto}://{host}/api/auth/google/callback"
            
            # Exchange code for access token
            token_url = "https://oauth2.googleapis.com/token"
            data = urllib.parse.urlencode({
                'code': code,
                'client_id': GOOGLE_CLIENT_ID,
                'client_secret': GOOGLE_CLIENT_SECRET,
                'redirect_uri': redirect_uri,
                'grant_type': 'authorization_code'
            }).encode('utf-8')
            
            try:
                req = urllib.request.Request(token_url, data=data)
                with urllib.request.urlopen(req) as response:
                    res_body = json.loads(response.read().decode('utf-8'))
                    access_token = res_body.get('access_token')
                    
                # Fetch user details
                user_info_url = "https://www.googleapis.com/oauth2/v3/userinfo"
                req_user = urllib.request.Request(user_info_url)
                req_user.add_header('Authorization', f"Bearer {access_token}")
                
                with urllib.request.urlopen(req_user) as response_user:
                    profile = json.loads(response_user.read().decode('utf-8'))
                    email = profile.get('email', '').strip().lower()
                    name = profile.get('name', '').strip()
                    
                if not email:
                    return self.respond_error(400, "Google did not return an email address")
                    
                self.send_response(200)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                
                html = f"""<!DOCTYPE html>
<html>
<body>
  <script>
    if (window.opener) {{
      window.opener.postMessage({{
        type: 'oauth-success',
        provider: 'google',
        profile: 'custom',
        email: '{email}',
        name: '{name}'
      }}, '*');
    }}
    window.close();
  </script>
</body>
</html>"""
                self.wfile.write(html.encode('utf-8'))
                return
            except Exception as e:
                return self.respond_error(500, f"Google OAuth exchange failed: {e}")

        elif path == '/api/auth/github/login':
            # Check if Client ID is configured
            if GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET:
                host = self.headers.get('Host', '')
                proto = 'https' if 'onrender' in host else 'http'
                redirect_uri = f"{proto}://{host}/api/auth/github/callback"
                
                auth_url = (
                    "https://github.com/login/oauth/authorize?"
                    f"client_id={urllib.parse.quote(GITHUB_CLIENT_ID)}&"
                    f"redirect_uri={urllib.parse.quote(redirect_uri)}&"
                    "scope=read:user%20user:email"
                )
                self.send_response(302)
                self.send_header('Location', auth_url)
                self.end_headers()
                return
            else:
                self.send_response(302)
                self.send_header('Location', '/oauth-mock.html?provider=github')
                self.end_headers()
                return

        elif path == '/api/auth/github/callback':
            code = query.get('code', [None])[0]
            if not code:
                return self.respond_error(400, "Auth Code is missing")
                
            host = self.headers.get('Host', '')
            proto = 'https' if 'onrender' in host else 'http'
            redirect_uri = f"{proto}://{host}/api/auth/github/callback"
            
            token_url = "https://github.com/login/oauth/access_token"
            data = urllib.parse.urlencode({
                'code': code,
                'client_id': GITHUB_CLIENT_ID,
                'client_secret': GITHUB_CLIENT_SECRET,
                'redirect_uri': redirect_uri
            }).encode('utf-8')
            
            try:
                # Exchange code for access token
                req = urllib.request.Request(token_url, data=data)
                req.add_header('Accept', 'application/json')
                with urllib.request.urlopen(req) as response:
                    res_body = json.loads(response.read().decode('utf-8'))
                    access_token = res_body.get('access_token')
                    
                # Fetch user details
                user_info_url = "https://api.github.com/user"
                req_user = urllib.request.Request(user_info_url)
                req_user.add_header('Authorization', f"token {access_token}")
                req_user.add_header('User-Agent', 'ApexBudget-App')
                
                with urllib.request.urlopen(req_user) as response_user:
                    profile = json.loads(response_user.read().decode('utf-8'))
                    name = profile.get('name') or profile.get('login', '')
                    name = name.strip()
                    
                # Fetch primary email from GitHub emails API
                emails_url = "https://api.github.com/user/emails"
                req_emails = urllib.request.Request(emails_url)
                req_emails.add_header('Authorization', f"token {access_token}")
                req_emails.add_header('User-Agent', 'ApexBudget-App')
                
                email = ''
                with urllib.request.urlopen(req_emails) as response_emails:
                    emails_list = json.loads(response_emails.read().decode('utf-8'))
                    for email_obj in emails_list:
                        if email_obj.get('primary'):
                            email = email_obj.get('email', '').strip().lower()
                            break
                    if not email and emails_list:
                        email = emails_list[0].get('email', '').strip().lower()
                        
                if not email:
                    return self.respond_error(400, "GitHub did not return a primary email address")
                    
                self.send_response(200)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                
                html = f"""<!DOCTYPE html>
<html>
<body>
  <script>
    if (window.opener) {{
      window.opener.postMessage({{
        type: 'oauth-success',
        provider: 'github',
        profile: 'custom',
        email: '{email}',
        name: '{name}'
      }}, '*');
    }}
    window.close();
  </script>
</body>
</html>"""
                self.wfile.write(html.encode('utf-8'))
                return
            except Exception as e:
                return self.respond_error(500, f"GitHub OAuth exchange failed: {e}")

        # 2. Static files fallback
        self.serve_static_file()

    def do_POST(self):
        try:
            self._do_POST_internal()
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.respond_error(500, f"Internal Server Error: {str(e)}")

    def _do_POST_internal(self):
        # Parse JSON body
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else ""
        
        try:
            body = json.loads(post_data) if post_data else {}
        except json.JSONDecodeError:
            return self.respond_error(400, "Bad Request: Invalid JSON payload.")

        # 1. API Route: Send OTP
        if self.path == '/api/auth/otp/send':
            email = body.get('email', '').strip().lower()
            type_val = body.get('type', '').strip() # 'signup', 'login', 'reset'
            password = body.get('password', '') # only needed if type is 'login'
            
            if not email or not type_val:
                return self.respond_error(400, "Bad Request: Email and Type are required.")
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Check user existence
            cursor.execute("SELECT email, password_hash FROM users WHERE email = %s", (email,))
            user = cursor.fetchone()
            
            if type_val == 'signup':
                if user:
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "An account with this email already exists.")
            elif type_val in ('login', 'reset'):
                if not user:
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "No account found with this email.")
                
                # For login type, verify password before sending OTP
                if type_val == 'login':
                    if not verify_password(user['password_hash'], password):
                        cursor.close()
                        conn.close()
                        return self.respond_error(401, "Invalid email or password.")
            
            # Generate 6-digit OTP
            otp_code = "".join([str(secrets.randbelow(10)) for _ in range(6)])
            otp_hash = hash_password(otp_code)
            expiry = (datetime.utcnow() + timedelta(minutes=5)).isoformat()
            
            # Save OTP to database (replace if exists)
            cursor.execute("DELETE FROM otp_codes WHERE email = %s AND type = %s", (email, type_val))
            cursor.execute(
                "INSERT INTO otp_codes (email, code_hash, type, expires_at) VALUES (%s, %s, %s, %s)",
                (email, otp_hash, type_val, expiry)
            )
            cursor.close()
            conn.close()
            
            # Send email
            sent_email = email_send_otp(email, otp_code, type_val)
            
            # Return response
            res_data = {"success": True, "message": "Verification code sent."}
            
            # Safely expose fallback OTP ONLY for local testing (localhost / 127.0.0.1) when email failed
            host = self.headers.get('Host', '')
            is_local = 'localhost' in host or '127.0.0.1' in host
            if not sent_email and is_local:
                res_data["otp_fallback"] = otp_code
                
            return self.respond_json(200, res_data)

        # 2. API Route: Verify OTP
        elif self.path == '/api/auth/otp/verify':
            email = body.get('email', '').strip().lower()
            code = body.get('code', '').strip()
            type_val = body.get('type', '').strip() # 'signup', 'login', 'reset'
            
            if not email or not code or not type_val:
                return self.respond_error(400, "Bad Request: Email, Code, and Type are required.")
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Fetch OTP code
            cursor.execute("SELECT code_hash, expires_at FROM otp_codes WHERE email = %s AND type = %s", (email, type_val))
            otp = cursor.fetchone()
            
            if not otp:
                cursor.close()
                conn.close()
                return self.respond_error(400, "Invalid or expired verification code.")
                
            # Check expiry
            now = datetime.utcnow().isoformat()
            if otp['expires_at'] < now:
                cursor.execute("DELETE FROM otp_codes WHERE email = %s AND type = %s", (email, type_val))
                cursor.close()
                conn.close()
                return self.respond_error(400, "Verification code has expired.")
                
            # Verify code hash
            if not verify_password(otp['code_hash'], code):
                cursor.close()
                conn.close()
                return self.respond_error(400, "Invalid verification code.")
                
            # OTP is valid! Delete it immediately
            cursor.execute("DELETE FROM otp_codes WHERE email = %s AND type = %s", (email, type_val))
            
            # Perform action based on type
            if type_val == 'signup':
                name = body.get('name', '').strip()
                password = body.get('password', '')
                country = body.get('country', 'US').strip()
                
                if not name or not password:
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "Bad Request: Name and Password are required for signup.")
                    
                # Double check user existence
                cursor.execute("SELECT email FROM users WHERE email = %s", (email,))
                if cursor.fetchone():
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "An account with this email already exists.")
                    
                # Create user
                COUNTRY_CURRENCY_MAP = {
                    'US': 'USD', 'IN': 'INR', 'GB': 'GBP', 'DE': 'EUR',
                    'FR': 'EUR', 'JP': 'JPY', 'CA': 'CAD', 'OTH': 'USD'
                }
                currency = COUNTRY_CURRENCY_MAP.get(country, 'USD')
                password_hash = hash_password(password)
                
                cursor.execute(
                    "INSERT INTO users (email, name, password_hash, budget, currency, country) VALUES (%s, %s, %s, %s, %s, %s)",
                    (email, name, password_hash, 600.0, currency, country)
                )
                
                # Give custom welcome bonus transaction
                tx_id = 'tx-' + uuid.uuid4().hex[:12]
                date_str = datetime.utcnow().strftime('%Y-%m-%d')
                cursor.execute(
                    "INSERT INTO transactions (id, user_email, `desc`, amount, category, type, date) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (tx_id, email, 'Welcome Bonus Allowance', 100.00, 'income', 'income', date_str)
                )
                
                # Fetch created user info
                cursor.execute("SELECT email, name, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                
            elif type_val == 'login':
                cursor.execute("SELECT email, name, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                
            elif type_val == 'reset':
                new_password = body.get('password', '')
                if not new_password:
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "Bad Request: New password is required.")
                    
                password_hash = hash_password(new_password)
                cursor.execute("UPDATE users SET password_hash = %s WHERE email = %s", (password_hash, email))
                cursor.close()
                conn.close()
                return self.respond_json(200, {"success": True, "message": "Password updated successfully."})
                
            # Create login session for signup and login
            token = uuid.uuid4().hex
            expiry = (datetime.utcnow() + timedelta(days=7)).isoformat()
            cursor.execute("INSERT INTO sessions (token, email, expires_at) VALUES (%s, %s, %s)", (token, email, expiry))
            
            cursor.close()
            conn.close()
            
            user_data = {
                "email": user['email'],
                "name": user['name'],
                "budget": user['budget'],
                "currency": user['currency'],
                "country": user['country'],
                "tutorial_seen": user['tutorial_seen']
            }
            return self.respond_json(200, {"success": True, "token": token, "user": user_data})

        # 3. API Route: User Signup
        elif self.path == '/api/auth/signup':
            name = body.get('name', '').strip()
            email = body.get('email', '').strip().lower()
            password = body.get('password', '')
            country = body.get('country', 'US').strip()
            
            if not name or not email or not password:
                return self.respond_error(400, "Bad Request: Email, Name, and Password are required.")
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Check if user exists
            cursor.execute("SELECT email FROM users WHERE email = %s", (email,))
            if cursor.fetchone():
                cursor.close()
                conn.close()
                return self.respond_error(400, "An account with this email already exists.")
            
            # Resolve default currency from country mapping
            COUNTRY_CURRENCY_MAP = {
                'US': 'USD', 'IN': 'INR', 'GB': 'GBP', 'DE': 'EUR',
                'FR': 'EUR', 'JP': 'JPY', 'CA': 'CAD', 'OTH': 'USD'
            }
            currency = COUNTRY_CURRENCY_MAP.get(country, 'USD')
            
            # Hash password
            password_hash = hash_password(password)
            
            # Save User
            cursor.execute(
                "INSERT INTO users (email, name, password_hash, budget, currency, country) VALUES (%s, %s, %s, %s, %s, %s)",
                (email, name, password_hash, 600.0, currency, country)
            )
            cursor.close()
            conn.close()
            
            return self.respond_json(201, {"success": True, "message": "Account created successfully."})

        # 2. API Route: User Login
        elif self.path == '/api/auth/login':
            email = body.get('email', '').strip().lower()
            password = body.get('password', '')
            
            if not email or not password:
                return self.respond_error(400, "Bad Request: Email and Password are required.")
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            cursor.execute("SELECT email, name, password_hash, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (email,))
            user = cursor.fetchone()
            
            if not user or not verify_password(user['password_hash'], password):
                cursor.close()
                conn.close()
                return self.respond_error(401, "Invalid email or password.")
                
            # Create session token
            token = uuid.uuid4().hex
            expiry = (datetime.utcnow() + timedelta(days=7)).isoformat()
            
            cursor.execute("INSERT INTO sessions (token, email, expires_at) VALUES (%s, %s, %s)", (token, email, expiry))
            cursor.close()
            conn.close()
            
            user_data = {
                "email": user['email'],
                "name": user['name'],
                "budget": user['budget'],
                "currency": user['currency'],
                "country": user['country'],
                "tutorial_seen": user['tutorial_seen']
            }
            
            return self.respond_json(200, {"success": True, "token": token, "user": user_data})

        # 3. API Route: Mock OAuth Login
        elif self.path == '/api/auth/oauth-login':
            email = body.get('email', '').strip().lower()
            name = body.get('name', '').strip()
            provider = body.get('provider', '').strip()
            
            if not email:
                return self.respond_error(400, "Bad Request: Email is required.")
            
            if not name:
                name = email.split('@')[0].replace('.', ' ').title()
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Check user
            cursor.execute("SELECT email, name, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (email,))
            user = cursor.fetchone()
            
            if not user:
                # Register on the fly
                currency = 'GBP' if provider == 'github' else 'USD'
                
                # Mock seed data for specific mock social profiles
                default_budget = 800.0 if 'aria.chen' in email else (650.0 if 'devon.lane' in email else 600.0)
                
                cursor.execute(
                    "INSERT INTO users (email, name, password_hash, budget, currency, country) VALUES (%s, %s, %s, %s, %s, %s)",
                    (email, name, 'oauth_bypass_hashed', default_budget, currency, 'US')
                )
                
                # If custom user (welcome bonus)
                if 'aria.chen' not in email and 'devon.lane' not in email:
                    tx_id = 'tx-' + uuid.uuid4().hex[:12]
                    date_str = datetime.utcnow().strftime('%Y-%m-%d')
                    cursor.execute(
                        "INSERT INTO transactions (id, user_email, `desc`, amount, category, type, date) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (tx_id, email, 'Welcome Bonus Allowance', 100.00, 'income', 'income', date_str)
                    )
                else:
                    # Seed transaction datasets for standard mock logins
                    seed_txs = []
                    if 'aria.chen' in email:
                        seed_txs = [
                            ('tx-g1', 'Google Cloud Platform Hosting', 15.00, 'rent', 'expense', '2026-06-05'),
                            ('tx-g2', 'Google Summer of Code Stipend', 1500.00, 'income', 'income', '2026-06-04'),
                            ('tx-g3', 'Google Drive Storage 100GB', 1.99, 'rent', 'expense', '2026-06-01'),
                            ('tx-g4', 'Campus Cafe Lunch', 12.50, 'food', 'expense', '2026-06-03'),
                            ('tx-g5', 'Leasing Chromebook Charger', 25.00, 'misc', 'expense', '2026-06-02')
                        ]
                    elif 'devon.lane' in email:
                        seed_txs = [
                            ('tx-h1', 'GitHub Copilot Subscription', 10.00, 'academics', 'expense', '2026-06-05'),
                            ('tx-h2', 'GitHub Sponsors Payout', 250.00, 'income', 'income', '2026-06-03'),
                            ('tx-h3', 'Octocat Plushie & Merchandise', 35.00, 'personal', 'expense', '2026-06-01'),
                            ('tx-h4', 'Textbook Digital Subscription', 45.00, 'academics', 'expense', '2026-06-02'),
                            ('tx-h5', 'Student Dev Meetup Snacks', 18.00, 'food', 'expense', '2026-06-04')
                        ]
                    for t_id, desc, amt, cat, typ, dt in seed_txs:
                         cursor.execute(
                            "INSERT INTO transactions (id, user_email, `desc`, amount, category, type, date) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                            (t_id, email, desc, amt, cat, typ, dt)
                        )
                
                cursor.execute("SELECT email, name, budget, currency, country, tutorial_seen FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                
            # Create session
            token = uuid.uuid4().hex
            expiry = (datetime.utcnow() + timedelta(days=7)).isoformat()
            cursor.execute("INSERT INTO sessions (token, email, expires_at) VALUES (%s, %s, %s)", (token, email, expiry))
            
            cursor.close()
            conn.close()
            
            user_data = {
                "email": user['email'],
                "name": user['name'],
                "budget": user['budget'],
                "currency": user['currency'],
                "country": user['country'],
                "tutorial_seen": user['tutorial_seen']
            }
            
            return self.respond_json(200, {"success": True, "token": token, "user": user_data})

        # 4. API Route: Add Transaction
        elif self.path == '/api/transactions':
            user = self.get_auth_user()
            if not user:
                return self.respond_error(401, "Unauthorized.")
                
            desc = body.get('desc', '').strip()
            amount = body.get('amount')
            category = body.get('category', '').strip()
            type_val = body.get('type', '').strip()
            date = body.get('date', '').strip()
            
            if not desc or amount is None or not category or not type_val or not date:
                return self.respond_error(400, "Bad Request: Missing transaction attributes.")
                
            try:
                amount_float = float(amount)
                if amount_float <= 0:
                    raise ValueError()
            except ValueError:
                return self.respond_error(400, "Bad Request: Invalid transaction amount.")
                
            tx_id = 'tx-' + uuid.uuid4().hex[:12]
            
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO transactions (id, user_email, `desc`, amount, category, type, date) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (tx_id, user['email'], desc, amount_float, category, type_val, date)
            )
            cursor.close()
            conn.close()
            
            new_tx = {
                "id": tx_id,
                "desc": desc,
                "amount": amount_float,
                "category": category,
                "type": type_val,
                "date": date
            }
            return self.respond_json(201, {"success": True, "transaction": new_tx})
            
        else:
            return self.respond_error(404, "API endpoint not found.")

    def do_PUT(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else ""
        
        try:
            body = json.loads(post_data) if post_data else {}
        except json.JSONDecodeError:
            return self.respond_error(400, "Bad Request: Invalid JSON.")
            
        user = self.get_auth_user()
        if not user:
            return self.respond_error(401, "Unauthorized.")

        # 1. API Route: Edit Profile settings
        if self.path == '/api/profile':
            budget = body.get('budget')
            currency = body.get('currency')
            currency = currency.strip() if currency else ''
            tutorial_seen = body.get('tutorial_seen')
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            if budget is not None:
                try:
                    budget_float = float(budget)
                    cursor.execute("UPDATE users SET budget = %s WHERE email = %s", (budget_float, user['email']))
                except ValueError:
                    cursor.close()
                    conn.close()
                    return self.respond_error(400, "Bad Request: Invalid budget.")
                    
            if currency:
                cursor.execute("UPDATE users SET currency = %s WHERE email = %s", (currency, user['email']))
                
            if tutorial_seen is not None:
                try:
                    ts_val = int(tutorial_seen)
                    cursor.execute("UPDATE users SET tutorial_seen = %s WHERE email = %s", (ts_val, user['email']))
                except ValueError:
                    pass
                
            cursor.close()
            conn.close()
            return self.respond_json(200, {"success": True})

        # 2. API Route: Edit Transaction
        elif self.path.startswith('/api/transactions/'):
            tx_id = self.path.split('/')[-1]
            
            desc = body.get('desc', '').strip()
            amount = body.get('amount')
            category = body.get('category', '').strip()
            type_val = body.get('type', '').strip()
            date = body.get('date', '').strip()
            
            if not desc or amount is None or not category or not type_val or not date:
                return self.respond_error(400, "Bad Request: Missing inputs.")
                
            try:
                amount_float = float(amount)
            except ValueError:
                return self.respond_error(400, "Bad Request: Invalid amount.")
                
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Verify owner
            cursor.execute("SELECT id FROM transactions WHERE id = %s AND user_email = %s", (tx_id, user['email']))
            if not cursor.fetchone():
                cursor.close()
                conn.close()
                return self.respond_error(404, "Transaction not found or access denied.")
                
            cursor.execute(
                "UPDATE transactions SET `desc` = %s, amount = %s, category = %s, type = %s, date = %s WHERE id = %s",
                (desc, amount_float, category, type_val, date, tx_id)
            )
            cursor.close()
            conn.close()
            
            return self.respond_json(200, {"success": True})
            
        else:
            return self.respond_error(404, "Endpoint not found.")

    def do_DELETE(self):
        user = self.get_auth_user()
        if not user:
            return self.respond_error(401, "Unauthorized.")

        # 1. API Route: Delete User Account
        if self.path == '/api/profile':
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("DELETE FROM users WHERE email = %s", (user['email'],))
            cursor.close()
            conn.close()
            return self.respond_json(200, {"success": True, "message": "Account deleted successfully."})

        # 2. API Route: Delete Transaction
        elif self.path.startswith('/api/transactions/'):
            tx_id = self.path.split('/')[-1]
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Verify ownership
            cursor.execute("SELECT id FROM transactions WHERE id = %s AND user_email = %s", (tx_id, user['email']))
            if not cursor.fetchone():
                cursor.close()
                conn.close()
                return self.respond_error(404, "Transaction not found or access denied.")
                
            cursor.execute("DELETE FROM transactions WHERE id = %s", (tx_id,))
            cursor.close()
            conn.close()
            
            return self.respond_json(200, {"success": True})
            
        else:
            return self.respond_error(404, "Endpoint not found.")

    def serve_static_file(self):
        path = self.path.split('?')[0]
        if path == '/':
            path = '/index.html'
            
        # Security check to prevent dir traversal
        safe_path = os.path.normpath(path).lstrip('\\/')
        base_dir = os.path.dirname(os.path.abspath(__file__))
        local_path = os.path.join(base_dir, 'public', safe_path)
        
        # Verify it's inside the public folder
        if not local_path.startswith(os.path.join(base_dir, 'public')):
            self.send_response(403)
            self.end_headers()
            return
            
        if not os.path.exists(local_path) or os.path.isdir(local_path):
            self.send_response(404)
            self.end_headers()
            return
            
        # Determine content type
        _, ext = os.path.splitext(local_path)
        content_types = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.json': 'application/json; charset=utf-8'
        }
        content_type = content_types.get(ext.lower(), 'application/octet-stream')
        
        self.send_response(200)
        self.send_header('Content-type', content_type)
        self.send_cors_headers()
        self.end_headers()
        
        # Write binary content
        with open(local_path, 'rb') as f:
            self.wfile.write(f.read())

# 5. Start the Application Server
if __name__ == '__main__':
    init_db()
    
    # Enable socket re-use to avoid port-binding lags
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), AppRequestHandler) as httpd:
        print(f"ApexBudget // Real backend MySQL database server online at http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nApexBudget // Shutting down backend server.")
