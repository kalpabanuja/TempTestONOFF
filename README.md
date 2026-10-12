# ⚔️ Valheim Admin Panel

A sleek, Norse-themed web admin panel to control your Valheim server running inside a Docker container.

## Features
- 🔐 **Login page** with JWT session (8-hour token)
- 🟢 **Start / Stop / Restart** your Valheim Docker container
- 📜 **Live log streaming** (SSE) with pause, clear, and download
- ⚡ Status indicator auto-refreshes every 10 seconds

---

## Requirements

| Requirement | Notes |
|---|---|
| [Node.js ≥ 18](https://nodejs.org/) | Download & install first |
| Docker | Must be running & accessible via CLI |
| Valheim container | Must exist with a known name |

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org/ and install (LTS version recommended).
Restart your terminal after installation.

### 2. Configure your container name
Open `.env` and set `VALHEIM_CONTAINER` to match **your container name**:

```
# Find your container name with:
docker ps -a

# Then update .env:
VALHEIM_CONTAINER=valheim   <- change this
```

### 3. Change your password (important!)
Edit `.env` and set a strong password:
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YourStrongPassword
JWT_SECRET=SomeRandomLongSecretString
```

### 4. Install and run
```powershell
cd C:\Users\wickr\Downloads\TempTestONOFF
npm install
npm start
```

Then open your browser at: **http://localhost:3000**

---

## Project Structure
```
TempTestONOFF/
├── server.js          <- Express backend (API + SSE log stream)
├── .env               <- Config: credentials, container name, port
├── package.json
└── public/
    ├── index.html     <- SPA with login + dashboard views
    ├── style.css      <- Dark Norse theme
    └── app.js         <- Frontend logic (auth, logs, controls)
```

---

## API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | /api/login | No | Returns JWT token |
| GET | /api/status | Yes | Returns container status |
| POST | /api/server/start | Yes | Starts the container |
| POST | /api/server/stop | Yes | Stops the container |
| POST | /api/server/restart | Yes | Restarts the container |
| GET | /api/logs?token= | Yes | SSE stream of docker logs |

---

## Running in production (optional)

Install PM2 for auto-restart on crashes:
```powershell
npm install -g pm2
pm2 start server.js --name valheim-admin
pm2 save
pm2 startup
```
