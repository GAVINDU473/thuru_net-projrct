from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3
import hashlib
import joblib
import pandas as pd
import requests
from datetime import datetime

app = FastAPI(title="AgriVoice Production SDN & AI Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "agrivoice_production.db"
model = joblib.load("agrivoice_ai_model.pkl")

COUNTRY_COORDS = {
    "Sri Lanka": (7.8731, 80.7718),
    "Japan": (36.2048, 138.2529),
    "Netherlands": (52.1326, 5.2913),
    "Iran": (32.4279, 53.6880),
    "Thailand": (15.8700, 100.9925),
}

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def hash_pw(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS greenhouses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_username TEXT NOT NULL,
            name TEXT NOT NULL,
            location TEXT NOT NULL,
            plc_ip TEXT NOT NULL,
            slave_id TEXT NOT NULL,
            crop TEXT NOT NULL,
            country TEXT NOT NULL,
            growth_day INTEGER NOT NULL,
            daily_summary TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            greenhouse_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            sensor TEXT NOT NULL,
            operator TEXT NOT NULL,
            threshold REAL NOT NULL,
            unit TEXT NOT NULL,
            device TEXT NOT NULL,
            action TEXT NOT NULL,
            qos TEXT NOT NULL
        )
    """)
    # Create default owner account if not exists
    cur.execute("SELECT * FROM users WHERE username = 'gavindu'")
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO users (username, full_name, password_hash) VALUES (?, ?, ?)",
            ("gavindu", "Gavindu Samarakoon", hash_pw("admin123"))
        )
    conn.commit()
    conn.close()

init_db()

# --- PYDANTIC SCHEMAS ---
class AuthRequest(BaseModel):
    username: str
    password: str
    full_name: Optional[str] = "Greenhouse Owner"

class GreenhouseCreate(BaseModel):
    owner_username: str
    name: str
    location: str
    plc_ip: str
    slave_id: str
    crop: str
    country: str
    growth_day: int

class RuleCreate(BaseModel):
    greenhouse_id: int
    source: str
    sensor: str
    operator: str
    threshold: float
    unit: str
    device: str
    action: str
    qos: str = "HIGH"

class CropSyncRequest(BaseModel):
    greenhouse_id: int
    crop: str
    country: str
    growth_day: int

def fetch_live_ambient_temp(country: str) -> float:
    lat, lon = COUNTRY_COORDS.get(country, (7.8731, 80.7718))
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
        res = requests.get(url, timeout=4).json()
        return float(res["current_weather"]["temperature"])
    except Exception:
        return 29.0

# --- AUTH ENDPOINTS ---
@app.post("/api/auth/register")
def register(req: AuthRequest):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, full_name, password_hash) VALUES (?, ?, ?)",
            (req.username.strip().lower(), req.full_name, hash_pw(req.password))
        )
        conn.commit()
        return {"status": "ok", "username": req.username.strip().lower(), "full_name": req.full_name}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.post("/api/auth/login")
def login(req: AuthRequest):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ? AND password_hash = ?",
        (req.username.strip().lower(), hash_pw(req.password))
    ).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {"status": "ok", "username": user["username"], "full_name": user["full_name"]}

# --- GREENHOUSE & AI ENDPOINTS ---
@app.get("/api/greenhouses/{owner_username}")
def get_user_greenhouses(owner_username: str):
    conn = get_db()
    ghs = conn.execute("SELECT * FROM greenhouses WHERE owner_username = ?", (owner_username,)).fetchall()
    result = []
    for gh in ghs:
        gh_dict = dict(gh)
        rules = conn.execute("SELECT * FROM rules WHERE greenhouse_id = ?", (gh["id"],)).fetchall()
        gh_dict["rules"] = [dict(r) for r in rules]
        result.append(gh_dict)
    conn.close()
    return result

@app.post("/api/greenhouses")
def create_greenhouse(req: GreenhouseCreate):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO greenhouses (owner_username, name, location, plc_ip, slave_id, crop, country, growth_day, daily_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (req.owner_username, req.name, req.location, req.plc_ip, req.slave_id, req.crop, req.country, req.growth_day, "Initializing AI profile...")
    )
    gh_id = cur.lastrowid
    conn.commit()
    conn.close()
    return sync_ai_profile(CropSyncRequest(greenhouse_id=gh_id, crop=req.crop, country=req.country, growth_day=req.growth_day))

@app.delete("/api/greenhouses/{gh_id}")
def delete_greenhouse(gh_id: int):
    conn = get_db()
    conn.execute("DELETE FROM rules WHERE greenhouse_id = ?", (gh_id,))
    conn.execute("DELETE FROM greenhouses WHERE id = ?", (gh_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted"}

@app.post("/api/ai/predict-profile")
def sync_ai_profile(req: CropSyncRequest):
    ambient_temp = fetch_live_ambient_temp(req.country)
    input_df = pd.DataFrame([{
        "Crop": req.crop,
        "Country": req.country,
        "Growth_Day": req.growth_day,
        "Ambient_Temp": ambient_temp
    }])
    opt_temp, opt_light, fan_trigger, shade_trigger = model.predict(input_df)[0]

    stage = "Seedling Phase" if req.growth_day <= 20 else ("Vegetative Phase" if req.growth_day <= 60 else "Flowering / Harvest Phase")
    summary = f"Synced {req.country} live weather ({ambient_temp}°C). {req.crop} ({stage}): Fan > {round(float(fan_trigger), 1)}°C, Shade > {int(shade_trigger)} Lux."

    conn = get_db()
    conn.execute(
        "UPDATE greenhouses SET crop = ?, country = ?, growth_day = ?, daily_summary = ? WHERE id = ?",
        (req.crop, req.country, req.growth_day, summary, req.greenhouse_id)
    )
    # Replace old AI Auto-Rules while keeping user custom rules
    conn.execute("DELETE FROM rules WHERE greenhouse_id = ? AND source = 'AI Auto-Rule'", (req.greenhouse_id,))
    conn.execute(
        "INSERT INTO rules (greenhouse_id, source, sensor, operator, threshold, unit, device, action, qos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (req.greenhouse_id, "AI Auto-Rule", "Temperature", ">", round(float(fan_trigger), 1), "°C", "Cooling fan", "ON", "HIGH")
    )
    conn.execute(
        "INSERT INTO rules (greenhouse_id, source, sensor, operator, threshold, unit, device, action, qos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (req.greenhouse_id, "AI Auto-Rule", "Light", ">", int(shade_trigger), "Lux", "Shade net", "CLOSE", "NORMAL")
    )
    conn.commit()

    gh = dict(conn.execute("SELECT * FROM greenhouses WHERE id = ?", (req.greenhouse_id,)).fetchone())
    gh["rules"] = [dict(r) for r in conn.execute("SELECT * FROM rules WHERE greenhouse_id = ?", (req.greenhouse_id,)).fetchall()]
    conn.close()
    return gh

@app.post("/api/rules")
def add_rule(req: RuleCreate):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO rules (greenhouse_id, source, sensor, operator, threshold, unit, device, action, qos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (req.greenhouse_id, req.source, req.sensor, req.operator, req.threshold, req.unit, req.device, req.action, req.qos)
    )
    rule_id = cur.lastrowid
    conn.commit()
    rule = dict(conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone())
    conn.close()
    return rule

@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    conn = get_db()
    conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted"}