#include <WiFi.h>
#include <ModbusIP_ESP8266.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>

const char* PRIMARY_SSID = "YOUR_WIFI_NAME";
const char* PRIMARY_PASS = "YOUR_WIFI_PASSWORD";
const char* BACKUP_SSID  = "YOUR_HOTSPOT_NAME";
const char* BACKUP_PASS  = "YOUR_HOTSPOT_PASS";

// --- PLC TERMINAL PINS ---
#define ONE_WIRE_BUS 4      // X0: DS18B20 Temp Probe
#define LDR_PIN 34          // AI0: Light Sensor
#define SOIL_PIN 35         // AI1: Soil Moisture Sensor
#define FAN_RELAY_PIN 26    // Y0: Relay Ch 1 (Cooling Fan)
#define PUMP_RELAY_PIN 33   // Y1: Relay Ch 2 (Water Pump / Mist)
#define ALARM_PIN 25        // Y2: High-Temp Alarm Buzzer/LED
#define SERVO_PIN 27        // Y3: Shade Net Servo

// --- MODBUS TCP REGISTERS ---
const int COIL_FAN = 0;       // 00001: Fan Relay
const int COIL_PUMP = 1;      // 00002: Water Pump Relay
const int COIL_ALARM = 2;     // 00003: Alarm Relay
const int HREG_SHADE = 0;     // 40001: Shade Net Angle (0-90)

const int IREG_TEMP = 0;      // 30001: Temp x10
const int IREG_LIGHT = 1;     // 30002: Light (Lux)
const int IREG_SOIL = 2;      // 30003: Soil Moisture (%)
const int IREG_HW_MASK = 3;   // 30004: Auto-Detected Hardware Bitmask
                              // Bit 0 (1): DS18B20 Temp
                              // Bit 1 (2): LDR Light
                              // Bit 2 (4): Soil Moisture
                              // Bit 3 (8): Relay Ch1 (Fan)
                              // Bit 4 (16): Relay Ch2 (Pump)
                              // Bit 5 (32): Shade Servo

ModbusIP mb;
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Servo shadeServo;

unsigned long lastScan = 0;

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
  pinMode(PUMP_RELAY_PIN, OUTPUT);
  pinMode(ALARM_PIN, OUTPUT);
  digitalWrite(FAN_RELAY_PIN, LOW);
  digitalWrite(PUMP_RELAY_PIN, LOW);
  digitalWrite(ALARM_PIN, LOW);

  shadeServo.attach(SERVO_PIN);
  shadeServo.write(0);
  sensors.begin();

  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 10);
  display.println("Auto-Detecting I/O...");
  display.display();

  connectNetwork();

  mb.server(502);
  mb.addCoil(COIL_FAN);
  mb.addCoil(COIL_PUMP);
  mb.addCoil(COIL_ALARM);
  mb.addHreg(HREG_SHADE, 0);
  mb.addIreg(IREG_TEMP, -999);
  mb.addIreg(IREG_LIGHT, -1);
  mb.addIreg(IREG_SOIL, -1);
  mb.addIreg(IREG_HW_MASK, 0);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectNetwork();
  mb.task();

  // Execute Physical Relays & Servo
  digitalWrite(FAN_RELAY_PIN, mb.Coil(COIL_FAN) ? HIGH : LOW);
  digitalWrite(PUMP_RELAY_PIN, mb.Coil(COIL_PUMP) ? HIGH : LOW);
  digitalWrite(ALARM_PIN, mb.Coil(COIL_ALARM) ? HIGH : LOW);
  shadeServo.write(constrain(mb.Hreg(HREG_SHADE), 0, 90));

  if (millis() - lastScan > 1500) {
    lastScan = millis();
    uint16_t mask = 0;

    // 1. Auto-Detect DS18B20 Temp Sensor
    sensors.requestTemperatures();
    float tempC = sensors.getTempCByIndex(0);
    if (tempC != DEVICE_DISCONNECTED_C && tempC > -50 && tempC < 120) {
      mask |= (1 << 0);
      mb.Ireg(IREG_TEMP, (int)(tempC * 10));
    } else {
      mb.Ireg(IREG_TEMP, -999);
    }

    // 2. Auto-Detect LDR Light Sensor
    int rawLight = analogRead(LDR_PIN);
    if (rawLight > 20 && rawLight < 4075) {
      mask |= (1 << 1);
      mb.Ireg(IREG_LIGHT, map(rawLight, 0, 4095, 0, 60000));
    } else {
      mb.Ireg(IREG_LIGHT, -1);
    }

    // 3. Auto-Detect Soil Moisture Sensor
    int rawSoil = analogRead(SOIL_PIN);
    if (rawSoil > 20 && rawSoil < 4075) {
      mask |= (1 << 2);
      int moisturePct = constrain(map(rawSoil, 3600, 1200, 0, 100), 0, 100);
      mb.Ireg(IREG_SOIL, moisturePct);
    } else {
      mb.Ireg(IREG_SOIL, -1);
    }

    // 4. Relay & Servo Channels Ready
    mask |= (1 << 3) | (1 << 4) | (1 << 5);
    mb.Ireg(IREG_HW_MASK, mask);
  }
}