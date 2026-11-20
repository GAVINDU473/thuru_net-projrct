from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3
import hashlib
import joblib
import pandas as pd
import requests
from pymodbus.client import ModbusTcpClient

app = FastAPI(title="AgriVoice Real-Time Industrial PLC & AI Server")

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
    cur.execute("SELECT * FROM users WHERE username = 'gavindu'")
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO users (username, full_name, password_hash) VALUES (?, ?, ?)",
            ("gavindu", "Gavindu Samarakoon", hash_pw("admin123"))
        )
    conn.commit()
    conn.close()

init_db()

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

class ManualRelayRequest(BaseModel):
    fan_on: Optional[bool] = None
    pump_on: Optional[bool] = None
    shade_closed: Optional[bool] = None

def fetch_live_ambient_temp(country: str) -> float:
    lat, lon = COUNTRY_COORDS.get(country, (7.8731, 80.7718))
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
        res = requests.get(url, timeout=4).json()
        return float(res["current_weather"]["temperature"])
    except Exception:
        return 29.0

def poll_and_control_plc(gh_id: int):
    conn = get_db()
    gh = conn.execute("SELECT * FROM greenhouses WHERE id = ?", (gh_id,)).fetchone()
    if not gh:
        conn.close()
        raise HTTPException(status_code=404, detail="Greenhouse not found")
    rules = [dict(r) for r in conn.execute("SELECT * FROM rules WHERE greenhouse_id = ?", (gh_id,)).fetchall()]
    conn.close()

    plc_ip = gh["plc_ip"].strip()
    client = ModbusTcpClient(plc_ip, port=502, timeout=1.2)
    if not client.connect():
        return {
            "online": False,
            "plc_ip": plc_ip,
            "message": f"ESP32 Micro-PLC at {plc_ip}:502 is offline. Connect power & network to auto-detect wired sensors.",
            "detected_sensors": [],
            "detected_actuators": [],
            "actuators_state": {"fan_on": False, "pump_on": False, "shade_closed": False}
        }

    try:
        rr = client.read_input_registers(address=0, count=4)
        if rr.isError():
            raise Exception("Modbus Register Read Error")

        raw_temp, raw_light, raw_soil, hw_mask = rr.registers

        # Build Dynamic List of ONLY Physically Wired Sensors
        detected_sensors = []
        sensor_values = {}

        if (hw_mask & 1) and raw_temp != -999:
            val = round(raw_temp / 10.0, 1)
            sensor_values["Temperature"] = val
            detected_sensors.append({"key": "Temperature", "name": "DS18B20 Temp Probe", "pin": "X0 (GPIO 4)", "value": val, "unit": "°C"})

        if (hw_mask & 2) and raw_light >= 0:
            val = int(raw_light)
            sensor_values["Light"] = val
            detected_sensors.append({"key": "Light", "name": "LDR Light Sensor", "pin": "AI0 (GPIO 34)", "value": val, "unit": "Lux"})

        if (hw_mask & 4) and raw_soil >= 0:
            val = int(raw_soil)
            sensor_values["Soil Moisture"] = val
            detected_sensors.append({"key": "Soil Moisture", "name": "Soil Moisture Probe", "pin": "AI1 (GPIO 35)", "value": val, "unit": "%"})

        # Build Dynamic List of Auto-Detected Relays / Actuators
        detected_actuators = []
        if hw_mask & 8:
            detected_actuators.append({"key": "fan", "name": "Cooling Fan Relay", "coil": "Coil Y0 (GPIO 26)"})
        if hw_mask & 16:
            detected_actuators.append({"key": "pump", "name": "Water Pump / Mist Relay", "coil": "Coil Y1 (GPIO 33)"})
        if hw_mask & 32:
            detected_actuators.append({"key": "shade", "name": "Shade Net Servo", "coil": "HReg Y3 (GPIO 27)"})

        # Evaluate Rules against Auto-Detected Sensors
        for r in rules:
            s_val = sensor_values.get(r["sensor"])
            if s_val is not None:
                triggered = (s_val > r["threshold"]) if r["operator"] == ">" else (s_val < r["threshold"])
                if triggered:
                    if r["device"] == "Cooling fan":
                        client.write_coil(address=0, value=(r["action"] == "ON"))
                    elif r["device"] == "Water pump":
                        client.write_coil(address=1, value=(r["action"] == "ON"))
                    elif r["device"] == "Shade net":
                        client.write_register(address=0, value=90 if r["action"] == "CLOSE" else 0)

        coils = client.read_coils(address=0, count=2)
        hreg = client.read_holding_registers(address=0, count=1)
        fan_on = bool(coils.bits[0]) if not coils.isError() else False
        pump_on = bool(coils.bits[1]) if not coils.isError() else False
        shade_closed = (hreg.registers[0] > 45) if not hreg.isError() else False

        return {
            "online": True,
            "plc_ip": plc_ip,
            "message": f"Auto-detected {len(detected_sensors)} sensor(s) and {len(detected_actuators)} actuator channel(s).",
            "detected_sensors": detected_sensors,
            "detected_actuators": detected_actuators,
            "actuators_state": {
                "fan_on": fan_on,
                "pump_on": pump_on,
                "shade_closed": shade_closed
            }
        }
    finally:
        client.close()

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

@app.get("/api/greenhouses/{owner_username}")
def get_user_greenhouses(owner_username: str):
    conn = get_db()
    ghs = conn.execute("SELECT * FROM greenhouses WHERE owner_username = ?", (owner_username,)).fetchall()
    result = []
    for gh in ghs:
        gh_dict = dict(gh)
        gh_dict["rules"] = [dict(r) for r in conn.execute("SELECT * FROM rules WHERE greenhouse_id = ?", (gh["id"],)).fetchall()]
        result.append(gh_dict)
    conn.close()
    return result

@app.get("/api/hardware/live/{gh_id}")
def get_live_hardware(gh_id: int):
    return poll_and_control_plc(gh_id)

@app.post("/api/hardware/manual/{gh_id}")
def manual_relay_override(gh_id: int, req: ManualRelayRequest):
    conn = get_db()
    gh = conn.execute("SELECT * FROM greenhouses WHERE id = ?", (gh_id,)).fetchone()
    conn.close()
    if not gh:
        raise HTTPException(status_code=404, detail="Greenhouse not found")
    client = ModbusTcpClient(gh["plc_ip"].strip(), port=502, timeout=1.5)
    if not client.connect():
        raise HTTPException(status_code=503, detail=f"Cannot reach PLC at {gh['plc_ip']}")
    try:
        if req.fan_on is not None:
            client.write_coil(address=0, value=req.fan_on)
        if req.pump_on is not None:
            client.write_coil(address=1, value=req.pump_on)
        if req.shade_closed is not None:
            client.write_register(address=0, value=90 if req.shade_closed else 0)
        return poll_and_control_plc(gh_id)
    finally:
        client.close()

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