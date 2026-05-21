'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// fetch-wod.js — HYROX WOD daily automation
// Runs via GitHub Actions every day at 04:50 Italy time (02:50 UTC)
// 1. Puppeteer logs into portal.hyrox365.com and captures the Bearer token
// 2. Queries the Hyrox GraphQL API for today's scheduled lesson
// 3. Generates index.html for the TV display
// ─────────────────────────────────────────────────────────────────────────────
