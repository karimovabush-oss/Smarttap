# SMART TAP

Digital business-card platform. Stable URL per business for NFC and QR.

## MVP
- Express API and PostgreSQL schema
- Admin page at /admin
- Public client page at /t/:slug
- QR generation at /api/clients/:slug/qr
- Health check at /api/health

## Environment variables
- PORT: hosting port
- DATABASE_URL: PostgreSQL connection string
- ADMIN_KEY: long random secret for admin access

Without DATABASE_URL, the service uses temporary in-memory demo storage. Do not store real customer data in demo mode.

## Windows local setup
Install Node.js 20+, then run npm install, set ADMIN_KEY and DATABASE_URL in PowerShell, and run npm start. Open http://localhost:3000/admin.

Important: the current Render free PostgreSQL instance expires after 30 days. Migrate to a persistent database and configure backups before real customer use. Never commit secrets to GitHub.
