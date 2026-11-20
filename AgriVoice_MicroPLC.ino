#include <WiFi.h>
#include <ModbusIP_ESP8266.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>

// --- 1. WIFI / SDN NETWORK CONFIG ---
const char* PRIMARY_SSID = "YOUR_WIFI_NAME";
const char* PRIMARY_PASS = "YOUR_WIFI_PASSWORD";
const char* BACKUP_SSID  = "YOUR_HOTSPOT_NAME";
const char* BACKUP_PASS  = "YOUR_HOTSPOT_PASS";

// --- 2. PLC HARDWARE PINS ---
#define ONE_WIRE_BUS 4      // DS18B20 Temp Sensor
#define LDR_PIN 34          // Light Sensor (Analog)
#define FAN_RELAY_PIN 26    // Relay Channel 1 (Cooling Fan)
#define SERVO_PIN 27        // Servo Motor (Shade Net)
#define ALARM_PIN 25        // High-Temp Buzzer/LED

// --- 3. MODBUS TCP REGISTERS ---
const int COIL_FAN = 0;           // 00001: Fan Relay Command
const int HREG_SHADE = 0;         // 40001: Shade Net Angle (0=Open, 90=Closed)
const int IREG_TEMP = 0;          // 30001: Live Temp x10
const int IREG_LIGHT = 1;         // 30002: Live Light (Lux)
const int IREG_HW_MASK = 2;       // 30003: Auto-Detected Hardware Bitmask!
                                  // Bit 0 (1): DS18B20 Detected
                                  // Bit 1 (2): LDR Sensor Detected
                                  // Bit 2 (4): Relay Output Ready
                                  // Bit 3 (8): Servo Output Ready

ModbusIP mb;
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Servo shadeServo;

unsigned long lastScan = 0;
bool fanState = false;
int shadeAngle = 0;
uint16_t detectedMask = 0;

void connectNetwork() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(PRIMARY_SSID, PRIMARY_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 4000) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect();
    WiFi.begin(BACKUP_SSID, BACKUP_PASS);
    t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 4000) delay(200);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(FAN_RELAY_PIN, OUTPUT);
  pinMode(ALARM_PIN, OUTPUT);
  digitalWrite(FAN_RELAY_PIN, LOW);

  shadeServo.attach(SERVO_PIN);
  shadeServo.write(0);
  sensors.begin();

  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 10);
  display.println("Scanning PLC I/O...");
  display.display();

  connectNetwork();

  mb.server(502);
  mb.addCoil(COIL_FAN);
  mb.addHreg(HREG_SHADE, 0);
  mb.addIreg(IREG_TEMP, 0);
  mb.addIreg(IREG_LIGHT, 0);
  mb.addIreg(IREG_HW_MASK, 0);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectNetwork();
  mb.task();

  // Execute Real Relay & Servo Commands from Dashboard/AI
  bool reqFan = mb.Coil(COIL_FAN);
  if (reqFan != fanState) {
    fanState = reqFan;
    digitalWrite(FAN_RELAY_PIN, fanState ? HIGH : LOW);
  }

  int reqShade = constrain(mb.Hreg(HREG_SHADE), 0, 90);
  if (reqShade != shadeAngle) {
    shadeAngle = reqShade;
    shadeServo.write(shadeAngle);
  }

  // Auto-Detect Connected Sensors & Read Real Values every 1.5s
  if (millis() - lastScan > 1500) {
    lastScan = millis();
    detectedMask = 0;

    // 1. Auto-Detect DS18B20 Temperature Probe
    sensors.requestTemperatures();
    float tempC = sensors.getTempCByIndex(0);
    if (tempC != DEVICE_DISCONNECTED_C && tempC > -50 && tempC < 120) {
      detectedMask |= (1 << 0); // Bit 0 = Temp Sensor Wired
      mb.Ireg(IREG_TEMP, (int)(tempC * 10));
    } else {
      mb.Ireg(IREG_TEMP, -999); // Not connected
    }

    // 2. Auto-Detect LDR Light Sensor (Valid analog signal range)
    int rawLight = analogRead(LDR_PIN);
    if (rawLight > 15 && rawLight < 4080) {
      detectedMask |= (1 << 1); // Bit 1 = Light Sensor Wired
      int lux = map(rawLight, 0, 4095, 0, 60000);
      mb.Ireg(IREG_LIGHT, lux);
    } else {
      mb.Ireg(IREG_LIGHT, -1); // Floating / Not wired
    }

    // 3. Actuators (Relay & Servo Ready)
    detectedMask |= (1 << 2); // Relay Channel Y0 Ready
    detectedMask |= (1 << 3); // Servo Channel Y1 Ready
    mb.Ireg(IREG_HW_MASK, detectedMask);

    // Update OLED Display
    display.clearDisplay();
    display.setCursor(0, 0);
    display.print("IP: "); display.println(WiFi.localIP());
    display.setCursor(0, 14);
    display.print("TEMP: ");
    if (detectedMask & 1) { display.print(tempC, 1); display.println(" C [OK]"); }
    else { display.println("NOT WIRED"); }

    display.setCursor(0, 28);
    display.print("LIGHT: ");
    if (detectedMask & 2) { display.print(mb.Ireg(IREG_LIGHT)); display.println(" lx"); }
    else { display.println("NOT WIRED"); }

    display.setCursor(0, 46);
    display.print("RELAY Y0: "); display.println(fanState ? "ACTIVE (ON)" : "IDLE (OFF)");
    display.display();
  }
}