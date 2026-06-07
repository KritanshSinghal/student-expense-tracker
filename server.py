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

PORT = int(os.environ.get('PORT', 8000))

# 1. Load Environment Configuration
def load_env():
    env_vars = {
        'DB_HOST': 'localhost',
        'DB_PORT': '3306',
        'DB_USER': 'root',
        'DB_PASSWORD': '',
        'DB_NAME': 'apexbudget_db',
        'DB_SSL': 'false'
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
        # 1. API route: get transactions
        if self.path == '/api/transactions':
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

        elif self.path == '/api/auth/users':
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT email, name FROM users")
            rows = cursor.fetchall()
            cursor.close()
            conn.close()
            
            user_list = list(rows) if rows else []
            return self.respond_json(200, {"success": True, "users": user_list})

        # 2. Static files fallback
        self.serve_static_file()

    def do_POST(self):
        # Parse JSON body
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else ""
        
        try:
            body = json.loads(post_data) if post_data else {}
        except json.JSONDecodeError:
            return self.respond_error(400, "Bad Request: Invalid JSON payload.")

        # 1. API Route: User Signup
        if self.path == '/api/auth/signup':
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
