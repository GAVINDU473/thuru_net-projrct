import React, { useState, useEffect } from 'react';
import {
  Mic, MicOff, Send, Plus, Cpu, Wifi, WifiOff, Thermometer, Sun,
  Activity, RefreshCw, CheckCircle2, Layers, Sprout, Terminal,
  Server, Trash2, Lock, User, LogOut, ShieldCheck, Power, AlertCircle
} from 'lucide-react';

const API_BASE = 'http://127.0.0.1:8000';

export default function App() {
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('agrivoice_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '', full_name: '' });
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [greenhouses, setGreenhouses] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loadingFleet, setLoadingFleet] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  // Real Hardware Auto-Detection & Live Modbus State
  const [hwStatus, setHwStatus] = useState({
    online: false,
    message: 'Scanning Modbus TCP network...',
    detected_equipment: {
      temp_sensor: false,
      light_sensor: false,
      cooling_fan_relay: false,
      shade_net_servo: false
    },
    telemetry: {
      temp: null,
      light: null,
      fan_on: false,
      shade_closed: false
    }
  });

  // Add Greenhouse Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newGh, setNewGh] = useState({
    name: '',
    location: '',
    plc_ip: '192.168.1.101',
    slave_id: '0x01',
    crop: 'Vanilla',
    country: 'Sri Lanka',
    growth_day: 1
  });

  // Tri-Modal Rule Builder
  const [commandInput, setCommandInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [blockSensor, setBlockSensor] = useState('Temperature');
  const [blockOperator, setBlockOperator] = useState('>');
  const [blockThreshold, setBlockThreshold] = useState(28);
  const [blockDevice, setBlockDevice] = useState('Cooling fan');
  const [blockAction, setBlockAction] = useState('ON');

  const [packetsSent, setPacketsSent] = useState(0);
  const [packetLogs, setPacketLogs] = useState([]);

  const addLog = (msg) => {
    const ts = new Date().toTimeString().split(' ')[0];
    setPacketLogs(prev => [`[${ts}] ${msg}`, ...prev.slice(0, 11)]);
    setPacketsSent(p => p + 1);
  };

  const loadUserGreenhouses = async (username) => {
    setLoadingFleet(true);
    try {
      const res = await fetch(`${API_BASE}/api/greenhouses/${username}`);
      const data = await res.json();
      setGreenhouses(data);
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id);
      }
    } finally {
      setLoadingFleet(false);
    }
  };

  useEffect(() => {
    if (currentUser) loadUserGreenhouses(currentUser.username);
  }, [currentUser]);

  const activeGh = greenhouses.find(g => g.id === selectedId) || greenhouses[0] || null;

  // Poll REAL Hardware ESP32 PLC every 2.5 seconds (Zero Simulation!)
  const pollRealHardware = async (ghId) => {
    if (!ghId) return;
    try {
      const res = await fetch(`${API_BASE}/api/hardware/live/${ghId}`);
      const data = await res.json();
      setHwStatus(data);
      if (data.online) {
        addLog(`MODBUS POLL -> ${data.plc_ip} | Temp:${data.telemetry.temp ?? 'N/A'}°C | Lux:${data.telemetry.light ?? 'N/A'} | Fan:${data.telemetry.fan_on ? 'ON' : 'OFF'}`);
      }
    } catch {
      setHwStatus(prev => ({ ...prev, online: false, message: 'FastAPI Server unreachable' }));
    }
  };

  useEffect(() => {
    if (!activeGh) return;
    pollRealHardware(activeGh.id);
    const interval = setInterval(() => pollRealHardware(activeGh.id), 2500);
    return () => clearInterval(interval);
  }, [activeGh?.id]);

  // Manual Relay Toggle on Physical ESP32
  const togglePhysicalRelay = async (device, nextVal) => {
    if (!activeGh || !hwStatus.online) return;
    const payload = device === 'fan' ? { fan_on: nextVal } : { shade_closed: nextVal };
    const res = await fetch(`${API_BASE}/api/hardware/manual/${activeGh.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const updated = await res.json();
      setHwStatus(updated);
      addLog(`MANUAL OVERRIDE -> ${activeGh.plc_ip} | ${device.toUpperCase()} set to ${nextVal ? 'ON/CLOSED' : 'OFF/OPEN'}`);
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Authentication failed');
      localStorage.setItem('agrivoice_user', JSON.stringify(data));
      setCurrentUser(data);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('agrivoice_user');
    setCurrentUser(null);
    setGreenhouses([]);
    setSelectedId(null);
  };

  const handleCreateGreenhouse = async (e) => {
    e.preventDefault();
    setAiLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/greenhouses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newGh,
          owner_username: currentUser.username,
          growth_day: Number(newGh.growth_day)
        })
      });
      const createdGh = await res.json();
      setGreenhouses(prev => [...prev, createdGh]);
      setSelectedId(createdGh.id);
      setShowAddModal(false);
      addLog(`PROVISIONED -> ${createdGh.name} (${createdGh.plc_ip})`);
    } finally {
      setAiLoading(false);
    }
  };

  const handleDeleteGreenhouse = async (id, e) => {
    e.stopPropagation();
    await fetch(`${API_BASE}/api/greenhouses/${id}`, { method: 'DELETE' });
    const updated = greenhouses.filter(g => g.id !== id);
    setGreenhouses(updated);
    if (selectedId === id) setSelectedId(updated[0]?.id || null);
  };

  const runAutonomousAI = async (customCrop, customCountry, customDay) => {
    if (!activeGh) return;
    setAiLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/ai/predict-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          greenhouse_id: activeGh.id,
          crop: customCrop ?? activeGh.crop,
          country: customCountry ?? activeGh.country,
          growth_day: Number(customDay ?? activeGh.growth_day)
        })
      });
      const updatedGh = await res.json();
      setGreenhouses(prev => prev.map(g => (g.id === updatedGh.id ? updatedGh : g)));
      addLog(`AI-SYNC -> Updated ${updatedGh.crop} rules in SQLite DB`);
    } finally {
      setAiLoading(false);
    }
  };

  const saveRuleToDb = async (ruleObj) => {
    if (!activeGh) return;
    const res = await fetch(`${API_BASE}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greenhouse_id: activeGh.id, ...ruleObj })
    });
    const savedRule = await res.json();
    setGreenhouses(prev =>
      prev.map(g => (g.id === activeGh.id ? { ...g, rules: [...g.rules, savedRule] } : g))
    );
    addLog(`RULE-DEPLOYED -> ${savedRule.device} ${savedRule.action} when ${savedRule.sensor} ${savedRule.operator} ${savedRule.threshold}${savedRule.unit}`);
  };

  const handleNaturalCommand = (text) => {
    const cmd = text.trim();
    if (!cmd || !activeGh) return;
    const lower = cmd.toLowerCase();
    const numMatch = lower.match(/(\d+(\.\d+)?)/);
    const numVal = numMatch ? parseFloat(numMatch[1]) : 29.0;
    const isLight = lower.includes('light') || lower.includes('eliya') || lower.includes('sun');
    const isShade = lower.includes('net') || lower.includes('shade') || lower.includes('dala');

    saveRuleToDb({
      source: 'Voice/Text Rule',
      sensor: isLight ? 'Light' : 'Temperature',
      operator: lower.includes('adu') || lower.includes('low') || lower.includes('<') ? '<' : '>',
      threshold: isLight ? (numVal > 100 ? numVal : 35000) : numVal,
      unit: isLight ? 'Lux' : '°C',
      device: isShade ? 'Shade net' : 'Cooling fan',
      action: lower.includes('off') || lower.includes('wahanna') || lower.includes('close')
        ? (isShade ? 'CLOSE' : 'OFF')
        : (isShade ? 'OPEN' : 'ON'),
      qos: 'HIGH'
    });
    setCommandInput('');
  };

  const startVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    setIsListening(true);
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setCommandInput(transcript);
      handleNaturalCommand(transcript);
      setIsListening(false);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  const handleDeleteRule = async (ruleId) => {
    await fetch(`${API_BASE}/api/rules/${ruleId}`, { method: 'DELETE' });
    setGreenhouses(prev =>
      prev.map(g => (g.id === activeGh.id ? { ...g, rules: g.rules.filter(r => r.id !== ruleId) } : g))
    );
  };

  // LOGIN / REGISTER SCREEN
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider mb-2">
            <ShieldCheck className="w-4 h-4" /> Real-World Industrial PLC & SDN Control
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            AgriVoice Production Login
          </h1>
          <div className="flex bg-slate-950 p-1 rounded-xl mt-6 border border-slate-800">
            <button type="button" onClick={() => setAuthMode('login')} className={`flex-1 py-2 text-xs font-bold rounded-lg ${authMode === 'login' ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}>
              Owner Login
            </button>
            <button type="button" onClick={() => setAuthMode('register')} className={`flex-1 py-2 text-xs font-bold rounded-lg ${authMode === 'register' ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}>
              Create Account
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="mt-5 space-y-4">
            {authMode === 'register' && (
              <div>
                <label className="text-xs text-slate-400 block mb-1">Full Name</label>
                <input type="text" required value={authForm.full_name} onChange={(e) => setAuthForm({ ...authForm, full_name: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm" />
              </div>
            )}
            <div>
              <label className="text-xs text-slate-400 block mb-1">Username</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input type="text" required value={authForm.username} onChange={(e) => setAuthForm({ ...authForm, username: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3.5 py-2.5 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Password</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input type="password" required value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-3.5 py-2.5 text-sm" />
              </div>
            </div>
            {authError && <div className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800/50 rounded-xl p-3">{authError}</div>}
            <button type="submit" disabled={authLoading} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl">
              {authLoading ? 'Signing in...' : authMode === 'login' ? 'Sign In' : 'Register & Enter'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 md:p-6">
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2.5 py-1 text-xs font-bold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full">
              Real Hardware Mode • Zero Simulation
            </span>
            <span className="text-xs text-slate-400">Operator: <strong className="text-slate-200">{currentUser.full_name}</strong></span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold mt-2 bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
            AgriVoice: Smart Greenhouse Network
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4 py-2.5 rounded-xl">
            <Plus className="w-4 h-4" /> Add New Greenhouse
          </button>
          <button onClick={handleLogout} className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 px-3.5 py-2.5 rounded-xl text-xs font-semibold">
            <LogOut className="w-4 h-4 text-rose-400" /> Logout
          </button>
        </div>
      </header>

      {!loadingFleet && greenhouses.length === 0 ? (
        <div className="max-w-xl mx-auto mt-16 bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center">
          <Sprout className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
          <h2 className="text-xl font-bold">No Physical Greenhouses Registered</h2>
          <p className="text-sm text-slate-400 mt-2">Add your greenhouse and enter your ESP32 Micro-PLC IP address to auto-detect wired sensors and relays.</p>
          <button onClick={() => setShowAddModal(true)} className="mt-6 inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-3 rounded-xl">
            <Plus className="w-5 h-5" /> Add Your First Greenhouse
          </button>
        </div>
      ) : (
        <>
          {/* FLEET NODES */}
          <section className="max-w-7xl mx-auto mt-6">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" /> Registered Greenhouse Nodes ({greenhouses.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {greenhouses.map(gh => {
                const isSelected = activeGh && gh.id === activeGh.id;
                return (
                  <div
                    key={gh.id}
                    onClick={() => setSelectedId(gh.id)}
                    className={`cursor-pointer rounded-2xl p-4 border transition-all relative group ${
                      isSelected ? 'bg-slate-900 border-emerald-500 ring-1 ring-emerald-500/40' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between pr-6">
                      <div>
                        <h3 className="font-bold text-slate-100">{gh.name}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{gh.location} • PLC: {gh.plc_ip}</p>
                      </div>
                      <span className="text-[11px] px-2 py-0.5 rounded font-mono bg-slate-800 text-cyan-300">
                        ID:{gh.slave_id}
                      </span>
                    </div>
                    <button onClick={(e) => handleDeleteGreenhouse(gh.id, e)} className="absolute top-3.5 right-3 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <div className="mt-3 flex items-center gap-2 text-xs">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-teal-300">🌱 {gh.crop}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-cyan-300">🌍 {gh.country}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Day {gh.growth_day}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {activeGh && (
            <main className="max-w-7xl mx-auto mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* LEFT 7 COLS: AI & RULES */}
              <div className="lg:col-span-7 space-y-6">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-5 h-5 text-cyan-400" />
                      <h2 className="font-bold text-lg">Autonomous Agronomic AI Engine</h2>
                    </div>
                    <button onClick={() => runAutonomousAI()} disabled={aiLoading} className="flex items-center gap-1.5 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 rounded-lg">
                      <RefreshCw className={`w-3.5 h-3.5 ${aiLoading ? 'animate-spin' : ''}`} />
                      {aiLoading ? 'Syncing...' : 'Sync AI & Weather'}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Plant Culture</label>
                      <input type="text" value={activeGh.crop} onChange={(e) => setGreenhouses(prev => prev.map(g => g.id === activeGh.id ? { ...g, crop: e.target.value } : g))} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Country / Climate</label>
                      <select value={activeGh.country} onChange={(e) => runAutonomousAI(activeGh.crop, e.target.value, activeGh.growth_day)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm">
                        <option value="Sri Lanka">Sri Lanka</option>
                        <option value="Japan">Japan</option>
                        <option value="Netherlands">Netherlands</option>
                        <option value="Iran">Iran</option>
                        <option value="Thailand">Thailand</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Growth Day ({activeGh.growth_day})</label>
                      <input type="range" min="1" max="150" value={activeGh.growth_day} onChange={(e) => setGreenhouses(prev => prev.map(g => g.id === activeGh.id ? { ...g, growth_day: Number(e.target.value) } : g))} onMouseUp={() => runAutonomousAI()} className="w-full accent-emerald-500 mt-2" />
                    </div>
                  </div>

                  <div className="mt-4 p-3 rounded-xl bg-cyan-950/30 border border-cyan-800/40 flex items-start gap-3 text-xs">
                    <CheckCircle2 className="w-5 h-5 text-cyan-400 shrink-0" />
                    <div><strong className="text-cyan-300">AI PROFILE: </strong>{activeGh.daily_summary}</div>
                  </div>
                </div>

                {/* TRI-MODAL RULES */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <h2 className="font-bold text-lg mb-1">Automation Rules (Auto-Executes Physical Relays)</h2>
                  <p className="text-xs text-slate-400 mb-4">Evaluated continuously against live sensor values read from {activeGh.plc_ip}.</p>

                  <div className="flex gap-2">
                    <button onClick={startVoiceInput} className={`p-3 rounded-xl border ${isListening ? 'bg-rose-600 border-rose-400 animate-pulse' : 'bg-slate-800 border-slate-700'}`}>
                      {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5 text-emerald-400" />}
                    </button>
                    <input type="text" value={commandInput} onChange={(e) => setCommandInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleNaturalCommand(commandInput)} placeholder='e.g., "Rasne 29 wadi nam fan eka danna"' className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 text-sm" />
                    <button onClick={() => handleNaturalCommand(commandInput)} className="bg-emerald-600 hover:bg-emerald-500 px-4 rounded-xl font-semibold text-sm flex items-center gap-1.5">
                      <Send className="w-4 h-4" /> Save
                    </button>
                  </div>

                  <div className="mt-4 pt-4 border-t border-slate-800 flex flex-wrap items-center gap-2 bg-slate-950 p-3 rounded-xl">
                    <span className="text-xs font-bold text-emerald-400">WHEN</span>
                    <select value={blockSensor} onChange={(e) => setBlockSensor(e.target.value)} className="bg-slate-800 text-xs rounded-lg px-2.5 py-1.5">
                      <option value="Temperature">Temperature</option>
                      <option value="Light">Light</option>
                    </select>
                    <select value={blockOperator} onChange={(e) => setBlockOperator(e.target.value)} className="bg-slate-800 text-xs rounded-lg px-2.5 py-1.5">
                      <option value=">">&gt;</option>
                      <option value="<">&lt;</option>
                    </select>
                    <input type="number" value={blockThreshold} onChange={(e) => setBlockThreshold(e.target.value)} className="w-20 bg-slate-800 text-xs rounded-lg px-2.5 py-1.5" />
                    <span className="text-xs font-bold text-cyan-400">THEN</span>
                    <select value={blockDevice} onChange={(e) => setBlockDevice(e.target.value)} className="bg-slate-800 text-xs rounded-lg px-2.5 py-1.5">
                      <option value="Cooling fan">Cooling fan</option>
                      <option value="Shade net">Shade net</option>
                    </select>
                    <select value={blockAction} onChange={(e) => setBlockAction(e.target.value)} className="bg-slate-800 text-xs rounded-lg px-2.5 py-1.5">
                      <option value="ON">ON</option>
                      <option value="OFF">OFF</option>
                      <option value="CLOSE">CLOSE</option>
                      <option value="OPEN">OPEN</option>
                    </select>
                    <button onClick={() => saveRuleToDb({ source: 'Block Rule', sensor: blockSensor, operator: blockOperator, threshold: Number(blockThreshold), unit: blockSensor === 'Temperature' ? '°C' : 'Lux', device: blockDevice, action: blockAction, qos: 'HIGH' })} className="ml-auto bg-teal-600 hover:bg-teal-500 text-xs font-bold px-3 py-1.5 rounded-lg">
                      + Add Rule
                    </button>
                  </div>

                  <div className="mt-4 space-y-2">
                    {(activeGh.rules || []).map(rule => (
                      <div key={rule.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 px-3.5 py-2.5 rounded-xl text-xs">
                        <div>
                          <span className="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-semibold mr-2">{rule.source}</span>
                          When <strong>{rule.sensor}</strong> {rule.operator} <strong>{rule.threshold}{rule.unit}</strong> → <strong>{rule.device} {rule.action}</strong>
                        </div>
                        <button onClick={() => handleDeleteRule(rule.id)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT 5 COLS: REAL AUTO-DETECTED HARDWARE & LIVE RELAY CONTROL */}
              <div className="lg:col-span-5 space-y-6">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-bold text-lg flex items-center gap-2">
                      <Server className="w-5 h-5 text-emerald-400" /> Auto-Detected PLC Hardware
                    </h2>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 ${
                      hwStatus.online ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/15 text-rose-400 border border-rose-500/40'
                    }`}>
                      {hwStatus.online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                      {hwStatus.online ? 'PLC ONLINE' : 'PLC OFFLINE'}
                    </span>
                  </div>

                  {!hwStatus.online && (
                    <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-800/50 text-xs text-rose-300 flex items-start gap-2 mb-4">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{hwStatus.message}</span>
                    </div>
                  )}

                  {/* LIVE SENSOR READINGS (ONLY SHOWN WHEN PHYSICALLY WIRED) */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span className="flex items-center gap-1"><Thermometer className="w-3.5 h-3.5 text-amber-400" /> Temp Probe (X0)</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${hwStatus.detected_equipment?.temp_sensor ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                          {hwStatus.detected_equipment?.temp_sensor ? 'DETECTED' : 'NOT WIRED'}
                        </span>
                      </div>
                      <div className="text-2xl font-bold text-amber-400 mt-2">
                        {hwStatus.telemetry?.temp !== null ? `${hwStatus.telemetry.temp}°C` : '--.- °C'}
                      </div>
                    </div>

                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span className="flex items-center gap-1"><Sun className="w-3.5 h-3.5 text-yellow-400" /> Light Sensor (AI0)</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${hwStatus.detected_equipment?.light_sensor ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                          {hwStatus.detected_equipment?.light_sensor ? 'DETECTED' : 'NOT WIRED'}
                        </span>
                      </div>
                      <div className="text-2xl font-bold text-yellow-300 mt-2">
                        {hwStatus.telemetry?.light !== null ? `${hwStatus.telemetry.light} lx` : '---- lx'}
                      </div>
                    </div>
                  </div>

                  {/* AUTO-DETECTED RELAYS & DIRECT SWITCHING */}
                  <div className="space-y-2.5">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Connected Relay & Actuator Channels</div>
                    
                    <div className="flex items-center justify-between bg-slate-950 border border-slate-800 p-3 rounded-xl">
                      <div>
                        <div className="text-sm font-bold flex items-center gap-2">
                          Cooling Fan Relay (Coil Y0)
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${hwStatus.detected_equipment?.cooling_fan_relay ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                            {hwStatus.detected_equipment?.cooling_fan_relay ? 'AUTO-DETECTED' : 'OFFLINE'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">State: {hwStatus.telemetry?.fan_on ? 'ENERGIZED (ON)' : 'IDLE (OFF)'}</div>
                      </div>
                      <button
                        disabled={!hwStatus.online}
                        onClick={() => togglePhysicalRelay('fan', !hwStatus.telemetry?.fan_on)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-40 ${
                          hwStatus.telemetry?.fan_on ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        <Power className="w-3.5 h-3.5" /> {hwStatus.telemetry?.fan_on ? 'Turn OFF' : 'Turn ON'}
                      </button>
                    </div>

                    <div className="flex items-center justify-between bg-slate-950 border border-slate-800 p-3 rounded-xl">
                      <div>
                        <div className="text-sm font-bold flex items-center gap-2">
                          Shade Net Servo (HReg Y1)
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${hwStatus.detected_equipment?.shade_net_servo ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                            {hwStatus.detected_equipment?.shade_net_servo ? 'AUTO-DETECTED' : 'OFFLINE'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">Position: {hwStatus.telemetry?.shade_closed ? 'CLOSED (90°)' : 'OPEN (0°)'}</div>
                      </div>
                      <button
                        disabled={!hwStatus.online}
                        onClick={() => togglePhysicalRelay('shade', !hwStatus.telemetry?.shade_closed)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-40 ${
                          hwStatus.telemetry?.shade_closed ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        <Power className="w-3.5 h-3.5" /> {hwStatus.telemetry?.shade_closed ? 'Open Net' : 'Close Net'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* LIVE MODBUS TCP PACKET LOG */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="font-bold text-sm flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-emerald-400" /> Live Modbus TCP Hardware Bus
                    </h2>
                    <span className="text-xs text-slate-400">Polls: {packetsSent}</span>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-slate-300 space-y-1.5 h-44 overflow-y-auto">
                    {packetLogs.length === 0 ? (
                      <div className="text-slate-500">Waiting for Modbus TCP responses from {activeGh.plc_ip}...</div>
                    ) : (
                      packetLogs.map((log, i) => <div key={i} className="border-b border-slate-900 pb-1">{log}</div>)
                    )}
                  </div>
                </div>
              </div>
            </main>
          )}
        </>
      )}

      {/* ADD GREENHOUSE MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form onSubmit={handleCreateGreenhouse} className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md space-y-3.5">
            <h3 className="text-lg font-bold">Register Physical Greenhouse PLC</h3>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Greenhouse Name</label>
              <input type="text" required placeholder="e.g., Anuradhapura Poly-Tunnel 01" value={newGh.name} onChange={(e) => setNewGh({ ...newGh, name: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Location</label>
              <input type="text" required placeholder="e.g., Anuradhapura" value={newGh.location} onChange={(e) => setNewGh({ ...newGh, location: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">ESP32 Static IP Address</label>
                <input type="text" required value={newGh.plc_ip} onChange={(e) => setNewGh({ ...newGh, plc_ip: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Modbus Slave ID</label>
                <input type="text" required value={newGh.slave_id} onChange={(e) => setNewGh({ ...newGh, slave_id: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Crop</label>
                <input type="text" required value={newGh.crop} onChange={(e) => setNewGh({ ...newGh, crop: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Country</label>
                <select value={newGh.country} onChange={(e) => setNewGh({ ...newGh, country: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-sm">
                  <option value="Sri Lanka">Sri Lanka</option>
                  <option value="Japan">Japan</option>
                  <option value="Netherlands">Netherlands</option>
                  <option value="Iran">Iran</option>
                  <option value="Thailand">Thailand</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Day</label>
                <input type="number" min="1" max="180" value={newGh.growth_day} onChange={(e) => setNewGh({ ...newGh, growth_day: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 text-xs text-slate-400">Cancel</button>
              <button type="submit" disabled={aiLoading} className="px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 rounded-xl">
                {aiLoading ? 'Saving...' : 'Register & Connect PLC'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}