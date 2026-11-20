import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
import joblib

# 1. Generate Agronomic Knowledge Dataset (Multi-Crop, Multi-Country, Growth-Stage)
# You can expand this CSV with Kaggle Greenhouse/Crop datasets
data = [
    # Crop, Country, Growth_Day, Ambient_Temp, Optimal_Temp_Max, Optimal_Light_Lux, Fan_Trigger_C, Shade_Trigger_Lux
    ["Vanilla", "Sri Lanka", 10, 31.0, 27.5, 15000, 28.0, 18000],
    ["Vanilla", "Sri Lanka", 45, 32.5, 28.5, 20000, 29.0, 22000],
    ["Vanilla", "Sri Lanka", 90, 30.0, 26.5, 18000, 27.0, 20000],
    ["Strawberry", "Japan", 15, 24.0, 22.0, 35000, 23.0, 40000],
    ["Strawberry", "Japan", 50, 26.0, 20.5, 45000, 21.5, 48000],
    ["Strawberry", "Sri Lanka", 30, 29.5, 21.0, 40000, 22.0, 42000],
    ["Saffron", "Iran", 20, 22.0, 19.0, 30000, 20.0, 35000],
    ["Saffron", "Sri Lanka", 40, 27.0, 18.5, 32000, 19.5, 35000],
    ["Bell Pepper", "Netherlands", 25, 23.0, 25.0, 50000, 26.5, 55000],
    ["Bell Pepper", "Sri Lanka", 60, 32.0, 25.5, 52000, 27.0, 56000],
    ["Orchid", "Thailand", 30, 33.0, 26.0, 22000, 27.0, 25000],
    ["Orchid", "Sri Lanka", 75, 31.5, 25.0, 20000, 26.0, 24000],
]

columns = [
    "Crop", "Country", "Growth_Day", "Ambient_Temp",
    "Optimal_Temp_Max", "Optimal_Light_Lux", "Fan_Trigger_C", "Shade_Trigger_Lux"
]
df = pd.DataFrame(data, columns=columns)

# Augment dataset with realistic daily microclimate variations (500+ samples for robust training)
np.random.seed(42)
augmented_rows = []
for _ in range(45):
    for row in data:
        day_shift = np.random.randint(-5, 6)
        temp_shift = np.random.uniform(-1.5, 1.5)
        new_day = max(1, row[2] + day_shift)
        new_amb = round(row[3] + temp_shift, 1)
        # Slight biological adaptation based on growth stage
        stage_factor = -0.01 * new_day if row[0] in ["Strawberry", "Saffron"] else 0.005 * new_day
        augmented_rows.append([
            row[0], row[1], new_day, new_amb,
            round(row[4] + stage_factor, 1),
            int(row[5] + np.random.randint(-1000, 1000)),
            round(row[6] + stage_factor, 1),
            int(row[7] + np.random.randint(-1000, 1000))
        ])

df_full = pd.concat([df, pd.DataFrame(augmented_rows, columns=columns)], ignore_index=True)
df_full.to_csv("agrivoice_crop_dataset.csv", index=False)

# 2. Build & Train Multi-Output Random Forest Pipeline
X = df_full[["Crop", "Country", "Growth_Day", "Ambient_Temp"]]
y = df_full[["Optimal_Temp_Max", "Optimal_Light_Lux", "Fan_Trigger_C", "Shade_Trigger_Lux"]]

preprocessor = ColumnTransformer(
    transformers=[
        ("cat", OneHotEncoder(handle_unknown="ignore"), ["Crop", "Country"]),
        ("num", "passthrough", ["Growth_Day", "Ambient_Temp"])
    ]
)

model = Pipeline(steps=[
    ("preprocessor", preprocessor),
    ("regressor", RandomForestRegressor(n_estimators=150, random_state=42))
])

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
model.fit(X_train, y_train)

print(f"Model R2 Accuracy Score: {model.score(X_test, y_test):.4f}")

# 3. Save Trained Model
joblib.dump(model, "agrivoice_ai_model.pkl")
print("Saved trained model as 'agrivoice_ai_model.pkl'")